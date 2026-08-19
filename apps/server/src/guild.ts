import { randomBytes } from "node:crypto";
import type { Ban, Invite, ModAction, ModLogEntry } from "@danjocord/protocol";
import type { Db } from "./db/index.js";
import { idFromString, idToString, nextId } from "./db/snowflake.js";

/**
 * Quem entra, quem sai e quem fez o quê (M10, roadmap §5).
 *
 * Fica fora do Store de propósito: o Store é "linhas ↔ entidades do protocolo"
 * para users/canais/mensagens/sons, e o que mora aqui é uma máquina de estados
 * de PERTENCIMENTO — allowlist, convites, bans e o log que amarra os três. As
 * três tabelas só fazem sentido juntas (resgatar um convite escreve nas três
 * na mesma transação), e separar isso do Store é o que deixa a atomicidade
 * visível num arquivo só.
 */

/**
 * Alfabeto do código de convite: sem `0`/`O`, `1`/`l`/`I` e `o`. O código é
 * ditado em voz alta e digitado à mão — cada par ambíguo aqui vira um "não
 * funciona" que na verdade era um O maiúsculo.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const CODE_LENGTH = 10;

/**
 * Amostragem por REJEIÇÃO e não `byte % 56`: o módulo cru daria peso maior aos
 * primeiros 32 símbolos do alfabeto (256 não é múltiplo de 56), e um código de
 * convite é credencial — viés é entropia perdida de graça. Descartar os bytes
 * acima do maior múltiplo custa ~12% de bytes a mais e nada de complexidade.
 */
function randomCode(): string {
  const n = CODE_ALPHABET.length;
  const limit = Math.floor(256 / n) * n;
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % n];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

interface InviteRow {
  code: string;
  created_by: bigint;
  created_at: bigint;
  expires_at: bigint | null;
  max_uses: bigint | null;
  uses: bigint;
  revoked_at: bigint | null;
}

interface BanRow {
  discord_id: string;
  banned_by: bigint | null;
  reason: string | null;
  created_at: bigint;
}

interface ModLogRow {
  id: bigint;
  actor_id: bigint | null;
  action: ModAction;
  target_user_id: bigint | null;
  target_discord_id: string | null;
  detail: string | null;
  created_at: bigint;
}

/**
 * Por que um convite não vale. São valores distintos (e não um booleano) porque
 * a landing e o log de moderação querem dizer coisas diferentes para "esse
 * código não existe" e "esse código já foi usado o bastante".
 */
export type InviteProblem = "unknown" | "revoked" | "expired" | "exhausted" | "banned";

export type RedeemResult = { ok: true; invite: Invite } | { ok: false; problem: InviteProblem };

/** O que a rota de moderação passa para registrar uma ação no log. */
export interface ModLogInput {
  /** null = o próprio sistema (bootstrap do dono) */
  actorId: string | null;
  action: ModAction;
  targetUserId?: string | null;
  targetDiscordId?: string | null;
  detail?: string | null;
}

export class Guild {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------------
  // Allowlist
  // -------------------------------------------------------------------------

  isAllowed(discordId: string): boolean {
    return this.db.prepare("SELECT 1 FROM allowlist WHERE discord_id = ?").get(discordId) !== undefined;
  }

  allowlistCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM allowlist").get() as { n: bigint };
    return Number(row.n);
  }

  addToAllowlist(discordId: string, invitedBy: string | null): boolean {
    const res = this.db
      .prepare("INSERT INTO allowlist (discord_id, invited_by, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(discordId, invitedBy, Date.now());
    return res.changes > 0;
  }

  /** Kick (item 49): sai da allowlist e pode voltar por convite. Ban é outra coisa. */
  removeFromAllowlist(discordId: string): boolean {
    return this.db.prepare("DELETE FROM allowlist WHERE discord_id = ?").run(discordId).changes > 0;
  }

  /**
   * Revoga TODA sessão viva do usuário. Sem isto o refresh rotativo manteria o
   * acesso para sempre — a allowlist só é consultada no login. Não fecha
   * WebSocket nenhum: isso é papel do gateway (roadmap 114), e é justamente o
   * outro lado do furo.
   */
  revokeSessionsOfDiscordId(discordId: string): number {
    return this.db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL " +
          "AND user_id = (SELECT id FROM users WHERE discord_id = ?)",
      )
      .run(Date.now(), discordId).changes;
  }

  // -------------------------------------------------------------------------
  // Bans (item 50)
  // -------------------------------------------------------------------------

  isBanned(discordId: string): boolean {
    return this.db.prepare("SELECT 1 FROM bans WHERE discord_id = ?").get(discordId) !== undefined;
  }

  ban(discordId: string, bannedBy: string | null, reason: string | null): void {
    // ON CONFLICT DO NOTHING: rebanir quem já está banido é no-op, não erro —
    // o botão da UI pode ser apertado duas vezes e o resultado é o mesmo
    this.db
      .prepare("INSERT INTO bans (discord_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(discordId, bannedBy === null ? null : idFromString(bannedBy), reason, Date.now());
  }

  unban(discordId: string): boolean {
    return this.db.prepare("DELETE FROM bans WHERE discord_id = ?").run(discordId).changes > 0;
  }

  listBans(): Ban[] {
    const rows = this.db.prepare("SELECT * FROM bans ORDER BY created_at DESC").all() as BanRow[];
    return rows.map((r) => ({
      discord_id: r.discord_id,
      banned_by: r.banned_by === null ? null : idToString(r.banned_by),
      reason: r.reason,
      created_at: Number(r.created_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Convites (itens 43–45)
  // -------------------------------------------------------------------------

  createInvite(createdBy: string, opts: { expiresInS?: number; maxUses?: number }): Invite {
    const now = Date.now();
    const code = randomCode();
    const expiresAt = opts.expiresInS === undefined ? null : now + opts.expiresInS * 1000;
    const maxUses = opts.maxUses ?? null;
    this.db
      .prepare(
        "INSERT INTO invites (code, created_by, created_at, expires_at, max_uses, uses, revoked_at)" +
          " VALUES (?, ?, ?, ?, ?, 0, NULL)",
      )
      .run(code, idFromString(createdBy), now, expiresAt, maxUses);
    return {
      code,
      created_by: createdBy,
      created_at: now,
      expires_at: expiresAt,
      max_uses: maxUses,
      uses: 0,
      revoked_at: null,
    };
  }

  listInvites(): Invite[] {
    const rows = this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as InviteRow[];
    return rows.map((r) => inviteToWire(r));
  }

  getInvite(code: string): Invite | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow | undefined;
    return row ? inviteToWire(row) : null;
  }

  revokeInvite(code: string): boolean {
    // só revoga o que ainda está vivo: revogar de novo não deve mudar a data
    return this.db.prepare("UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL")
      .run(Date.now(), code).changes > 0;
  }

  /** Por que este convite não serve, ou null se serve. Leitura pura, sem escrever. */
  inviteProblem(code: string, now: number = Date.now()): InviteProblem | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow | undefined;
    if (row === undefined) return "unknown";
    if (row.revoked_at !== null) return "revoked";
    if (row.expires_at !== null && Number(row.expires_at) <= now) return "expired";
    if (row.max_uses !== null && row.uses >= row.max_uses) return "exhausted";
    return null;
  }

  /**
   * Resgatar um convite: valida, incrementa `uses`, entra na allowlist e loga —
   * TUDO na mesma transação (better-sqlite3 é síncrono, então `db.transaction`
   * de fato serializa isto contra qualquer outra escrita do processo).
   *
   * Por que a atomicidade importa aqui e não em outros lugares do repo: dois
   * logins simultâneos no ÚLTIMO uso de um convite fariam, sem transação,
   * "checa (0 < 1) / checa (0 < 1) / incrementa / incrementa" — duas pessoas
   * entrando com um convite de uso único. É a corrida clássica de resgate.
   *
   * O UPDATE também repete a condição no WHERE (não confia só na leitura de
   * cima): se o número de linhas afetadas vier 0, alguém correu por dentro e o
   * resgate falha em vez de entrar torto.
   */
  redeemInvite(code: string, discordId: string, now: number = Date.now()): RedeemResult {
    return this.db.transaction((): RedeemResult => {
      // BAN NA FRENTE DE TUDO, sempre: um convite válido não desfaz um ban.
      // Esta ordem é o contrato do M10 e o teste que a fixa existe.
      if (this.isBanned(discordId)) return { ok: false, problem: "banned" };

      const problem = this.inviteProblem(code, now);
      if (problem !== null) return { ok: false, problem };

      const updated = this.db
        .prepare(
          "UPDATE invites SET uses = uses + 1 WHERE code = ? AND revoked_at IS NULL" +
            " AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)",
        )
        .run(code, now);
      if (updated.changes === 0) return { ok: false, problem: "exhausted" };

      const row = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow;
      // invited_by guarda o discord_id de QUEM CRIOU o convite (é o formato da
      // coluna desde o M1: id do Discord, não o nosso) — null se o criador
      // sumiu do banco, o que não pode travar a entrada de quem tem link bom
      const inviter = this.db.prepare("SELECT discord_id FROM users WHERE id = ?").get(row.created_by) as
        | { discord_id: string | null }
        | undefined;
      this.addToAllowlist(discordId, inviter?.discord_id ?? null);
      this.log({
        actorId: idToString(row.created_by),
        action: "invite_use",
        targetDiscordId: discordId,
        detail: `convite ${code}`,
      });
      return { ok: true, invite: inviteToWire(row) };
    })();
  }

  // -------------------------------------------------------------------------
  // Log de moderação (item 57)
  // -------------------------------------------------------------------------

  /**
   * Toda ação de moderação passa por aqui. É append-only e sem rota de apagar
   * de propósito: um log que o moderador limpa não responde à pergunta que o
   * log existe para responder.
   */
  log(input: ModLogInput): ModLogEntry {
    const id = nextId();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO mod_log (id, actor_id, action, target_user_id, target_discord_id, detail, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.actorId == null ? null : idFromString(input.actorId),
        input.action,
        input.targetUserId == null ? null : idFromString(input.targetUserId),
        input.targetDiscordId ?? null,
        input.detail ?? null,
        createdAt,
      );
    return {
      id: idToString(id),
      actor_id: input.actorId ?? null,
      action: input.action,
      target_user_id: input.targetUserId ?? null,
      target_discord_id: input.targetDiscordId ?? null,
      detail: input.detail ?? null,
      created_at: createdAt,
    };
  }

  listModLog(limit = 100): ModLogEntry[] {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const rows = this.db
      .prepare("SELECT * FROM mod_log ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(capped) as ModLogRow[];
    return rows.map((r) => ({
      id: idToString(r.id),
      actor_id: r.actor_id === null ? null : idToString(r.actor_id),
      action: r.action,
      target_user_id: r.target_user_id === null ? null : idToString(r.target_user_id),
      target_discord_id: r.target_discord_id,
      detail: r.detail,
      created_at: Number(r.created_at),
    }));
  }
}

function inviteToWire(r: InviteRow): Invite {
  return {
    code: r.code,
    created_by: idToString(r.created_by),
    created_at: Number(r.created_at),
    expires_at: r.expires_at === null ? null : Number(r.expires_at),
    max_uses: r.max_uses === null ? null : Number(r.max_uses),
    uses: Number(r.uses),
    revoked_at: r.revoked_at === null ? null : Number(r.revoked_at),
  };
}

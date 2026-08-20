import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { User } from "@danjocord/protocol";
import { config } from "./config.js";
import type { Db } from "./db/index.js";
import { idFromString, idToString, nextId } from "./db/snowflake.js";
import type { Store } from "./store.js";

/**
 * Sessões próprias (doc §5): JWT de acesso curto + refresh token opaco com
 * rotação. O JWT mantém a verificação síncrona e stateless no gateway/REST;
 * o refresh é a única credencial de longa duração e vive na tabela
 * `sessions` — e só o sha256 dele toca o disco (um dump do banco não vira
 * sessão válida).
 *
 * Detecção de reuso — por que a família INTEIRA morre: um refresh já
 * rotacionado que aparece de novo significa que existem duas cópias do token
 * em circulação (a do dono e a de um ladrão), e é impossível saber qual das
 * duas acabou de chegar. A única resposta segura é revogar todas as gerações
 * encadeadas pelo mesmo family_id e forçar os dois lados a relogar.
 */

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: User;
}

interface SessionRow {
  id: bigint;
  user_id: bigint;
  token_hash: string;
  family_id: string;
  revoked_at: bigint | null;
  created_at: bigint;
  expires_at: bigint;
  last_seen_at: bigint | null;
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Sessions {
  /**
   * One-time codes do redirect OAuth, em memória de propósito (doc §5): valem
   * config.otcTtlMs e um restart no meio do fluxo só custa repetir o login.
   */
  private readonly otcs = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly store: Store,
  ) {}

  issueOtc(userId: string): string {
    const now = Date.now();
    // varre expirados na emissão — o mapa não cresce sem limite entre logins
    for (const [code, entry] of this.otcs) {
      if (entry.expiresAt <= now) this.otcs.delete(code);
    }
    const otc = randomBytes(32).toString("base64url");
    this.otcs.set(otc, { userId, expiresAt: now + config.otcTtlMs });
    return otc;
  }

  consumeOtc(otc: string): string | null {
    const entry = this.otcs.get(otc);
    if (!entry) return null;
    // uso único: sai do mapa antes mesmo de checar a validade
    this.otcs.delete(otc);
    return entry.expiresAt > Date.now() ? entry.userId : null;
  }

  /** Login novo: abre uma família de refresh nova para este dispositivo. */
  create(userId: string): TokenPair {
    return this.issue(userId, randomUUID());
  }

  rotate(refreshToken: string): TokenPair | "reused" | null {
    // transação: achar → revogar → reemitir precisa ser atômico, senão duas
    // rotações concorrentes do mesmo token emitiriam duas gerações válidas
    return this.db.transaction((): TokenPair | "reused" | null => {
      const now = Date.now();
      const row = this.getByHash(sha256(refreshToken));
      if (!row) return null;
      if (row.revoked_at !== null) {
        // reuso detectado (ver comentário no topo) — checado ANTES da
        // expiração: um token roubado é evidência de roubo mesmo velho
        this.revokeFamily(row.family_id, now);
        return "reused";
      }
      if (Number(row.expires_at) <= now) return null; // expirado nunca rotaciona
      // Kick e ban (doc §5): quem não pertence mais à guild não renova — o
      // acesso restante morre com o access token corrente (≤ TTL do JWT).
      //
      // M10: a pergunta passou a ser `store.isMember`, e não mais a allowlist
      // crua. É a MESMA pergunta que o heartbeat e o Identify do gateway
      // refazem, num lugar só: banido perde aqui mesmo que alguém o tenha
      // readicionado à allowlist pelo CLI sem saber do ban. Usuário dev
      // (discord_id NULL) continua fora do fluxo e sempre passa.
      if (!this.store.isMember(idToString(row.user_id))) {
        this.revokeFamily(row.family_id, now);
        return null;
      }
      this.db
        .prepare("UPDATE sessions SET revoked_at = ?, last_seen_at = ? WHERE id = ?")
        .run(now, now, row.id);
      // mesma family_id: é isso que encadeia as gerações para a detecção de
      // reuso; o TTL é deslizante — issue() recalcula expires_at a partir de
      // agora, então quem usa o app nunca cai por expiração de refresh
      return this.issue(idToString(row.user_id), row.family_id);
    })();
  }

  /** Logout: revoga a família inteira (todas as gerações deste dispositivo). */
  revokeByRefresh(refreshToken: string): boolean {
    const row = this.getByHash(sha256(refreshToken));
    if (!row) return false;
    this.revokeFamily(row.family_id, Date.now());
    return true;
  }

  // -------------------------------------------------------------------------

  private issue(userId: string, familyId: string): TokenPair {
    const user = this.store.getUserById(idFromString(userId));
    if (!user) throw new Error(`sessions: usuário ${userId} não existe`);
    const accessToken = jwt.sign({}, config.jwtSecret, {
      algorithm: "HS256",
      subject: userId,
      issuer: "danjocord",
      audience: "danjocord",
      expiresIn: config.accessTokenTtlSec,
    });
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, family_id, revoked_at, created_at, expires_at, last_seen_at) " +
          "VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(nextId(), idFromString(userId), sha256(refreshToken), familyId, now, now + config.refreshTokenTtlMs, now);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: config.accessTokenTtlSec,
      user,
    };
  }

  /**
   * Apaga sessões velhas demais para servirem a qualquer coisa (roadmap 119).
   *
   * A tabela nunca era limpa: cada rotação de refresh grava uma linha nova e
   * marca a anterior como revogada, e uma sessão ativa rotaciona a cada ~15 min
   * (o TTL do access). Nada apagava nada, nunca.
   *
   * O critério NÃO é "expirou", e a razão está no `rotate`: o check de revogado
   * vem ANTES do de expiração de propósito, porque "um token roubado é
   * evidência de roubo mesmo velho" — apagar no vencimento destruiria
   * exatamente o sinal que a detecção de reuso existe para captar.
   *
   * Então a retenção é o TTL do refresh DE NOVO depois do vencimento: um token
   * apresentado dentro de ~60 dias ainda derruba a família inteira, e o que
   * passa disso deixa de ocupar espaço. É a troca entre "guardar prova" e
   * "crescer para sempre", com o lado da prova generoso.
   */
  purgeOld(now: number = Date.now()): number {
    const corte = now - config.refreshTokenTtlMs;
    return this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(corte).changes;
  }

  private getByHash(tokenHash: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
  }

  private revokeFamily(familyId: string, now: number): void {
    this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .run(now, familyId);
  }
}

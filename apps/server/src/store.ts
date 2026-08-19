import type { Channel, Message, Role, Sound, User } from "@danjocord/protocol";
import type { Db } from "./db/index.js";
import { idFromString, idToString, nextId } from "./db/snowflake.js";

/**
 * Camada de dados fininha: linhas do SQLite ↔ entidades do protocolo.
 * BigInt vem do driver (defaultSafeIntegers); no fio, id vira string.
 */

interface UserRow {
  id: bigint;
  discord_id: string | null;
  username: string;
  avatar_url: string | null;
  /** M10: cargo (migration 004) — substituiu o booleano is_admin do M2 */
  role: Role;
  /** M10 (item 55): identidade da guild — o upsert do OAuth NUNCA toca nestas duas */
  nickname: string | null;
  avatar_override: string | null;
  /** M10 (item 53): timeout de chat em epoch ms; null = livre */
  muted_until: bigint | null;
  created_at: bigint;
}

interface ChannelRow {
  id: bigint;
  type: "text" | "voice";
  name: string;
  position: bigint;
}

interface MessageRow {
  id: bigint;
  channel_id: bigint;
  author_id: bigint;
  content: string;
  created_at: bigint;
  edited_at: bigint | null;
  deleted_at: bigint | null;
}

/** M9: linha da tabela `sounds` — `bytes` só é lido na rota de áudio */
interface SoundRow {
  id: bigint;
  name: string;
  uploader_id: bigint | null;
  mime: string;
  size_bytes: bigint;
  duration_ms: bigint;
  gain: number;
  created_at: bigint;
}

/** Tudo que a rota de upload já mediu e validou — o Store só grava. */
export interface NewSound {
  name: string;
  /** null = som embutido (seed do boot) */
  uploaderId: string | null;
  mime: Sound["mime"];
  bytes: Buffer;
  durationMs: number;
  gain: number;
}

export class Store {
  /**
   * Chamado quando um usuário NOVO é de fato inserido (dev ou OAuth) — nunca
   * em re-login de usuário conhecido. O integrador liga isto ao broadcast de
   * MEMBER_ADD; fica como campo (e não import do gateway) para o Store não
   * depender da camada de cima.
   */
  onUserCreated?: (user: User) => void;

  constructor(private readonly db: Db) {}

  /**
   * Linha → entidade do fio. O `avatar_url` sai RESOLVIDO (override da guild na
   * frente do que veio do Discord) porque só existe um lugar na UI que mostra
   * avatar; o `nickname` viaja cru ao lado do `username` porque a UI quer os
   * dois (apelido na lista, nome do Discord no card do membro) — quem resolve
   * o nome exibido é o `displayName()` do protocolo, num lugar só.
   */
  userToWire(row: UserRow): User {
    return {
      id: idToString(row.id),
      username: row.username,
      nickname: row.nickname,
      avatar_url: row.avatar_override ?? row.avatar_url,
      role: row.role,
      // resolvido aqui: timeout vencido vira null no fio, e nenhum cliente
      // precisa comparar relógio com o servidor para saber se ainda vale
      muted_until:
        row.muted_until !== null && Number(row.muted_until) > Date.now() ? Number(row.muted_until) : null,
    };
  }

  getUserById(id: bigint): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? this.userToWire(row) : null;
  }

  /** Auth dev (M0): encontra ou cria um usuário pelo username. Sai no M1 (OAuth). */
  findOrCreateDevUser(username: string): User {
    const existing = this.db.prepare("SELECT * FROM users WHERE username = ? AND discord_id IS NULL").get(username) as
      | UserRow
      | undefined;
    if (existing) return this.userToWire(existing);
    const id = nextId();
    this.db
      .prepare("INSERT INTO users (id, discord_id, username, avatar_url, created_at) VALUES (?, NULL, ?, NULL, ?)")
      .run(id, username, Date.now());
    // relê em vez de montar o objeto na mão: os defaults do esquema (role)
    // saem de UM lugar só — senão, no dia em que um default mudar, o fio mente
    const user = this.getUserById(id);
    if (!user) throw new Error("store: usuário dev recém-criado sumiu");
    this.onUserCreated?.(user);
    return user;
  }

  /**
   * Upsert por discord_id (movido de oauth.ts no M2): re-login atualiza
   * nome/avatar, mas o NOSSO id é estável — mensagens antigas continuam
   * apontando para o mesmo autor. SELECT+INSERT sem transação é seguro aqui:
   * better-sqlite3 é síncrono e só este processo cria usuários.
   */
  upsertDiscordUser(discordId: string, username: string, avatarUrl: string | null): { user: User; created: boolean } {
    const existing = this.db.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId) as
      | UserRow
      | undefined;
    if (existing) {
      // ATENÇÃO (M10, item 55): este UPDATE roda a CADA login. `nickname`,
      // `avatar_override` e `role` estão fora dele DE PROPÓSITO — se o apelido
      // morasse em `username`, o próximo login do Discord o apagaria sem que
      // ninguém percebesse. Não acrescente coluna da guild a esta linha.
      this.db.prepare("UPDATE users SET username = ?, avatar_url = ? WHERE id = ?").run(username, avatarUrl, existing.id);
      return { user: this.userToWire({ ...existing, username, avatar_url: avatarUrl }), created: false };
    }
    const id = nextId();
    this.db
      .prepare("INSERT INTO users (id, discord_id, username, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, discordId, username, avatarUrl, Date.now());
    const user = this.getUserById(id);
    if (!user) throw new Error("store: usuário recém-criado sumiu");
    this.onUserCreated?.(user);
    return { user, created: true };
  }

  /** Cargo de um usuário; null = não existe. Fonte única de permissão (M10). */
  getRole(userId: string): Role | null {
    const row = this.db.prepare("SELECT role FROM users WHERE id = ?").get(idFromString(userId)) as
      | { role: Role }
      | undefined;
    return row?.role ?? null;
  }

  /** admin OU owner. Mantém o nome do M2 — é o que voice.ts e as rotas chamam. */
  isAdmin(userId: string): boolean {
    const role = this.getRole(userId);
    return role === "admin" || role === "owner";
  }

  /**
   * Membros da guild AGORA (M10, item 52). Até o M9 isto devolvia TODOS os
   * users da tabela — inclusive quem já tinha sido expulso, que seguia na lista
   * de todo mundo para sempre. A linha em `users` não some (mensagens antigas
   * apontam para ela); quem decide pertencimento é a allowlist.
   *
   * Usuário de desenvolvimento (discord_id NULL) não passa por allowlist e
   * entra sempre — em produção ele não existe (devAuth desligado).
   */
  listMembers(): User[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM users WHERE discord_id IS NULL" +
          " OR discord_id IN (SELECT discord_id FROM allowlist) ORDER BY username",
      )
      .all() as UserRow[];
    return rows.map((r) => this.userToWire(r));
  }

  /**
   * O usuário ainda pertence à guild? É a pergunta que o gateway refaz a cada
   * heartbeat (roadmap 114) — por isso são queries diretas, sem join caro.
   * Banido perde na hora mesmo que a allowlist ainda não tenha sido limpa:
   * ban tem prioridade sobre tudo, sempre.
   */
  isMember(userId: string): boolean {
    const row = this.db.prepare("SELECT discord_id FROM users WHERE id = ?").get(idFromString(userId)) as
      | { discord_id: string | null }
      | undefined;
    if (row === undefined) return false;
    if (row.discord_id === null) return true; // usuário dev: fora do fluxo de allowlist
    if (this.db.prepare("SELECT 1 FROM bans WHERE discord_id = ?").get(row.discord_id) !== undefined) return false;
    return this.db.prepare("SELECT 1 FROM allowlist WHERE discord_id = ?").get(row.discord_id) !== undefined;
  }

  /** discord_id do usuário (null = usuário dev, ou id desconhecido). */
  discordIdOf(userId: string): string | null {
    const row = this.db.prepare("SELECT discord_id FROM users WHERE id = ?").get(idFromString(userId)) as
      | { discord_id: string | null }
      | undefined;
    return row?.discord_id ?? null;
  }

  getUserByDiscordId(discordId: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId) as UserRow | undefined;
    return row ? this.userToWire(row) : null;
  }

  /** Existe algum owner? Guarda a invariante "a guild nunca fica sem dono". */
  hasOwner(): boolean {
    return this.db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get() !== undefined;
  }

  /** Troca o cargo. QUEM pode trocar é decisão das rotas (moderation.ts). */
  setRole(userId: string, role: Role): User | null {
    this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, idFromString(userId));
    return this.getUserById(idFromString(userId));
  }

  /**
   * Identidade da guild (item 55). `undefined` = não mexe; `null` = limpa e
   * volta ao que veio do Discord — os dois casos PRECISAM ser distinguíveis,
   * senão não existe como remover um apelido depois de pôr um.
   */
  updateGuildIdentity(
    userId: string,
    patch: { nickname?: string | null; avatarOverride?: string | null },
  ): User | null {
    const id = idFromString(userId);
    if (patch.nickname !== undefined) {
      this.db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(patch.nickname, id);
    }
    if (patch.avatarOverride !== undefined) {
      this.db.prepare("UPDATE users SET avatar_override = ? WHERE id = ?").run(patch.avatarOverride, id);
    }
    return this.getUserById(id);
  }

  /**
   * Timeout de chat (item 53). Ao contrário dos flags de voz, vai ao BANCO: um
   * silêncio de 24 h que evapora no deploy da noite não é punição nenhuma.
   * `until = null` libera.
   */
  setMutedUntil(userId: string, until: number | null): void {
    this.db.prepare("UPDATE users SET muted_until = ? WHERE id = ?").run(until, idFromString(userId));
  }

  /** Quando o silêncio acaba (epoch ms), ou null se não há timeout ATIVO. */
  mutedUntil(userId: string, now: number = Date.now()): number | null {
    const row = this.db.prepare("SELECT muted_until FROM users WHERE id = ?").get(idFromString(userId)) as
      | { muted_until: bigint | null }
      | undefined;
    if (row?.muted_until == null) return null;
    const until = Number(row.muted_until);
    // expira SOZINHO: não existe job de limpeza — é a leitura que decide, então
    // um timeout vencido durante um restart simplesmente deixa de valer
    return until > now ? until : null;
  }

  listChannels(): Channel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY position, id").all() as ChannelRow[];
    return rows.map((r) => ({ id: idToString(r.id), type: r.type, name: r.name, position: Number(r.position) }));
  }

  channelExists(channelId: string, type?: "text" | "voice"): boolean {
    const row = this.db.prepare("SELECT type FROM channels WHERE id = ?").get(idFromString(channelId)) as
      | { type: string }
      | undefined;
    if (!row) return false;
    return type === undefined || row.type === type;
  }

  createMessage(channelId: string, authorId: string, content: string): Message {
    const id = nextId();
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, idFromString(channelId), idFromString(authorId), content, createdAt);
    return {
      id: idToString(id),
      channel_id: channelId,
      author_id: authorId,
      content,
      created_at: createdAt,
    };
  }

  /** Paginação por cursor (doc §6): WHERE id < :before ORDER BY id DESC. */
  listMessages(channelId: string, before: string | null, limit: number): Message[] {
    const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100); // trunc: fracionario viraria REAL no LIMIT (SQLITE_MISMATCH)
    const rows = (
      before === null
        ? this.db
            .prepare(
              "SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?",
            )
            .all(idFromString(channelId), cappedLimit)
        : this.db
            .prepare(
              "SELECT * FROM messages WHERE channel_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?",
            )
            .all(idFromString(channelId), idFromString(before), cappedLimit)
    ) as MessageRow[];
    return rows.map((r) => this.messageToWire(r));
  }

  /**
   * Busca defensiva para PATCH/DELETE: o channel_id do path entra no WHERE de
   * propósito — mensagem de outro canal (ou apagada) responde 404, não vaza.
   */
  getMessage(channelId: string, messageId: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL")
      .get(idFromString(messageId), idFromString(channelId)) as MessageRow | undefined;
    return row ? this.messageToWire(row) : null;
  }

  /** Autor/canal são checados nas rotas; o deleted_at fica também aqui por defesa. */
  updateMessage(messageId: string, content: string): Message {
    this.db
      .prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(content, Date.now(), idFromString(messageId));
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(idFromString(messageId)) as MessageRow;
    return this.messageToWire(row);
  }

  /** Soft delete (doc §6): a linha fica, listagens e getMessage filtram por deleted_at. */
  softDeleteMessage(messageId: string): void {
    this.db
      .prepare("UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(Date.now(), idFromString(messageId));
  }

  // ---------------------------------------------------------------------------
  // Soundboard (M9). Os BYTES ficam no banco (BLOB) e não em disco: o pod tem um
  // PVC só, e backup/restore continuam sendo um arquivo. Toda leitura de lista
  // omite a coluna `bytes` de propósito — 100 sons × 512 KB não podem viajar
  // junto de um READY.
  // ---------------------------------------------------------------------------

  /** Catálogo completo (metadados). Embutidos primeiro, uploads na ordem de chegada. */
  listSounds(): Sound[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, uploader_id, mime, size_bytes, duration_ms, gain, created_at FROM sounds ORDER BY created_at, id",
      )
      .all() as SoundRow[];
    return rows.map((r) => soundToWire(r));
  }

  /** Teto de 100 sons da guild — checado ANTES de bufferizar qualquer upload. */
  countSounds(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sounds").get() as { n: bigint };
    return Number(row.n);
  }

  getSound(soundId: string): Sound | null {
    const row = this.db
      .prepare(
        "SELECT id, name, uploader_id, mime, size_bytes, duration_ms, gain, created_at FROM sounds WHERE id = ?",
      )
      .get(idFromString(soundId)) as SoundRow | undefined;
    return row ? soundToWire(row) : null;
  }

  /**
   * Bytes + mime GUARDADO (nunca o do request): é este mime que a rota de áudio
   * devolve. Servir um content-type escolhido por quem sobe o arquivo, na mesma
   * origem do app, seria XSS de graça.
   */
  getSoundAudio(soundId: string): { mime: Sound["mime"]; bytes: Buffer } | null {
    const row = this.db.prepare("SELECT mime, bytes FROM sounds WHERE id = ?").get(idFromString(soundId)) as
      | { mime: string; bytes: Buffer }
      | undefined;
    if (!row) return null;
    return { mime: row.mime as Sound["mime"], bytes: row.bytes };
  }

  createSound(input: NewSound): Sound {
    const id = nextId();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO sounds (id, name, uploader_id, mime, bytes, size_bytes, duration_ms, gain, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.uploaderId === null ? null : idFromString(input.uploaderId),
        input.mime,
        input.bytes,
        input.bytes.length,
        Math.round(input.durationMs),
        input.gain,
        createdAt,
      );
    return {
      id: idToString(id),
      name: input.name,
      uploader_id: input.uploaderId,
      mime: input.mime,
      size_bytes: input.bytes.length,
      duration_ms: Math.round(input.durationMs),
      gain: input.gain,
      created_at: createdAt,
    };
  }

  /** Só o nome muda: o áudio é imutável (o id é o cache key do GET, doc do M9). */
  renameSound(soundId: string, name: string): Sound | null {
    this.db.prepare("UPDATE sounds SET name = ? WHERE id = ?").run(name, idFromString(soundId));
    return this.getSound(soundId);
  }

  /**
   * Delete de verdade, sem soft delete: a linha carrega o BLOB, e manter meio
   * mega de áudio "apagado" no PVC para sempre é o oposto do que o teto de 100
   * sons quer garantir.
   */
  deleteSound(soundId: string): boolean {
    const info = this.db.prepare("DELETE FROM sounds WHERE id = ?").run(idFromString(soundId));
    return info.changes > 0;
  }

  private messageToWire(r: MessageRow): Message {
    return {
      id: idToString(r.id),
      channel_id: idToString(r.channel_id),
      author_id: idToString(r.author_id),
      content: r.content,
      created_at: Number(r.created_at),
      edited_at: r.edited_at === null ? null : Number(r.edited_at),
    };
  }
}

/**
 * Linha → entidade do fio. O `mime` sai do banco, onde a migration tem CHECK
 * com os três valores — o cast declara o que o esquema já garante.
 */
function soundToWire(r: SoundRow): Sound {
  return {
    id: idToString(r.id),
    name: r.name,
    uploader_id: r.uploader_id === null ? null : idToString(r.uploader_id),
    mime: r.mime as Sound["mime"],
    size_bytes: Number(r.size_bytes),
    duration_ms: Number(r.duration_ms),
    gain: r.gain,
    created_at: Number(r.created_at),
  };
}


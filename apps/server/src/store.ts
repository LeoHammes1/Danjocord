import type { Channel, Message, User } from "@danjocord/protocol";
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
  is_admin: bigint;
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

export class Store {
  /**
   * Chamado quando um usuário NOVO é de fato inserido (dev ou OAuth) — nunca
   * em re-login de usuário conhecido. O integrador liga isto ao broadcast de
   * MEMBER_ADD; fica como campo (e não import do gateway) para o Store não
   * depender da camada de cima.
   */
  onUserCreated?: (user: User) => void;

  constructor(private readonly db: Db) {}

  userToWire(row: UserRow): User {
    const user: User = { id: idToString(row.id), username: row.username, avatar_url: row.avatar_url };
    // omitido quando 0: ausente = false no fio, e o caso comum não carrega o campo
    if (row.is_admin !== 0n) user.is_admin = true;
    return user;
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
    const user: User = { id: idToString(id), username, avatar_url: null };
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
      this.db.prepare("UPDATE users SET username = ?, avatar_url = ? WHERE id = ?").run(username, avatarUrl, existing.id);
      return { user: this.userToWire({ ...existing, username, avatar_url: avatarUrl }), created: false };
    }
    const id = nextId();
    this.db
      .prepare("INSERT INTO users (id, discord_id, username, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, discordId, username, avatarUrl, Date.now());
    const user: User = { id: idToString(id), username, avatar_url: avatarUrl };
    this.onUserCreated?.(user);
    return { user, created: true };
  }

  isAdmin(userId: string): boolean {
    const row = this.db.prepare("SELECT is_admin FROM users WHERE id = ?").get(idFromString(userId)) as
      | { is_admin: bigint }
      | undefined;
    return row !== undefined && row.is_admin !== 0n;
  }

  listMembers(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY username").all() as UserRow[];
    return rows.map((r) => this.userToWire(r));
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


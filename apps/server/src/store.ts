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
}

export class Store {
  constructor(private readonly db: Db) {}

  userToWire(row: UserRow): User {
    return { id: idToString(row.id), username: row.username, avatar_url: row.avatar_url };
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
    return { id: idToString(id), username, avatar_url: null };
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
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
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
    return rows.map((r) => ({
      id: idToString(r.id),
      channel_id: idToString(r.channel_id),
      author_id: idToString(r.author_id),
      content: r.content,
      created_at: Number(r.created_at),
    }));
  }
}

import type { Channel, Message, Sound, User } from "@danjocord/protocol";
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


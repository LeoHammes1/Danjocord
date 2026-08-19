import {
  SEARCH_HIT_CLOSE,
  SEARCH_HIT_OPEN,
  type Attachment,
  type Channel,
  type ChannelReadState,
  type LinkPreview,
  type Message,
  type MessageReaction,
  type MessageReference,
  type MessageType,
  type Role,
  type SearchHit,
  type Sound,
  type User,
} from "@danjocord/protocol";
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
  /** M11a: 'user' | 'member_join' | 'member_leave' (CHECK na migration 005) */
  type: MessageType;
  /** M11a: 0/1 — o SQLite não tem boolean */
  mentions_everyone: bigint;
  /** M11b (item 86): mensagem citada; null = não é reply */
  reply_to_id: bigint | null;
}

/** M11b: linha de `attachments` sem o BLOB (que só a rota de bytes lê). */
interface AttachmentRow {
  id: bigint;
  message_id: bigint | null;
  uploader_id: bigint;
  filename: string;
  mime: string;
  size_bytes: bigint;
  width: bigint | null;
  height: bigint | null;
  created_at: bigint;
}

/** Tudo que a rota de upload já mediu e validou — o Store só grava (M11b). */
export interface NewAttachment {
  uploaderId: string;
  filename: string;
  mime: Attachment["mime"];
  bytes: Buffer;
  /** LIDAS do cabeçalho pelo servidor; null = formato válido sem dimensão legível */
  width: number | null;
  height: number | null;
}

/**
 * Resultado de `addReaction` (M11b, item 87). É uma união e não um booleano
 * porque a rota precisa distinguir três respostas HTTP diferentes — e porque
 * "já existia" NÃO é erro: reagir duas vezes com o mesmo emoji é idempotente,
 * o cliente pode ter mandado duas vezes por causa de um clique duplo.
 */
export type AddReactionResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "too_many_emojis" | "too_many_by_user" };

/** Tetos das reações (item 87). Ver a migration 006 para o porquê. */
export const MAX_REACTIONS_PER_MESSAGE = 20;
export const MAX_REACTIONS_PER_USER_PER_MESSAGE = 6;

/**
 * M11a: o que a rota já resolveu com `parseMentions` antes de gravar. Vem
 * pronto de propósito — o Store grava o que decidiram, não decide.
 */
export interface NewMessage {
  type?: MessageType;
  /** ids já resolvidos; viram linhas em `message_mentions` */
  mentions?: string[];
  everyone?: boolean;
  /** M11b (item 86): a rota JÁ conferiu que existe e que é do mesmo canal */
  replyToId?: string;
  /**
   * M11b (item 89): anexos a amarrar. A rota já conferiu que são do próprio
   * autor e que ainda estão soltos; a amarração acontece na MESMA transação da
   * mensagem — uma mensagem que existe sem os anexos dela seria uma linha
   * "vazia" no histórico, e os bytes ficariam órfãos até a faxina passar.
   */
  attachmentIds?: string[];
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

  /**
   * Cria a mensagem e, na MESMA transação, as linhas de menção (M11a): uma
   * mensagem que existe sem as menções dela contaria errado no badge de quem
   * foi chamado — e ninguém descobriria, porque o texto na tela estaria certo.
   */
  createMessage(channelId: string, authorId: string, content: string, extra: NewMessage = {}): Message {
    const id = nextId();
    const createdAt = Date.now();
    const type = extra.type ?? "user";
    // dedup defensivo: a PK de message_mentions recusaria o id repetido, e o
    // parser já não repete — mas o Store não confia em quem o chama
    const mentions = [...new Set(extra.mentions ?? [])];
    const everyone = extra.everyone === true;
    const attachmentIds = [...new Set(extra.attachmentIds ?? [])];
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO messages (id, channel_id, author_id, content, created_at, type, mentions_everyone, reply_to_id)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          idFromString(channelId),
          idFromString(authorId),
          content,
          createdAt,
          type,
          everyone ? 1 : 0,
          extra.replyToId === undefined ? null : idFromString(extra.replyToId),
        );
      const insert = this.db.prepare("INSERT INTO message_mentions (message_id, user_id) VALUES (?, ?)");
      for (const userId of mentions) insert.run(id, idFromString(userId));
      // M11b: a amarração dos anexos é da MESMA transação. O `message_id IS
      // NULL` no WHERE é a trava contra roubo de anexo alheio já publicado —
      // a rota também confere, e aqui o banco confere de novo.
      const attach = this.db.prepare(
        "UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL AND uploader_id = ?",
      );
      for (const attachmentId of attachmentIds) {
        attach.run(id, idFromString(attachmentId), idFromString(authorId));
      }
    })();
    // relê pelo caminho normal: assim reply_to, anexos e reações saem do MESMO
    // código que os monta na paginação — montá-los à mão aqui é como o evento
    // de MESSAGE_CREATE passa a divergir do que o histórico mostra
    const created = this.getMessage(channelId, idToString(id));
    if (!created) throw new Error("store: mensagem recém-criada sumiu");
    return created;
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
    // menções, anexos, reações e citações da PÁGINA inteira em quatro queries:
    // com limite de 100 linhas, uma consulta por mensagem por aresta seriam
    // 400 idas ao banco para pintar uma tela
    return this.hydrate(rows);
  }

  /**
   * Busca defensiva para PATCH/DELETE: o channel_id do path entra no WHERE de
   * propósito — mensagem de outro canal (ou apagada) responde 404, não vaza.
   */
  getMessage(channelId: string, messageId: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL")
      .get(idFromString(messageId), idFromString(channelId)) as MessageRow | undefined;
    return row ? (this.hydrate([row])[0] ?? null) : null;
  }

  /**
   * Mensagem pelo id, SEM o escopo do canal e SEM filtrar apagada (M11b).
   *
   * Existe para o reply: quem valida um `reply_to_id` precisa saber se a
   * mensagem existe, em QUAL canal ela está e se foi apagada — três respostas
   * que o `getMessage` acima funde num 404 de propósito. Devolve a linha crua
   * porque quem chama decide o que fazer com cada caso.
   */
  messageRefInfo(messageId: string): { channelId: string; deleted: boolean } | null {
    const row = this.db.prepare("SELECT channel_id, deleted_at FROM messages WHERE id = ?").get(
      idFromString(messageId),
    ) as { channel_id: bigint; deleted_at: bigint | null } | undefined;
    if (row === undefined) return null;
    return { channelId: idToString(row.channel_id), deleted: row.deleted_at !== null };
  }

  /** Autor/canal são checados nas rotas; o deleted_at fica também aqui por defesa. */
  updateMessage(messageId: string, content: string): Message {
    this.db
      .prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(content, Date.now(), idFromString(messageId));
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(idFromString(messageId)) as MessageRow;
    // as menções NÃO são recalculadas na edição: quem já foi notificado não
    // desnotifica, e quem entrou no texto depois entra pelo próximo POST. É
    // uma escolha (a alternativa é reabrir a contagem de todo mundo) e está
    // fixada em teste.
    const hydrated = this.hydrate([row])[0];
    if (!hydrated) throw new Error("store: mensagem recém-editada sumiu");
    return hydrated;
  }

  /**
   * Soft delete (doc §6): a linha fica, listagens e getMessage filtram por
   * `deleted_at`. A linha precisa ficar porque um reply aponta para ela — é o
   * que permite a citação virar "mensagem apagada" em vez de sumir.
   *
   * O que NÃO fica (M11b): reações e anexos, apagados de verdade na mesma
   * transação.
   *
   *   - Reação de mensagem apagada não tem onde aparecer, e a contagem
   *     continuaria pesando na barra de reações de uma mensagem que ninguém vê.
   *   - Anexo é BLOB: 10 imagens de 8 MB numa mensagem apagada seriam 80 MB de
   *     PVC ocupados PARA SEMPRE — o soft delete guarda o histórico, não o
   *     armazenamento. Depois disto, o `GET /api/attachments/:id` da imagem
   *     responde 404, que é o certo: a mensagem não existe mais.
   */
  softDeleteMessage(messageId: string): void {
    const id = idFromString(messageId);
    this.db.transaction(() => {
      this.db.prepare("UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id);
      this.db.prepare("DELETE FROM reactions WHERE message_id = ?").run(id);
      this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(id);
    })();
  }

  /**
   * Canal de texto onde as mensagens de sistema entram (M11a, item 92): o
   * primeiro da ordem, que é o "geral" do seed. Não é configurável de
   * propósito — configuração sem tela para mexer nela é enfeite, e com uma
   * guild só o primeiro canal é O canal.
   */
  defaultTextChannelId(): string | null {
    const row = this.db.prepare("SELECT id FROM channels WHERE type = 'text' ORDER BY position, id LIMIT 1").get() as
      | { id: bigint }
      | undefined;
    return row ? idToString(row.id) : null;
  }

  /** Última mensagem VISÍVEL do canal (null = canal vazio). */
  lastMessageId(channelId: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(id) AS last FROM messages WHERE channel_id = ? AND deleted_at IS NULL")
      .get(idFromString(channelId)) as { last: bigint | null };
    return row.last === null ? null : idToString(row.last);
  }

  // ---------------------------------------------------------------------------
  // Estado de leitura (M11a, item 81) — a base do badge, do separador de "novas
  // mensagens" e de qualquer notificação que não queira avisar duas vezes.
  // ---------------------------------------------------------------------------

  /**
   * "Li até aqui." Duas garantias, e as duas existem porque o id vem do
   * CLIENTE (só ele sabe o que apareceu na tela):
   *
   *   1. NÃO RETROCEDE — o `WHERE` do UPSERT recusa um id menor que o
   *      guardado. Sem isso, clicar num canal e cair numa página antiga do
   *      histórico "desleria" tudo que veio depois; e com duas abas abertas, a
   *      que estivesse mais atrasada desfaria o ack da outra a cada scroll.
   *   2. NÃO PASSA DA ÚLTIMA mensagem — um id inventado (ou o maior snowflake
   *      possível) marcaria como lido tudo que ainda vai ser escrito, e o dono
   *      da sessão nunca mais veria uma badge. É dano em si mesmo, mas é dano
   *      silencioso, que é o pior tipo.
   *
   * Devolve a marca resultante (para o fan-out do MESSAGE_ACK) ou null quando
   * não há o que marcar — canal sem mensagem nenhuma.
   */
  /**
   * Marca TODOS os canais de texto como lidos até a última mensagem de cada um.
   *
   * Chamado quando alguém entra na guild. Sem isto, quem chega por convite (M10)
   * numa guild com histórico vê o backlog inteiro como não-lido — e "342 novas"
   * em cada canal não é informação, é um número que a pessoa nunca vai zerar
   * lendo. Entrar num servidor não é ter perdido as conversas de antes dele.
   *
   * É o par explícito da regra de contagem: sem `read_state` conta tudo, e é
   * justamente por isso que a linha precisa nascer junto com o membro.
   */
  markAllReadOnJoin(userId: string): void {
    for (const channel of this.listChannels()) {
      if (channel.type !== "text") continue;
      const last = this.lastMessageId(channel.id);
      if (last !== null) this.markRead(userId, channel.id, last);
    }
  }

  markRead(userId: string, channelId: string, messageId: string): string | null {
    const last = this.lastMessageId(channelId);
    if (last === null) return null;
    const wanted = idFromString(messageId);
    const ceiling = idFromString(last);
    const target = wanted > ceiling ? ceiling : wanted;
    this.db
      .prepare(
        "INSERT INTO read_state (user_id, channel_id, last_read_message_id, updated_at) VALUES (?, ?, ?, ?)" +
          " ON CONFLICT (user_id, channel_id) DO UPDATE SET" +
          " last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at" +
          " WHERE excluded.last_read_message_id > read_state.last_read_message_id",
      )
      .run(idFromString(userId), idFromString(channelId), target, Date.now());
    return this.lastReadMessageId(userId, channelId);
  }

  /** Marca guardada, ou null se este usuário nunca deu ack neste canal. */
  lastReadMessageId(userId: string, channelId: string): string | null {
    const row = this.db
      .prepare("SELECT last_read_message_id FROM read_state WHERE user_id = ? AND channel_id = ?")
      .get(idFromString(userId), idFromString(channelId)) as { last_read_message_id: bigint } | undefined;
    return row === undefined ? null : idToString(row.last_read_message_id);
  }

  /**
   * Snapshot de não lidas por canal de texto, para o READY.
   *
   * REGRA DA AUSÊNCIA DE `read_state`: conta TUDO (menos as próprias). A linha
   * só existe depois do primeiro ack, então não ter linha significa
   * literalmente "nunca li nada aqui" — e é o que a contagem diz. A
   * alternativa tentadora (assumir tudo lido) esconderia justamente o caso que
   * a badge existe para cobrir: o canal que a pessoa nunca abriu. O certo de
   * verdade seria contar a partir da ENTRADA na guild, mas isso exige uma data
   * de entrada que hoje não existe (a linha em `users` sobrevive a kick e
   * rejoin), e inventá-la aqui seria complexidade sem dono. O preço da escolha
   * é um número grande na primeira visita, que um clique zera para sempre.
   *
   * As próprias mensagens saem da conta em todo caso — ninguém tem não-lida de
   * si mesmo, e vê-las contadas ao mandar mensagem de outro dispositivo seria o
   * bug mais confuso possível.
   */
  readStates(userId: string): ChannelReadState[] {
    const me = idFromString(userId);
    const unread = this.db.prepare(
      "SELECT COUNT(*) AS n FROM messages" +
        " WHERE channel_id = ? AND deleted_at IS NULL AND author_id <> ? AND id > ?",
    );
    const mentions = this.db.prepare(
      "SELECT COUNT(*) AS n FROM messages m" +
        " WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.author_id <> ? AND m.id > ?" +
        " AND (m.mentions_everyone = 1" +
        "      OR EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ?))",
    );
    const out: ChannelReadState[] = [];
    for (const channel of this.listChannels()) {
      // canal de voz não tem mensagem — e uma badge nele não teria o que contar
      if (channel.type !== "text") continue;
      const cid = idFromString(channel.id);
      const stored = this.lastReadMessageId(userId, channel.id);
      // 0n é o piso natural: todo snowflake é maior que zero, então "sem marca"
      // e "conta tudo" viram a MESMA comparação — sem um ramo a mais na query
      const floor = stored === null ? 0n : idFromString(stored);
      out.push({
        channel_id: channel.id,
        last_message_id: this.lastMessageId(channel.id),
        unread_count: Number((unread.get(cid, me, floor) as { n: bigint }).n),
        mention_count: Number((mentions.get(cid, me, floor, me) as { n: bigint }).n),
      });
    }
    return out;
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

  // ---------------------------------------------------------------------------
  // Reações (M11b, item 87). Dados simples, muitos eventos: a PK composta da
  // tabela É a regra de "um emoji por pessoa por mensagem", e os tetos são de
  // aplicação porque o SQLite não expressa "conte o grupo antes de inserir".
  // ---------------------------------------------------------------------------

  /**
   * Põe uma reação. Idempotente: reagir de novo com o mesmo emoji devolve
   * `created: false` e NÃO é erro (um clique duplo não pode virar 409 na cara
   * de quem clicou) — o call site usa o `created` para decidir se emite evento.
   *
   * Os dois tetos são checados na MESMA transação do INSERT: fora dela, dois
   * pedidos simultâneos passariam os dois pela contagem e o 21º emoji entraria.
   *
   * O emoji já vem VALIDADO pelo protocolo (`isValidReactionEmoji`) — este
   * método não olha o conteúdo da string, só conta linhas.
   */
  addReaction(messageId: string, userId: string, emoji: string): AddReactionResult {
    const mid = idFromString(messageId);
    const uid = idFromString(userId);
    return this.db.transaction((): AddReactionResult => {
      const already = this.db
        .prepare("SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .get(mid, uid, emoji);
      if (already !== undefined) return { ok: true, created: false };

      const distinct = this.db
        .prepare("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?")
        .get(mid) as { n: bigint };
      const isNewEmoji =
        this.db.prepare("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?").get(mid, emoji) === undefined;
      if (isNewEmoji && Number(distinct.n) >= MAX_REACTIONS_PER_MESSAGE) {
        return { ok: false, reason: "too_many_emojis" };
      }

      const mine = this.db
        .prepare("SELECT COUNT(*) AS n FROM reactions WHERE message_id = ? AND user_id = ?")
        .get(mid, uid) as { n: bigint };
      if (Number(mine.n) >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
        return { ok: false, reason: "too_many_by_user" };
      }

      this.db
        .prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)")
        .run(mid, uid, emoji, Date.now());
      return { ok: true, created: true };
    })();
  }

  /** Tira a reação. false = não existia (o call site não emite evento). */
  removeReaction(messageId: string, userId: string, emoji: string): boolean {
    const info = this.db
      .prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
      .run(idFromString(messageId), idFromString(userId), emoji);
    return info.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Anexos (M11b, item 89). Os BYTES ficam em BLOB pelo mesmo motivo dos sons:
  // um PVC só, e backup continua sendo UM arquivo.
  // ---------------------------------------------------------------------------

  /** Nasce SOLTO (message_id null): quem amarra é o POST da mensagem. */
  createAttachment(input: NewAttachment): Attachment {
    const id = nextId();
    this.db
      .prepare(
        "INSERT INTO attachments (id, message_id, uploader_id, filename, mime, bytes, size_bytes, width, height, created_at)" +
          " VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        idFromString(input.uploaderId),
        input.filename,
        input.mime,
        input.bytes,
        input.bytes.length,
        input.width,
        input.height,
        Date.now(),
      );
    return {
      id: idToString(id),
      filename: input.filename,
      mime: input.mime,
      size_bytes: input.bytes.length,
      width: input.width,
      height: input.height,
    };
  }

  /** Metadados + dono + se já está amarrado — o que a rota do POST precisa saber. */
  attachmentOwnership(attachmentId: string): { uploaderId: string; attached: boolean } | null {
    const row = this.db.prepare("SELECT uploader_id, message_id FROM attachments WHERE id = ?").get(
      idFromString(attachmentId),
    ) as { uploader_id: bigint; message_id: bigint | null } | undefined;
    if (row === undefined) return null;
    return { uploaderId: idToString(row.uploader_id), attached: row.message_id !== null };
  }

  /**
   * Bytes + mime GUARDADO (nunca o do request) + o nome original. Mesma regra
   * do `getSoundAudio`: servir um content-type escolhido por quem sobe, na
   * mesma origem do app, seria XSS de graça.
   */
  getAttachmentBytes(attachmentId: string): { mime: Attachment["mime"]; filename: string; bytes: Buffer } | null {
    const row = this.db.prepare("SELECT mime, filename, bytes FROM attachments WHERE id = ?").get(
      idFromString(attachmentId),
    ) as { mime: string; filename: string; bytes: Buffer } | undefined;
    if (!row) return null;
    return { mime: row.mime as Attachment["mime"], filename: row.filename, bytes: row.bytes };
  }

  /** Soma de TODOS os anexos (o teto da guild). Inclui os soltos: eles ocupam PVC igual. */
  totalAttachmentBytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM attachments").get() as { n: bigint };
    return Number(row.n);
  }

  /**
   * Faxina dos órfãos (item 89): anexo que subiu e nunca virou mensagem.
   *
   * Sem isto, quem escolhe uma imagem e desiste de mandar deixa 8 MB no PVC
   * para sempre — e ninguém nunca vai olhar uma tabela de anexos procurando
   * linhas sem `message_id`. Roda no boot e a cada 5 minutos (`index.ts`).
   * Devolve quantos saíram, para o log dizer que a faxina está viva.
   */
  deleteOrphanAttachments(olderThanMs: number, now: number = Date.now()): number {
    const info = this.db
      .prepare("DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?")
      .run(now - olderThanMs);
    return info.changes;
  }

  // ---------------------------------------------------------------------------
  // Cache de preview de link (M11b, item 90). O cache é parte da SEGURANÇA:
  // sem ele cada render viraria uma ida do servidor à internet, e uma URL que
  // falha seria retentada para sempre. Por isso guarda o fracasso também.
  // ---------------------------------------------------------------------------

  /** Entrada VÁLIDA do cache (positiva ou negativa); null = não tem, ou venceu. */
  getLinkPreview(url: string, now: number = Date.now()): LinkPreview | null {
    const row = this.db.prepare("SELECT * FROM link_previews WHERE url = ? AND expires_at > ?").get(url, now) as
      | {
          url: string;
          ok: bigint;
          title: string | null;
          description: string | null;
          site_name: string | null;
          error: string | null;
          fetched_at: bigint;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      url: row.url,
      ok: row.ok !== 0n,
      title: row.title,
      description: row.description,
      site_name: row.site_name,
      error: row.error,
      fetched_at: Number(row.fetched_at),
    };
  }

  /** Grava (ou substitui) a entrada. `ttlMs` é curto no caso negativo. */
  saveLinkPreview(preview: Omit<LinkPreview, "fetched_at">, ttlMs: number, now: number = Date.now()): LinkPreview {
    this.db
      .prepare(
        "INSERT INTO link_previews (url, ok, title, description, site_name, error, fetched_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT (url) DO UPDATE SET ok = excluded.ok, title = excluded.title," +
          " description = excluded.description, site_name = excluded.site_name, error = excluded.error," +
          " fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
      )
      .run(
        preview.url,
        preview.ok ? 1 : 0,
        preview.title,
        preview.description,
        preview.site_name,
        preview.error,
        now,
        now + ttlMs,
      );
    return { ...preview, fetched_at: now };
  }

  // ---------------------------------------------------------------------------
  // Busca (M11b, item 91) — FTS5 com conteúdo externo; ver a migration 006.
  // ---------------------------------------------------------------------------

  /**
   * Busca no histórico. A `query` já vem SANEADA (`sanitizeFtsQuery`): esta
   * camada não conserta sintaxe de FTS5, e mandar texto cru daqui seria erro de
   * SQL na cara do usuário no primeiro `"` que alguém digitasse.
   *
   * Os dois filtros do WHERE não são redundantes com os triggers, são a
   * cinta-e-suspensório: os triggers mantêm apagada e de sistema FORA do
   * índice, e o WHERE garante que uma mensagem que escapou (índice reconstruído
   * à mão, migration futura) não vaze mesmo assim.
   */
  searchMessages(query: string, options: { channelId?: string; limit?: number } = {}): SearchHit[] {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 50);
    const params: unknown[] = [query];
    let sql =
      "SELECT m.*, snippet(messages_fts, 0, ?, ?, '…', 12) AS snip" +
      " FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid" +
      " WHERE messages_fts MATCH ? AND m.deleted_at IS NULL AND m.type = 'user'";
    // os marcadores entram como parâmetro (e não no literal) para o único lugar
    // que os define continuar sendo o protocolo
    params.unshift(SEARCH_HIT_OPEN, SEARCH_HIT_CLOSE);
    if (options.channelId !== undefined) {
      sql += " AND m.channel_id = ?";
      params.push(idFromString(options.channelId));
    }
    // do mais novo para o mais velho: numa conversa, o acerto recente é quase
    // sempre o procurado — e o id é o próprio relógio (snowflake)
    sql += " ORDER BY m.id DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (MessageRow & { snip: string })[];
    const messages = this.hydrate(rows);
    return rows.map((row, index) => ({
      // o hydrate preserva a ordem das linhas — é map sobre o mesmo array
      message: messages[index] as Message,
      snippet: row.snip,
    }));
  }

  // ---------------------------------------------------------------------------
  // Hidratação (M11a + M11b): linha(s) de `messages` → entidade(s) do fio, com
  // menções, anexos, reações e a citação resolvida. SEMPRE em lote — cada
  // aresta é UMA query para a página inteira, não uma por mensagem.
  // ---------------------------------------------------------------------------

  private hydrate(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const mentions = this.mentionsOf(ids);
    const attachments = this.attachmentsOf(ids);
    const reactions = this.reactionsOf(ids);
    const references = this.referencesOf(rows);

    return rows.map((r) => {
      const message: Message = {
        id: idToString(r.id),
        channel_id: idToString(r.channel_id),
        author_id: idToString(r.author_id),
        content: r.content,
        created_at: Number(r.created_at),
        edited_at: r.edited_at === null ? null : Number(r.edited_at),
        type: r.type,
        mentions: mentions.get(r.id) ?? [],
        mentions_everyone: r.mentions_everyone !== 0n,
        attachments: attachments.get(r.id) ?? [],
        reactions: reactions.get(r.id) ?? [],
        reply_to: r.reply_to_id === null ? null : (references.get(r.reply_to_id) ?? null),
      };
      return message;
    });
  }

  /** message_id → ids mencionados, para um lote de mensagens (M11a). */
  private mentionsOf(ids: bigint[]): Map<bigint, string[]> {
    const out = new Map<bigint, string[]>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT message_id, user_id FROM message_mentions WHERE message_id IN (${placeholders})`)
      .all(...ids) as { message_id: bigint; user_id: bigint }[];
    for (const row of rows) {
      const list = out.get(row.message_id) ?? [];
      list.push(idToString(row.user_id));
      out.set(row.message_id, list);
    }
    return out;
  }

  /** message_id → anexos, em ordem de upload (M11b). Sem o BLOB, sempre. */
  private attachmentsOf(ids: bigint[]): Map<bigint, Attachment[]> {
    const out = new Map<bigint, Attachment[]>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        "SELECT id, message_id, uploader_id, filename, mime, size_bytes, width, height, created_at" +
          ` FROM attachments WHERE message_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids) as AttachmentRow[];
    for (const row of rows) {
      if (row.message_id === null) continue;
      const list = out.get(row.message_id) ?? [];
      list.push({
        id: idToString(row.id),
        filename: row.filename,
        mime: row.mime as Attachment["mime"],
        size_bytes: Number(row.size_bytes),
        width: row.width === null ? null : Number(row.width),
        height: row.height === null ? null : Number(row.height),
      });
      out.set(row.message_id, list);
    }
    return out;
  }

  /**
   * message_id → reações agregadas por emoji (M11b). A ordem é a da PRIMEIRA
   * reação de cada emoji (`MIN(created_at)` na prática, aqui garantido pelo
   * ORDER BY de leitura): a barra de reações não pode se reordenar sozinha
   * embaixo do cursor de quem está clicando.
   */
  private reactionsOf(ids: bigint[]): Map<bigint, MessageReaction[]> {
    const out = new Map<bigint, MessageReaction[]>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${placeholders})` +
          " ORDER BY message_id, created_at, rowid",
      )
      .all(...ids) as { message_id: bigint; user_id: bigint; emoji: string }[];
    for (const row of rows) {
      const list = out.get(row.message_id) ?? [];
      const existing = list.find((entry) => entry.emoji === row.emoji);
      if (existing) existing.user_ids.push(idToString(row.user_id));
      else list.push({ emoji: row.emoji, user_ids: [idToString(row.user_id)] });
      out.set(row.message_id, list);
    }
    return out;
  }

  /**
   * id da citada → citação RESOLVIDA (M11b, item 86).
   *
   * O trecho é aparado aqui, no servidor, e não no cliente: mandar 4000
   * caracteres para desenhar uma linha de citação é desperdício em cada
   * mensagem de cada página. Mensagem apagada vem marcada como tal, SEM autor e
   * SEM conteúdo — a citação vira "mensagem apagada" e não vaza o que foi
   * apagado por baixo dela.
   */
  private referencesOf(rows: MessageRow[]): Map<bigint, MessageReference> {
    const out = new Map<bigint, MessageReference>();
    const wanted = [...new Set(rows.map((r) => r.reply_to_id).filter((id): id is bigint => id !== null))];
    if (wanted.length === 0) return out;
    const placeholders = wanted.map(() => "?").join(", ");
    const found = this.db
      .prepare(
        `SELECT id, channel_id, author_id, content, deleted_at FROM messages WHERE id IN (${placeholders})`,
      )
      .all(...wanted) as {
      id: bigint;
      channel_id: bigint;
      author_id: bigint;
      content: string;
      deleted_at: bigint | null;
    }[];
    for (const row of found) {
      const deleted = row.deleted_at !== null;
      out.set(row.id, {
        message_id: idToString(row.id),
        channel_id: idToString(row.channel_id),
        author_id: deleted ? null : idToString(row.author_id),
        excerpt: deleted ? null : excerpt(row.content),
        deleted,
      });
    }
    return out;
  }
}

/** Comprimento do trecho da citação: uma linha de UI, não meia mensagem. */
const EXCERPT_MAX = 120;

/**
 * Trecho de uma mensagem citada. Quebra de linha vira espaço porque a citação
 * é UMA linha na tela — um `\n` no meio dela só quebraria o layout.
 */
function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : flat;
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


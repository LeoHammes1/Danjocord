import { z } from "zod";

/**
 * Protocolo do gateway do Danjocord — versão reduzida do gateway do Discord.
 * Envelope único: { op, d, s?, t? }. Campos em snake_case no fio, como no original.
 *
 * A numeração dos opcodes espelha a do Discord de propósito (valor didático):
 * https://docs.discord.com/developers/events/gateway
 */
export const Op = {
  /** servidor→cliente: evento; carrega `s` (sequence) e `t` (nome do evento) */
  Dispatch: 0,
  /** cliente→servidor: batimento; `d` = último `s` visto (ou null antes do primeiro) */
  Heartbeat: 1,
  /** cliente→servidor: autenticação com token de sessão */
  Identify: 2,
  /** cliente→servidor: retomar sessão após queda, com replay dos eventos perdidos */
  Resume: 6,
  /** servidor→cliente: pedido para reconectar (deploy, rebalanceamento) */
  Reconnect: 7,
  /** servidor→cliente: sessão inválida; `d.resumable` diz se vale tentar Resume de novo */
  InvalidSession: 9,
  /** servidor→cliente: primeira mensagem da conexão; entrega heartbeat_interval */
  Hello: 10,
  /** servidor→cliente: confirmação de um Heartbeat */
  HeartbeatAck: 11,
  /** cliente→servidor: sinalização de voz (request com id de correlação `req`) — M3 */
  VoiceRequest: 20,
  /** servidor→cliente: resposta de sinalização de voz — M3 */
  VoiceResponse: 21,
} as const;
export type OpValue = (typeof Op)[keyof typeof Op];

/** Close codes próprios (faixa 4xxx, espelhando o Discord). */
export const CloseCode = {
  UnknownError: 4000,
  DecodeError: 4002,
  NotAuthenticated: 4003,
  AuthenticationFailed: 4004,
  AlreadyAuthenticated: 4005,
  InvalidSeq: 4007,
  SessionTimeout: 4009,
} as const;

// ---------------------------------------------------------------------------
// Entidades (como trafegam no fio; ids sempre string — snowflakes de 64 bits
// não cabem com segurança em number de JS)
// ---------------------------------------------------------------------------

export const User = z.object({
  id: z.string(),
  username: z.string(),
  avatar_url: z.string().nullable(),
  /** ausente = false; só o servidor popula (nunca vem de payload de cliente) */
  is_admin: z.boolean().optional(),
});
export type User = z.infer<typeof User>;

export const Channel = z.object({
  id: z.string(),
  type: z.enum(["text", "voice"]),
  name: z.string(),
  position: z.number().int(),
});
export type Channel = z.infer<typeof Channel>;

export const Message = z.object({
  id: z.string(),
  channel_id: z.string(),
  author_id: z.string(),
  content: z.string().min(1).max(4000),
  created_at: z.number().int(),
  /** ausente/null = nunca editada */
  edited_at: z.number().int().nullable().optional(),
  /** eco do nonce do cliente, para reconciliar o render otimista */
  nonce: z.string().optional(),
});
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------------------
// Payloads (`d`) de cada opcode
// ---------------------------------------------------------------------------

export const HelloData = z.object({
  heartbeat_interval: z.number().int().positive(),
});
export type HelloData = z.infer<typeof HelloData>;

export const IdentifyData = z.object({
  token: z.string().min(1),
});

export const ResumeData = z.object({
  /** o token é revalidado no Resume — sem ele, session_id viraria credencial */
  token: z.string().min(1),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ReadyData = z.object({
  session_id: z.string(),
  user: User,
  /** snapshot completo — com uma guild e ~10 pessoas, cabe numa mensagem */
  channels: z.array(Channel),
  members: z.array(User),
});
export type ReadyData = z.infer<typeof ReadyData>;

export const PresenceUpdateData = z.object({
  user_id: z.string(),
  online: z.boolean(),
});
export type PresenceUpdateData = z.infer<typeof PresenceUpdateData>;

export const MessageDeleteData = z.object({
  id: z.string(),
  channel_id: z.string(),
});
export type MessageDeleteData = z.infer<typeof MessageDeleteData>;

export const TypingStartData = z.object({
  channel_id: z.string(),
  user_id: z.string(),
});
export type TypingStartData = z.infer<typeof TypingStartData>;

// ---------------------------------------------------------------------------
// Eventos Dispatch (op 0), discriminados por `t`
// ---------------------------------------------------------------------------

export const DispatchEvent = z.discriminatedUnion("t", [
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("READY"), d: ReadyData }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("RESUMED"), d: z.object({}) }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MESSAGE_CREATE"), d: Message }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("PRESENCE_UPDATE"), d: PresenceUpdateData }),
  // mensagem editada: d é a mensagem completa, com edited_at preenchido
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MESSAGE_UPDATE"), d: Message }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MESSAGE_DELETE"), d: MessageDeleteData }),
  // sem evento de stop: o cliente ignora o próprio user_id e expira o indicador em ~10s
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("TYPING_START"), d: TypingStartData }),
  // usuário NOVO criado (dev ou OAuth) — re-login de usuário conhecido não dispara
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MEMBER_ADD"), d: User }),
]);
export type DispatchEvent = z.infer<typeof DispatchEvent>;
export type DispatchName = DispatchEvent["t"];

// ---------------------------------------------------------------------------
// Uniões por direção
// ---------------------------------------------------------------------------

export const ServerMessage = z.union([
  DispatchEvent,
  z.object({ op: z.literal(Op.Hello), d: HelloData }),
  z.object({ op: z.literal(Op.HeartbeatAck) }),
  z.object({ op: z.literal(Op.InvalidSession), d: z.object({ resumable: z.boolean() }) }),
  z.object({ op: z.literal(Op.Reconnect) }),
  z.object({
    op: z.literal(Op.VoiceResponse),
    d: z.object({ req: z.number().int(), ok: z.boolean(), p: z.unknown().optional(), error: z.string().optional() }),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.union([
  z.object({ op: z.literal(Op.Heartbeat), d: z.number().int().nullable() }),
  z.object({ op: z.literal(Op.Identify), d: IdentifyData }),
  z.object({ op: z.literal(Op.Resume), d: ResumeData }),
  z.object({
    op: z.literal(Op.VoiceRequest),
    d: z.object({ req: z.number().int(), m: z.string(), p: z.unknown().optional() }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// REST (superfície mínima do M0; cresce no M2)
// ---------------------------------------------------------------------------

export const CreateMessageBody = z.object({
  content: z.string().min(1).max(4000),
  nonce: z.string().max(64).optional(),
});
export type CreateMessageBody = z.infer<typeof CreateMessageBody>;

/** PATCH de mensagem (M2) — sem nonce: o cliente já conhece o id da mensagem */
export const UpdateMessageBody = z.object({
  content: z.string().min(1).max(4000),
});
export type UpdateMessageBody = z.infer<typeof UpdateMessageBody>;

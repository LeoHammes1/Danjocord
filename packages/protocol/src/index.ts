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

/**
 * Estado de voz de um usuário (M3, doc §3.6). channel_id null = fora de voz
 * (é assim que um leave viaja no VOICE_STATE_UPDATE). Os flags são
 * declarativos: o mute REAL acontece no cliente (track.enabled) — o servidor
 * só espalha a intenção para a UI dos outros. Exceção: self_video (M4) é
 * DERIVADO no servidor (existe producer de vídeo vivo na sessão) — nunca vem
 * de payload de cliente, então o flag não consegue mentir sobre a mídia.
 */
export const VoiceState = z.object({
  user_id: z.string(),
  channel_id: z.string().nullable(),
  self_mute: z.boolean(),
  self_deaf: z.boolean(),
  /** M4: câmera ligada (indicador na lista de participantes) — derivado, ver acima */
  self_video: z.boolean(),
});
export type VoiceState = z.infer<typeof VoiceState>;

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
  /** snapshot de quem está em voz agora (M3) — só entradas com channel_id preenchido */
  voice_states: z.array(VoiceState),
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

/**
 * Producer novo num canal de voz (M3; M4 soma vídeo): quem está no canal
 * consome sob demanda. Vai para TODO mundo (broadcast simples); o dono do
 * producer se reconhece pelo user_id e não consome a si mesmo. `kind` diz ao
 * cliente COMO consumir: áudio → <audio> fora do DOM; vídeo → tile na grade.
 */
export const VoiceNewProducerData = z.object({
  channel_id: z.string(),
  user_id: z.string(),
  producer_id: z.string(),
  kind: z.enum(["audio", "video"]),
});
export type VoiceNewProducerData = z.infer<typeof VoiceNewProducerData>;

export const VoiceProducerClosedData = z.object({
  channel_id: z.string(),
  producer_id: z.string(),
});
export type VoiceProducerClosedData = z.infer<typeof VoiceProducerClosedData>;

/**
 * Quem está falando AGORA no canal (audioLevelObserver do mediasoup).
 * O array SUBSTITUI o conjunto anterior por inteiro — o servidor só emite
 * quando o conjunto muda, então ausência de evento = nada mudou.
 */
export const VoiceSpeakingData = z.object({
  channel_id: z.string(),
  speaking: z.array(z.string()),
});
export type VoiceSpeakingData = z.infer<typeof VoiceSpeakingData>;

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
  // voz (M3): join (channel_id preenchido), leave (null) e mudança de mute/deaf
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("VOICE_STATE_UPDATE"), d: VoiceState }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("VOICE_NEW_PRODUCER"), d: VoiceNewProducerData }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("VOICE_PRODUCER_CLOSED"), d: VoiceProducerClosedData }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("VOICE_SPEAKING"), d: VoiceSpeakingData }),
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
// Sinalização de voz (op 20/21, M3, doc §3.6) — schemas do `p` por método `m`.
//
// O servidor valida o `p` de cada request com o schema do método antes de
// tocar no mediasoup. Os blobs do próprio mediasoup (rtp/dtls/ice) trafegam
// como z.unknown() DE PROPÓSITO: são estruturas dele, versionadas por ele, e
// o worker valida do lado de lá — replicá-las em Zod só criaria drift.
// Métodos no fio em snake_case, como todo o resto do protocolo.
// ---------------------------------------------------------------------------

/**
 * m: "join" → resposta { rtp_capabilities: unknown, producers: VoiceNewProducerData[] }.
 * `producers` são os já ativos no canal no momento do join — VOICE_NEW_PRODUCER
 * só alcança quem estava conectado quando o produce aconteceu, então o
 * recém-chegado recebe o estoque atual aqui e consome sob demanda.
 */
export const VoiceJoinParams = z.object({ channel_id: z.string() });
export type VoiceJoinParams = z.infer<typeof VoiceJoinParams>;

/** m: "create_transport" → { transport_id, ice_parameters, ice_candidates, dtls_parameters } */
export const VoiceCreateTransportParams = z.object({ direction: z.enum(["send", "recv"]) });
export type VoiceCreateTransportParams = z.infer<typeof VoiceCreateTransportParams>;

/** m: "connect_transport" → {} (fecha o handshake DTLS do transport) */
export const VoiceConnectTransportParams = z.object({
  transport_id: z.string(),
  dtls_parameters: z.unknown(),
});
export type VoiceConnectTransportParams = z.infer<typeof VoiceConnectTransportParams>;

/**
 * m: "produce" → { producer_id }. M4: kind "video" entra pelo MESMO send
 * transport (webcam com simulcast de 3 camadas, doc §3.4) — no máximo UM
 * producer de vídeo por sessão neste milestone (o segundo é erro).
 */
export const VoiceProduceParams = z.object({
  transport_id: z.string(),
  kind: z.enum(["audio", "video"]),
  rtp_parameters: z.unknown(),
});
export type VoiceProduceParams = z.infer<typeof VoiceProduceParams>;

/**
 * m: "close_producer" → {} (M4: desligar a câmera SEM sair da voz). O servidor
 * broadcasta VOICE_PRODUCER_CLOSED; se o producer era de vídeo, também um
 * VOICE_STATE_UPDATE com self_video=false. producer_id alheio → erro.
 */
export const VoiceCloseProducerParams = z.object({ producer_id: z.string() });
export type VoiceCloseProducerParams = z.infer<typeof VoiceCloseProducerParams>;

/** m: "consume" → { consumer_id, producer_id, kind, rtp_parameters } (nasce pausado) */
export const VoiceConsumeParams = z.object({
  transport_id: z.string(),
  producer_id: z.string(),
  rtp_capabilities: z.unknown(),
});
export type VoiceConsumeParams = z.infer<typeof VoiceConsumeParams>;

/** m: "resume_consumer" → {} (o cliente chama depois de plugar o track no <audio>/<video>) */
export const VoiceResumeConsumerParams = z.object({ consumer_id: z.string() });
export type VoiceResumeConsumerParams = z.infer<typeof VoiceResumeConsumerParams>;

/**
 * m: "pause_consumer" → {} (M4, doc §8): tile de vídeo fora de tela — o
 * servidor PARA de encaminhar RTP (economia real, não é esconder na UI);
 * resume_consumer religa quando o tile volta a aparecer.
 */
export const VoicePauseConsumerParams = z.object({ consumer_id: z.string() });
export type VoicePauseConsumerParams = z.infer<typeof VoicePauseConsumerParams>;

/**
 * m: "set_preferred_layers" → {} (M4, doc §3.4): camada de simulcast que ESTE
 * assinante quer do consumer de vídeo. As camadas são RELATIVAS à captura do
 * produtor (0 = baixa /4, 1 = média /2, 2 = inteira) — com câmera 4K a camada
 * 2 chega a ~10 Mbps; o assinante escolhe pelo tamanho do tile que exibe.
 * Em consumer de áudio (não tem camadas) → erro claro.
 */
export const VoiceSetPreferredLayersParams = z.object({
  consumer_id: z.string(),
  spatial_layer: z.number().int().min(0).max(2),
});
export type VoiceSetPreferredLayersParams = z.infer<typeof VoiceSetPreferredLayersParams>;

/** m: "restart_ice" → { ice_parameters } (rede trocou por baixo do cliente) */
export const VoiceRestartIceParams = z.object({ transport_id: z.string() });
export type VoiceRestartIceParams = z.infer<typeof VoiceRestartIceParams>;

/** m: "update_state" → {} (só flags; o mute real é o cliente desligar o track) */
export const VoiceUpdateStateParams = z.object({
  self_mute: z.boolean(),
  self_deaf: z.boolean(),
});
export type VoiceUpdateStateParams = z.infer<typeof VoiceUpdateStateParams>;

// m: "leave" não tem schema: `p` vazio/ausente → resposta {}.

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

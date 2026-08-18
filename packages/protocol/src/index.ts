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
 * M5 (doc §3.5/§3.6): origem SEMÂNTICA de um producer. O `kind` diz o que a
 * mídia é (audio/video); o `source` diz de onde vem e quais políticas valem —
 * só "mic" alimenta o audioLevelObserver do speaking; "screen" é 1 por sessão
 * E 1 por canal; "screen_audio" (soundshare) só existe acompanhando a tela.
 * Pareamento obrigatório: mic/screen_audio = audio; camera/screen = video.
 */
export const ProducerSource = z.enum(["mic", "camera", "screen", "screen_audio"]);
export type ProducerSource = z.infer<typeof ProducerSource>;

/**
 * Estado de voz de um usuário (M3, doc §3.6). channel_id null = fora de voz
 * (é assim que um leave viaja no VOICE_STATE_UPDATE). Os flags são
 * declarativos: o mute REAL acontece no cliente (track.enabled) — o servidor
 * só espalha a intenção para a UI dos outros. Exceção: self_video (M4),
 * self_stream (M5) e server_mute (M9) são DERIVADOS no servidor — nunca vêm de
 * payload de cliente, então os flags não conseguem mentir sobre a mídia.
 */
export const VoiceState = z.object({
  user_id: z.string(),
  channel_id: z.string().nullable(),
  self_mute: z.boolean(),
  self_deaf: z.boolean(),
  /** M4: câmera ligada (indicador na lista de participantes) — derivado, ver acima */
  self_video: z.boolean(),
  /** M5: transmitindo a tela (badge "AO VIVO" na lista) — derivado, ver acima */
  self_stream: z.boolean(),
  /**
   * M9: silenciado por um admin. Ao contrário dos self_*, este NÃO é
   * declarativo: o servidor pausa o producer de `mic` do alvo no mediasoup —
   * o flag só conta à UI o que já está sendo imposto na mídia.
   */
  server_mute: z.boolean(),
});
export type VoiceState = z.infer<typeof VoiceState>;

/**
 * Som do soundboard (M9). Como no Discord, QUALQUER membro sobe um som e ele
 * fica disponível para a guild inteira; os 9 embutidos (CC0 da Kenney) são
 * semeados no banco no primeiro boot e só se distinguem por `uploader_id` null.
 *
 * Os bytes NÃO viajam aqui: o cliente baixa uma vez de
 * `GET /api/sounds/:id/audio` (imutável e cacheável — o id é snowflake e o
 * conteúdo nunca muda) e guarda o AudioBuffer decodificado.
 */
export const Sound = z.object({
  id: z.string(),
  name: z.string().min(1).max(32),
  /** null = som embutido (semeado no boot), sem dono para renomear/apagar */
  uploader_id: z.string().nullable(),
  /** guardado no upload e devolvido no GET de áudio — nunca ecoado do request */
  mime: z.enum(["audio/ogg", "audio/wav", "audio/mpeg"]),
  size_bytes: z.number().int(),
  /** medido pelo SERVIDOR abrindo o container (o cliente não é fonte disso) */
  duration_ms: z.number().int(),
  /** normalização como no M8: ganho no playback (alvo ~-20 dBFS de RMS), asset intacto */
  gain: z.number(),
  created_at: z.number().int(),
});
export type Sound = z.infer<typeof Sound>;

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
  /** catálogo do soundboard (M9): metadados; os bytes vêm por REST sob demanda */
  sounds: z.array(Sound),
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
 * Producer novo num canal de voz (M3; M4 soma vídeo; M5 soma screen share):
 * quem está no canal consome sob demanda. Vai para TODO mundo (broadcast
 * simples); o dono do producer se reconhece pelo user_id e não consome a si
 * mesmo. `kind` diz ao cliente COMO consumir: áudio → <audio> fora do DOM;
 * vídeo → tile na grade. `source` (M5) diz SE consumir: "screen" e
 * "screen_audio" NÃO são consumidos no anúncio — viewers assistem sob demanda
 * (watchStream), quem não clicou não gasta banda (doc §3.6).
 */
export const VoiceNewProducerData = z.object({
  channel_id: z.string(),
  user_id: z.string(),
  producer_id: z.string(),
  kind: z.enum(["audio", "video"]),
  source: ProducerSource,
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

/** Som apagado (M9): só o id — o cliente descarta o AudioBuffer em cache. */
export const SoundDeleteData = z.object({ id: z.string() });
export type SoundDeleteData = z.infer<typeof SoundDeleteData>;

/**
 * Alguém apertou um pad do soundboard (M9). O áudio NÃO passa pelo SFU: o
 * gateway só replica o id e CADA cliente do canal toca o arquivo localmente
 * (imediato, fora do AEC de todo mundo, sem gastar banda) — arquitetura (a) do
 * roadmap item 22. `channel_id` é o canal de voz onde o som foi disparado:
 * quem não está nele ignora o evento.
 */
export const VoiceSoundboardData = z.object({
  user_id: z.string(),
  channel_id: z.string(),
  sound_id: z.string(),
});
export type VoiceSoundboardData = z.infer<typeof VoiceSoundboardData>;

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
  // soundboard (M9): catálogo (mutado por REST, como toda mutação — doc §4) e
  // o disparo, que é só o fan-out do id (o playback é local em cada cliente)
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("SOUND_CREATE"), d: Sound }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("SOUND_UPDATE"), d: Sound }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("SOUND_DELETE"), d: SoundDeleteData }),
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("VOICE_SOUNDBOARD"), d: VoiceSoundboardData }),
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
 * transport (webcam com simulcast de 3 camadas, doc §3.4). M5: `source` é
 * OBRIGATÓRIO e o schema valida o pareamento kind×source (mic/screen_audio =
 * audio; camera/screen = video). Regras por source no servidor: cada source é
 * única por sessão; "screen" também é única por CANAL (doc §3.6);
 * "screen_audio" exige a tela da mesma sessão viva.
 */
export const VoiceProduceParams = z
  .object({
    transport_id: z.string(),
    kind: z.enum(["audio", "video"]),
    source: ProducerSource,
    rtp_parameters: z.unknown(),
  })
  .superRefine((v, ctx) => {
    // pareamento kind×source no SCHEMA: combinação impossível nem chega ao
    // mediasoup — e a mensagem curta viaja no campo error do op 21
    const expected = v.source === "mic" || v.source === "screen_audio" ? "audio" : "video";
    if (v.kind !== expected) {
      ctx.addIssue({ code: "custom", message: `source "${v.source}" exige kind "${expected}"` });
    }
  });
export type VoiceProduceParams = z.infer<typeof VoiceProduceParams>;

/**
 * m: "close_producer" → {} (M4: desligar a câmera SEM sair da voz). O servidor
 * broadcasta VOICE_PRODUCER_CLOSED; se o producer era "camera", também um
 * VOICE_STATE_UPDATE com self_video=false. M5: fechar um producer "screen"
 * fecha TAMBÉM o "screen_audio" da mesma sessão, se existir (soundshare órfão
 * sem tela não faz sentido) — sai o VOICE_PRODUCER_CLOSED de ambos e um
 * VOICE_STATE_UPDATE com self_stream=false. producer_id alheio → erro.
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
 * m: "close_consumer" → {} (M5): o viewer PAROU de assistir uma transmissão —
 * libera o consumer no servidor de vez. Diferente do pause (que deixa o
 * consumer alocado para religar barato), o close devolve os recursos: é a
 * economia real do modelo "viewers sob demanda" do doc §3.6. consumer_id
 * alheio → erro.
 */
export const VoiceCloseConsumerParams = z.object({ consumer_id: z.string() });
export type VoiceCloseConsumerParams = z.infer<typeof VoiceCloseConsumerParams>;

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

/**
 * m: "server_mute" → {} (M9, roadmap 34) — SÓ ADMIN. Silenciar para TODOS não
 * pode ser declarativo como os self_*: o servidor pausa o producer de `mic` do
 * alvo no mediasoup, então nem um cliente modificado continua sendo ouvido. O
 * estado é do USUÁRIO (não da sessão) e sobrevive a sair/voltar da voz e a
 * refazer o producer — do contrário bastaria sair e voltar para burlar. Vive em
 * memória, como todo estado efêmero do projeto: um restart o perde (e derruba
 * todas as sessões de voz junto).
 */
export const VoiceServerMuteParams = z.object({
  user_id: z.string(),
  muted: z.boolean(),
});
export type VoiceServerMuteParams = z.infer<typeof VoiceServerMuteParams>;

/**
 * m: "disconnect_user" → {} (M9, roadmap 37) — SÓ ADMIN. Tira o alvo do canal
 * de voz; TODAS as sessões dele saem (o mesmo usuário pode estar em mais de uma
 * sessão de gateway). Não impede voltar: quem quiser barrar de vez usa ban
 * (M10) — isto é o "sai daí" imediato.
 */
export const VoiceDisconnectUserParams = z.object({
  user_id: z.string(),
});
export type VoiceDisconnectUserParams = z.infer<typeof VoiceDisconnectUserParams>;

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

// --- soundboard (M9) ---

/**
 * Nome de som: 1..32 depois de aparar. Sem caractere de controle — o nome
 * viaja em evento e vira texto de botão; uma quebra de linha ou um BEL no
 * meio dele só serviriam para enfeiar a UI de todo mundo.
 */
const SoundName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  // por codepoint e não por regex: a faixa de controle dentro de uma classe de
  // caractere vira byte invisível no arquivo — some no diff e ninguém revisa
  .refine(
    (s) => ![...s].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f),
    "nome com caractere de controle",
  );

/**
 * `POST /api/sounds?name=&gain=` — os metadados vão na QUERY porque o corpo é
 * o arquivo binário CRU (`application/octet-stream` ou o mime do arquivo).
 * Não é multipart de propósito: o Fastify 5 não lê multipart sem plugin, e o
 * projeto não ganha dependência nova por causa disso (regra do M9).
 *
 * `gain` é SUGESTÃO: o cliente decodifica o arquivo no preview, mede o RMS e
 * propõe o ganho que leva o som a ~-20 dBFS (mesmo critério do M8). O servidor
 * CLAMPA a faixa útil — um cliente modificado não manda gain 50 para estourar
 * o ouvido da guild. Ausente = 1.0.
 */
export const CreateSoundQuery = z.object({
  name: SoundName,
  gain: z.coerce.number().finite().optional(),
});
export type CreateSoundQuery = z.infer<typeof CreateSoundQuery>;

/** `PATCH /api/sounds/:id` — só renomeia (o áudio é imutável, o id é o cache key) */
export const UpdateSoundBody = z.object({
  name: SoundName,
});
export type UpdateSoundBody = z.infer<typeof UpdateSoundBody>;

/**
 * `POST /api/voice/soundboard` — tocar. Só o id: o canal é o que o SERVIDOR vê
 * (quem não está em voz recebe 403), nunca o que o cliente declara.
 */
export const PlaySoundBody = z.object({
  sound_id: z.string(),
});
export type PlaySoundBody = z.infer<typeof PlaySoundBody>;

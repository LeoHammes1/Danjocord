import { z } from "zod";

/**
 * Parser de menções: módulo PURO à parte (M11a, item 79) e reexportado daqui
 * para que o ponto de entrada do pacote continue sendo um só. Ele não conhece
 * Zod nem o fio — é texto entrando e ids saindo, e é o que permite testá-lo
 * sem subir nada (mesmo motivo do `catalog.ts` puro do M8).
 */
export {
  parseMentions,
  EVERYONE_KEYWORD,
  type MentionCandidate,
  type ParsedMentions,
} from "./mentions.js";

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
  /**
   * cliente→servidor: declarar o status de presença (M10, item 56).
   *
   * É opcode e não REST — e o número 3 é o mesmo do Discord — porque presença é
   * estado EFÊMERO da conexão: mora na sessão de gateway, morre com ela e nunca
   * toca o banco (convenção do repo). Uma rota REST teria que alcançar a sessão
   * de WebSocket do chamador por fora, e ainda ficaria sem resposta para "e se
   * a conexão cair?" — aqui o socket fechar já é a resposta (volta a offline).
   */
  PresenceUpdate: 3,
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
  /**
   * M10 (item 114): a sessão perdeu o direito de existir DEPOIS do Identify —
   * kick, ban, cargo revogado ou allowlist mexida por fora (CLI). Precisa ser
   * um código próprio: 4004 é "seu token não presta" (o cliente pode tentar
   * outro), este é "você não é mais membro" — não adianta reconectar, e o
   * cliente deve parar de tentar e voltar para a tela de login.
   */
  NotAMember: 4016,
} as const;

// ---------------------------------------------------------------------------
// Entidades (como trafegam no fio; ids sempre string — snowflakes de 64 bits
// não cabem com segurança em number de JS)
// ---------------------------------------------------------------------------

/**
 * Cargo na guild (M10, item 51) — substitui o booleano `is_admin` do M2.
 * A ordem da união é a hierarquia: owner > admin > member (ver `roleRank`).
 */
export const Role = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof Role>;

/**
 * Peso do cargo para comparação. Existe para que "admin não mexe em admin" e
 * "ninguém toca no owner" sejam UMA comparação de números em vez de uma cadeia
 * de ifs repetida em cada rota — regra espalhada é regra que diverge.
 */
export function roleRank(role: Role): number {
  return role === "owner" ? 2 : role === "admin" ? 1 : 0;
}

export const User = z.object({
  id: z.string(),
  /** nome vindo do Discord — reescrito a cada login, nunca editável aqui */
  username: z.string(),
  /**
   * M10 (item 55): apelido PRÓPRIO da guild. Mora em coluna separada porque o
   * upsert do OAuth reescreve `username` a cada login e apagaria qualquer coisa
   * gravada lá. null = sem apelido; o nome exibido sai de `displayName()`.
   */
  nickname: z.string().nullable(),
  /** já RESOLVIDO pelo servidor: avatar_override da guild, ou o do Discord */
  avatar_url: z.string().nullable(),
  /** M10: só o servidor popula — nunca vem de payload de cliente */
  role: Role,
  /**
   * M10 (item 53): fim do timeout de chat, em epoch ms; null = livre. Viaja
   * junto do membro (e não numa rota à parte) porque é o que permite a UI
   * desabilitar o composer e marcar o silenciado na lista sem perguntar nada —
   * o servidor manda um MEMBER_UPDATE quando põe ou tira. Já vem RESOLVIDO:
   * timeout vencido chega como null, ninguém precisa comparar relógio.
   */
  muted_until: z.number().int().nullable(),
});
export type User = z.infer<typeof User>;

/**
 * Nome exibido, resolvido em UM lugar (item 55). Cliente e servidor importam
 * daqui; se cada tela decidisse sozinha, metade da UI mostraria o apelido e a
 * outra metade o nome do Discord.
 */
export function displayName(user: Pick<User, "username" | "nickname">): string {
  return user.nickname ?? user.username;
}

/** Açúcar de permissão: admin e owner moderam; member não. */
export function isStaff(user: Pick<User, "role">): boolean {
  return user.role !== "member";
}

/**
 * Convite por link (M10, itens 43–45). O `code` É a credencial — vem de
 * `crypto.randomBytes` no servidor, num alfabeto sem caracteres ambíguos
 * (sem 0/O e 1/l/I), porque ele é ditado em voz alta e digitado à mão.
 *
 * Só admin+ vê esta forma completa. Quem ainda não entrou vê `InvitePreview`.
 */
export const Invite = z.object({
  code: z.string(),
  created_by: z.string(),
  created_at: z.number().int(),
  /** null = não expira */
  expires_at: z.number().int().nullable(),
  /** null = usos ilimitados */
  max_uses: z.number().int().nullable(),
  uses: z.number().int(),
  revoked_at: z.number().int().nullable(),
});
export type Invite = z.infer<typeof Invite>;

/**
 * O que o `GET /api/invites/:code` PÚBLICO devolve — a landing mostra isto
 * antes de qualquer login. Deliberadamente pobre: nome da guild e quem
 * convidou, e nada mais. Contagem de usos, validade, lista de membros ou id de
 * quem quer que seja transformariam um código vazado num raio-x do servidor.
 */
export const InvitePreview = z.object({
  valid: z.literal(true),
  guild_name: z.string(),
  inviter_name: z.string(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

/** Banimento (M10, item 50) — indexado pelo id do DISCORD, ver a migration 004. */
export const Ban = z.object({
  discord_id: z.string(),
  banned_by: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.number().int(),
});
export type Ban = z.infer<typeof Ban>;

/**
 * Ações que entram no log de moderação (M10, item 57). É uma união fechada de
 * propósito: `action` vira filtro e rótulo na UI, e string livre viraria
 * quatro grafias da mesma coisa em seis meses.
 */
export const ModAction = z.enum([
  "kick",
  "ban",
  "unban",
  "timeout",
  "timeout_clear",
  "role_change",
  "invite_create",
  "invite_revoke",
  "invite_use",
  "server_mute",
  "server_unmute",
  "voice_disconnect",
  "owner_bootstrap",
]);
export type ModAction = z.infer<typeof ModAction>;

export const ModLogEntry = z.object({
  id: z.string(),
  /** null = o próprio sistema agiu (bootstrap do primeiro dono) */
  actor_id: z.string().nullable(),
  action: ModAction,
  target_user_id: z.string().nullable(),
  target_discord_id: z.string().nullable(),
  /** texto curto e livre: motivo, minutos do timeout, cargo novo… */
  detail: z.string().nullable(),
  created_at: z.number().int(),
});
export type ModLogEntry = z.infer<typeof ModLogEntry>;

export const Channel = z.object({
  id: z.string(),
  type: z.enum(["text", "voice"]),
  name: z.string(),
  position: z.number().int(),
});
export type Channel = z.infer<typeof Channel>;

/**
 * Natureza da mensagem (M11a, item 92). Mensagem de sistema entra na tabela
 * `messages` como qualquer outra — é isso que a faz aparecer na paginação, no
 * histórico e no Resume sem uma linha de código especial em nenhum dos dois
 * lados. O AUTOR é o sujeito do evento (quem entrou, quem saiu), e o conteúdo
 * é vazio de propósito: quem monta a frase é o cliente, porque o nome exibido
 * muda quando a pessoa troca de apelido — uma frase gravada envelheceria.
 */
export const MessageType = z.enum(["user", "member_join", "member_leave"]);
export type MessageType = z.infer<typeof MessageType>;

export const Message = z.object({
  id: z.string(),
  channel_id: z.string(),
  author_id: z.string(),
  /**
   * Sem `min(1)` desde o M11a: mensagem de sistema tem conteúdo VAZIO (a frase
   * é montada na tela). O piso de 1 continua onde ele protege alguma coisa —
   * no `CreateMessageBody`, que é o que o cliente manda.
   */
  content: z.string().max(4000),
  created_at: z.number().int(),
  /** ausente/null = nunca editada */
  edited_at: z.number().int().nullable().optional(),
  /** eco do nonce do cliente, para reconciliar o render otimista */
  nonce: z.string().optional(),
  /** M11a: 'user' é o caso normal; o resto só o SERVIDOR cria */
  type: MessageType,
  /**
   * M11a (item 79): quem esta mensagem menciona, RESOLVIDO pelo servidor no
   * POST com `parseMentions`. Viaja resolvido (e não recalculado na tela) por
   * dois motivos: é o mesmo resultado que a tabela `message_mentions` guardou
   * para poder contar, e o cliente decide "isto é para mim?" sem reparsear —
   * inclusive para mensagem de quem não está mais na lista de membros.
   */
  mentions: z.array(z.string()),
  /** `@todos` — conta separado porque não é uma lista de ids */
  mentions_everyone: z.boolean(),
});
export type Message = z.infer<typeof Message>;

/**
 * Estado de leitura de UM canal (M11a, item 81), como viaja no READY.
 *
 * É a base de tudo neste marco: sem ele não existe badge de não lidas (item
 * 80), nem separador de "novas mensagens", nem notificação que saiba o que já
 * foi visto. Vem no READY, e não numa rota por canal, porque com uma guild e
 * ~10 pessoas o snapshot inteiro cabe numa mensagem — o contrário seria N
 * requisições no boot para responder à pergunta mais barata do app.
 */
export const ChannelReadState = z.object({
  channel_id: z.string(),
  /** última mensagem do canal; null = canal sem mensagem nenhuma */
  last_message_id: z.string().nullable(),
  /** não lidas, já EXCLUINDO as minhas (ninguém tem não-lida de si mesmo) */
  unread_count: z.number().int(),
  /** quantas dessas me mencionam (ou são `@todos`) */
  mention_count: z.number().int(),
});
export type ChannelReadState = z.infer<typeof ChannelReadState>;

/**
 * Ack de leitura (M11a): o fan-out vai SÓ para as outras sessões do próprio
 * usuário. Quem tem o desktop e uma aba abertos não pode ver a badge sumir num
 * e continuar acesa no outro — e ninguém mais tem o que fazer com a informação
 * de que eu li alguma coisa.
 */
export const MessageAckData = z.object({
  channel_id: z.string(),
  last_read_message_id: z.string(),
});
export type MessageAckData = z.infer<typeof MessageAckData>;

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

/**
 * Status de presença (M10, item 56) — substitui o booleano `online`.
 *
 * "offline" acumula dois casos que a UI trata igual e o servidor distingue:
 * sem conexão nenhuma, ou conectado tendo DECLARADO invisível. Não existe um
 * quinto valor "invisible" no fio de propósito: se ele viajasse, bastaria ler o
 * evento para saber quem está escondido — que é exatamente o que invisível
 * promete não contar.
 */
export const PresenceStatus = z.enum(["online", "idle", "dnd", "offline"]);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

export const PresenceUpdateData = z.object({
  user_id: z.string(),
  status: PresenceStatus,
});
export type PresenceUpdateData = z.infer<typeof PresenceUpdateData>;

/** `d` do op 3 (cliente→servidor): o status que ESTA sessão declara. */
export const PresenceUpdateParams = z.object({
  status: PresenceStatus,
});
export type PresenceUpdateParams = z.infer<typeof PresenceUpdateParams>;

/**
 * Membro que saiu da guild (M10, item 52): kick, ban, ou remoção pelo CLI.
 * Sem este evento um kick não some da lista de ninguém até o próximo F5 —
 * e a lista continuaria mostrando alguém que não pode mais entrar.
 */
export const MemberRemoveData = z.object({
  user_id: z.string(),
});
export type MemberRemoveData = z.infer<typeof MemberRemoveData>;

export const ReadyData = z.object({
  session_id: z.string(),
  user: User,
  /** snapshot completo — com uma guild e ~10 pessoas, cabe numa mensagem */
  channels: z.array(Channel),
  members: z.array(User),
  /** snapshot de quem está em voz agora (M3) — só entradas com channel_id preenchido */
  voice_states: z.array(VoiceState),
  /**
   * M10 (item 56): quem está online AGORA e com que status. Antes disto o
   * READY não trazia presença nenhuma: quem entrava só descobria que os amigos
   * estavam online quando um deles reconectava — todo mundo aparecia offline
   * numa guild cheia. Só entradas != "offline" viajam (a ausência é o offline).
   */
  presences: z.array(PresenceUpdateData),
  /** catálogo do soundboard (M9): metadados; os bytes vêm por REST sob demanda */
  sounds: z.array(Sound),
  /**
   * M11a (item 81): não lidas por canal de TEXTO, já resolvidas. Evita N
   * requisições no boot só para saber onde acender uma bolinha.
   */
  read_state: z.array(ChannelReadState),
});
export type ReadyData = z.infer<typeof ReadyData>;

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
  // M11a: leitura reconhecida — só para as outras sessões do MESMO usuário
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MESSAGE_ACK"), d: MessageAckData }),
  // usuário NOVO criado (dev ou OAuth) — re-login de usuário conhecido não dispara
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MEMBER_ADD"), d: User }),
  // M10 (item 52): cargo, apelido ou avatar da guild mudaram — d é o User inteiro
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MEMBER_UPDATE"), d: User }),
  // M10 (item 52): saiu da guild (kick/ban/CLI) — some da lista de todo mundo na hora
  z.object({ op: z.literal(Op.Dispatch), s: z.number().int(), t: z.literal("MEMBER_REMOVE"), d: MemberRemoveData }),
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
  z.object({ op: z.literal(Op.PresenceUpdate), d: PresenceUpdateParams }),
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
  /**
   * M11a: só "user" entra por aqui. O campo existe no corpo (em vez de ser
   * ignorado) para que a recusa seja EXPLÍCITA: um cliente que tentasse
   * forjar "member_join" leva 400 com o motivo, em vez de ver o servidor
   * silenciosamente gravar outra coisa. Mensagem de sistema nasce no
   * servidor, sempre.
   */
  type: z.literal("user").optional(),
});
export type CreateMessageBody = z.infer<typeof CreateMessageBody>;

/**
 * `POST /api/channels/:id/ack` (M11a, item 81) — "li até aqui".
 *
 * O id vem do cliente porque só ele sabe o que de fato apareceu na tela: o
 * servidor não tem como distinguir "a janela está no fundo do canal" de "a aba
 * está no tray há duas horas". O que o servidor garante é que a marca não
 * ANDA PARA TRÁS e não passa da última mensagem do canal.
 */
export const AckMessageBody = z.object({
  message_id: z.string(),
});
export type AckMessageBody = z.infer<typeof AckMessageBody>;

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

// --- convites e moderação (M10, §5 do roadmap) ---

/**
 * `POST /api/invites` (admin+). Os dois campos são opcionais e cada omissão
 * significa "sem limite" — link que nunca expira e serve para sempre é o caso
 * do grupo fechado de amigos, e é o default de propósito.
 *
 * Os TETOS existem para que um link vazado tenha validade finita por acidente,
 * não por disciplina: 30 dias e 100 usos são folgados para 10 pessoas e ainda
 * assim fecham a porta sozinhos.
 */
export const CreateInviteBody = z.object({
  /** segundos até expirar; ausente = nunca (teto de 30 dias) */
  expires_in_s: z.number().int().positive().max(30 * 86_400).optional(),
  /** usos permitidos; ausente = ilimitado */
  max_uses: z.number().int().positive().max(100).optional(),
});
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

/**
 * Motivo opcional de kick/ban. Vai para o `mod_log` e é o que responde "por que
 * fui expulso?" seis meses depois — mas continua opcional: exigir justificativa
 * escrita entre amigos só faria todo mundo digitar "x".
 */
export const ModerationReasonBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ModerationReasonBody = z.infer<typeof ModerationReasonBody>;

/**
 * `POST /api/members/:id/timeout` — silêncio no TEXTO por N minutos.
 * `minutes: 0` limpa o timeout (é como o cliente "desmuta" sem uma rota a mais).
 * Teto de 7 dias: acima disso a ferramenta certa é kick ou ban, não um silêncio
 * que ninguém lembra de tirar.
 */
export const TimeoutBody = z.object({
  minutes: z.number().int().min(0).max(7 * 24 * 60),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type TimeoutBody = z.infer<typeof TimeoutBody>;

/**
 * `PATCH /api/members/:id/role`. "owner" NÃO entra na união: a transferência de
 * dono é operação de outra natureza (mexe em duas linhas e não pode falhar pela
 * metade) e fica fora do M10 — o servidor recusa, e o schema já explica por quê.
 */
export const UpdateRoleBody = z.object({
  role: z.enum(["admin", "member"]),
});
export type UpdateRoleBody = z.infer<typeof UpdateRoleBody>;

/**
 * `PATCH /api/users/@me` — identidade própria da guild (item 55). Campo ausente
 * = não mexe; `null` explícito = limpar e voltar ao que vem do Discord. Os dois
 * casos precisam ser distinguíveis, senão não existe como REMOVER um apelido.
 */
export const UpdateMeBody = z.object({
  nickname: z.string().trim().min(1).max(32).nullable().optional(),
  avatar_override: z.string().url().max(512).nullable().optional(),
});
export type UpdateMeBody = z.infer<typeof UpdateMeBody>;

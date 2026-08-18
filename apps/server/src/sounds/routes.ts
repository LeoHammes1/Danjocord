import type { FastifyInstance, FastifyReply } from "fastify";
import { CreateSoundQuery, PlaySoundBody, UpdateSoundBody } from "@danjocord/protocol";
import { authFromHeader } from "../auth.js";
import { canonicalId } from "../db/snowflake.js";
import type { Gateway } from "../gateway.js";
import type { Store } from "../store.js";
import {
  clampGain,
  MAX_SOUNDS,
  MAX_SOUND_BYTES,
  MAX_SOUND_MS,
  PLAY_CHANNEL_LIMIT,
  PLAY_CHANNEL_WINDOW_MS,
  PLAY_USER_LIMIT,
  PLAY_USER_WINDOW_MS,
  SlidingWindow,
  UPLOAD_LIMIT,
  UPLOAD_WINDOW_MS,
} from "./limits.js";
import { probeAudio } from "./probe.js";

/**
 * REST do soundboard (M9). Mutação por REST e fan-out pelo gateway, como todo o
 * resto (doc §4): quem aperta o pad manda um POST, e o VOICE_SOUNDBOARD que sai
 * carrega só o id — o áudio NÃO passa pelo SFU, cada cliente toca o arquivo
 * localmente (imediato, fora do AEC de todos, sem gastar banda).
 *
 * Esta é a superfície mais perigosa que o projeto já abriu: bytes de usuário
 * entrando no servidor. As defesas, todas server-side:
 *   1. corpo binário CRU com bodyLimit — o Fastify aborta antes de bufferizar
 *      meio mega na memória; nada de multipart (que exigiria dependência nova);
 *   2. container sniffado por MAGIC BYTES, nunca por Content-Type/extensão;
 *   3. duração MEDIDA aqui (probe.ts), nunca a que o cliente declara;
 *   4. o GET de áudio devolve o mime GUARDADO — servir text/html na mesma
 *      origem do app seria XSS de graça (o `x-content-type-options: nosniff`
 *      global do index.ts é a segunda linha, não a primeira);
 *   5. teto de sons e rate limit por usuário checados ANTES de ler o corpo.
 */

/** Dependências que a rota de tocar precisa e que não moram no banco. */
export interface SoundRoutesDeps {
  /**
   * Em que canal de voz o usuário está AGORA, na visão do SERVIDOR (null =
   * fora). Vem do módulo de voz pelo wiring do index.ts — a rota não conhece o
   * mediasoup, e o cliente não escolhe o canal onde toca.
   */
  voiceChannelOf: (userId: string) => string | null;
}

/**
 * Content-Types que o upload aceita. `application/octet-stream` é o caminho
 * padrão; os mimes de áudio entram porque um `fetch(file)` manda o `file.type`
 * do navegador sem pensar. Nenhum deles é levado a sério além disto: o
 * container é decidido pelos magic bytes.
 */
const RAW_UPLOAD_TYPES = [
  "application/octet-stream",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mpeg",
  "audio/mp3",
];

export function registerSoundRoutes(
  app: FastifyInstance,
  store: Store,
  gateway: Gateway,
  deps: SoundRoutesDeps,
): void {
  // Corpo binário cru. O Fastify 5 só entende JSON e texto de fábrica, e
  // multipart exigiria plugin — com metadados na query, o parser abaixo é tudo
  // que falta. `bodyLimit` aqui é a defesa que importa: o Fastify corta o
  // stream ao passar do teto (413) em vez de acumular na memória.
  app.addContentTypeParser(
    RAW_UPLOAD_TYPES,
    { parseAs: "buffer", bodyLimit: MAX_SOUND_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Janelas em memória (o projeto não tem rate limit em lugar nenhum — roadmap
  // 117; estas são as primeiras). Restart zera, e tudo bem.
  const uploadWindow = new SlidingWindow(UPLOAD_LIMIT, UPLOAD_WINDOW_MS);
  const playUserWindow = new SlidingWindow(PLAY_USER_LIMIT, PLAY_USER_WINDOW_MS);
  const playChannelWindow = new SlidingWindow(PLAY_CHANNEL_LIMIT, PLAY_CHANNEL_WINDOW_MS);

  app.get("/api/sounds", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });
    return store.listSounds();
  });

  app.post(
    "/api/sounds",
    {
      // teto de corpo também na ROTA: se algum dia alguém subir o limite do
      // parser, esta linha continua valendo para este endpoint
      bodyLimit: MAX_SOUND_BYTES,
      // onRequest roda ANTES de ler o corpo: quem já estourou a cota, ou vai
      // esbarrar no teto de 100 sons, é recusado sem transferir 512 KB
      onRequest: async (req, reply) => {
        const user = authFromHeader(req.headers.authorization, store);
        if (!user) return reply.code(401).send({ error: "não autenticado" });
        if (store.countSounds() >= MAX_SOUNDS) {
          return reply.code(409).send({ error: `a guild já tem ${MAX_SOUNDS} sons — apague um antes` });
        }
        const wait = uploadWindow.retryAfterMs(user.id);
        if (wait > 0) return tooManyRequests(reply, wait, "muitos uploads seguidos");
      },
    },
    async (req, reply) => {
      const user = authFromHeader(req.headers.authorization, store);
      if (!user) return reply.code(401).send({ error: "não autenticado" });
      // a TENTATIVA consome a cota (e não só o sucesso): senão mandar lixo
      // repetidamente seria de graça, que é justamente o abuso barato
      uploadWindow.record(user.id);

      const raw = req.query as { name?: string; gain?: string };
      const query = CreateSoundQuery.safeParse({
        name: raw.name,
        // ?gain= (vazio) é "não mandei ganho" — sem isto o coerce faria virar 0
        gain: raw.gain === "" ? undefined : raw.gain,
      });
      if (!query.success) {
        return reply.code(400).send({ error: "nome inválido (1 a 32 caracteres) ou ganho não numérico" });
      }

      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply.code(400).send({ error: "corpo vazio — mande o arquivo cru no corpo do POST" });
      }
      // o bodyLimit já cortaria antes; esta é a defesa em profundidade para o
      // dia em que o parser mudar
      if (bytes.length > MAX_SOUND_BYTES) {
        return reply.code(413).send({ error: `som acima de ${Math.floor(MAX_SOUND_BYTES / 1024)} KB` });
      }

      let probe;
      try {
        probe = probeAudio(bytes);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "arquivo de áudio inválido" });
      }
      if (probe.durationMs > MAX_SOUND_MS) {
        return reply.code(400).send({
          error: `som de ${(probe.durationMs / 1000).toFixed(1)} s — o teto é ${MAX_SOUND_MS / 1000} s`,
        });
      }

      // corrida rara (dois uploads no mesmo instante) revalidada aqui: o
      // onRequest checou o teto antes de ler o corpo, e ler leva tempo
      if (store.countSounds() >= MAX_SOUNDS) {
        return reply.code(409).send({ error: `a guild já tem ${MAX_SOUNDS} sons — apague um antes` });
      }

      const sound = store.createSound({
        name: query.data.name,
        uploaderId: user.id,
        mime: probe.mime,
        bytes,
        durationMs: probe.durationMs,
        gain: clampGain(query.data.gain),
      });
      gateway.broadcast("SOUND_CREATE", sound);
      return reply.code(201).send(sound);
    },
  );

  app.patch("/api/sounds/:soundId", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const soundId = canonicalId((req.params as { soundId: string }).soundId);
    const sound = soundId === null ? null : store.getSound(soundId);
    if (!sound || soundId === null) return reply.code(404).send({ error: "som não encontrado" });
    // autor mexe no que é seu; admin mexe em tudo (mesma regra do DELETE de
    // mensagem, M2). Embutido não tem autor: sobra o admin.
    if (sound.uploader_id !== user.id && !store.isAdmin(user.id)) {
      return reply.code(403).send({ error: "sem permissão para renomear" });
    }

    const body = UpdateSoundBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "nome inválido (1 a 32 caracteres)" });

    const updated = store.renameSound(soundId, body.data.name);
    if (!updated) return reply.code(404).send({ error: "som não encontrado" });
    gateway.broadcast("SOUND_UPDATE", updated);
    return reply.code(200).send(updated);
  });

  app.delete("/api/sounds/:soundId", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const soundId = canonicalId((req.params as { soundId: string }).soundId);
    const sound = soundId === null ? null : store.getSound(soundId);
    if (!sound || soundId === null) return reply.code(404).send({ error: "som não encontrado" });
    if (sound.uploader_id !== user.id && !store.isAdmin(user.id)) {
      return reply.code(403).send({ error: "sem permissão para apagar" });
    }

    store.deleteSound(soundId);
    // id da LINHA, não do path: é o canônico que os clientes conhecem
    gateway.broadcast("SOUND_DELETE", { id: sound.id });
    return reply.code(204).send();
  });

  /**
   * Os bytes. Cache imutável porque o id é snowflake e o conteúdo NUNCA muda —
   * renomear não toca no áudio, e apagar libera o id para sempre. O cliente
   * baixa uma vez por som e guarda o AudioBuffer decodificado.
   */
  app.get("/api/sounds/:soundId/audio", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const soundId = canonicalId((req.params as { soundId: string }).soundId);
    const audio = soundId === null ? null : store.getSoundAudio(soundId);
    if (!audio) return reply.code(404).send({ error: "som não encontrado" });

    // content-type GUARDADO (o que o probe decidiu no upload), jamais um vindo
    // do request; nosniff repetido aqui porque a rota tem que ser segura mesmo
    // se alguém remover o hook global do index.ts
    reply.header("content-type", audio.mime);
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("content-length", String(audio.bytes.length));
    return reply.send(audio.bytes);
  });

  /**
   * Tocar. O canal vem do estado de voz do SERVIDOR: fora da voz é 403 — sem
   * isso qualquer sessão faria barulho num canal onde nem está (roadmap 24).
   */
  app.post("/api/voice/soundboard", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const body = PlaySoundBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });
    const soundId = canonicalId(body.data.sound_id);
    const sound = soundId === null ? null : store.getSound(soundId);
    if (!sound) return reply.code(404).send({ error: "som não encontrado" });

    const channelId = deps.voiceChannelOf(user.id);
    if (channelId === null) return reply.code(403).send({ error: "entre num canal de voz para tocar" });

    // as duas janelas são consultadas ANTES de qualquer registro: se o canal
    // barrar, o cooldown pessoal de quem nem chegou a tocar não pode ser gasto
    const userWait = playUserWindow.retryAfterMs(user.id);
    if (userWait > 0) return tooManyRequests(reply, userWait, "espere um pouco antes do próximo som");
    const channelWait = playChannelWindow.retryAfterMs(channelId);
    if (channelWait > 0) return tooManyRequests(reply, channelWait, "muitos sons neste canal agora");
    playUserWindow.record(user.id);
    playChannelWindow.record(channelId);

    // fan-out do ID e nada mais: o playback é LOCAL em cada cliente do canal
    gateway.broadcast("VOICE_SOUNDBOARD", { user_id: user.id, channel_id: channelId, sound_id: sound.id });
    return reply.code(204).send();
  });
}

/**
 * 429 com `retry_after` em SEGUNDOS no corpo (como o Discord) e o header
 * `Retry-After` inteiro para quem só olha protocolo.
 */
function tooManyRequests(reply: FastifyReply, waitMs: number, message: string): FastifyReply {
  const seconds = waitMs / 1000;
  reply.header("retry-after", String(Math.max(1, Math.ceil(seconds))));
  return reply.code(429).send({ error: message, retry_after: Number(seconds.toFixed(3)) });
}


import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { authFromHeader } from "./auth.js";
import { SlidingWindow, tooManyRequests } from "./limits.js";
import type { Store } from "./store.js";

/**
 * Rate limit GERAL do REST (roadmap 117, segunda metade).
 *
 * O gateway ganhou freios no M12 (op 20 a 60/s, op 3 a 10/s, tetos de sessão e
 * de ring buffer) e cinco rotas tinham janela própria. O REST em geral não
 * tinha nada: mandar mensagem, editar, apagar, ler histórico, buscar, baixar
 * anexo e o "está digitando" eram ilimitados — e quase todos terminam em
 * `gateway.broadcast`, que faz `JSON.stringify` POR SESSÃO. A amplificação já
 * era conhecida (é o que motivou os freios do gateway); faltava a porta REST.
 *
 * ---------------------------------------------------------------------------
 * A CHAVE É O USUÁRIO. NUNCA O IP. Isto não é preferência — é medição.
 * ---------------------------------------------------------------------------
 *
 * Medido contra o pod de produção (três requisições: uma sem `x-forwarded-for`,
 * uma com `1.1.1.1`, uma com três saltos forjados). O servidor registrou
 * `remoteAddress = 10.42.0.0` nas TRÊS. O Service do Traefik usa
 * `externalTrafficPolicy: Cluster`, então o kube-proxy faz SNAT ANTES do proxy
 * — o Traefik nunca chega a ver um IP de cliente para pôr no `x-forwarded-for`,
 * e o `trustProxy: 1` do `index.ts` descarta o que o cliente escreveu.
 *
 * Duas conclusões, e as duas importam:
 *   - não há BYPASS por header forjado (o `trustProxy` faz o que promete);
 *   - mas o IP é um BALDE ÚNICO para o mundo inteiro. Chavear por ele é dar a
 *     qualquer estranho o poder de trancar os dez amigos para fora.
 *
 * Esse bug já aconteceu aqui: o rate limit de `/auth/discord/start` por
 * `req.ip` trancava TODO MUNDO do login, e foi removido (`oauth.ts`). A linha
 * que o reintroduz é `user?.id ?? req.ip`, e é a coisa mais natural do mundo de
 * se escrever. Ela não existe neste arquivo de propósito.
 *
 * ---------------------------------------------------------------------------
 * ROTA NOVA SEM CLASSE NÃO SOBE
 * ---------------------------------------------------------------------------
 *
 * A classificação é por PADRÃO de rota (`/api/x/:id`), carimbada num hook
 * `onRoute` no registro, e a tabela abaixo é exaustiva: rota que não está nela
 * faz o boot LANÇAR, no mesmo espírito do `JWT_SECRET` faltando. O modo de
 * falha da alternativa (um default silencioso) é uma rota nova nascer ilimitada
 * sem ninguém notar — que é exatamente o estado que este arquivo termina.
 */

/** Classes de custo. `isento` e `proprio` não passam por janela nenhuma aqui. */
export type LimitClass = "isento" | "proprio" | "leitura" | "midia" | "escrita" | "typing" | "moderacao";

/**
 * A tabela. Chave = `METODO padrão-da-rota`.
 *
 * `proprio` = a rota já tem limitador dela, que cobre a requisição inteira.
 * Contar de novo aqui seria cobrança dupla — e não é teórico: levar 429 do
 * soundboard (um som por 2 s) é o caso NORMAL de quem aperta o pad duas vezes,
 * e cada recusa esperada gastaria vaga do balde geral sem um som tocar.
 */
const TABELA: Record<string, LimitClass> = {
  // --- isentos, um a um, com o motivo ---
  // O kubelet bate aqui a cada 10 s (readiness) e 15 s (liveness), com
  // failureThreshold 3 por default. Um 429 aqui tira o pod dos Endpoints em
  // ~30 s — o Traefik passa a devolver 503 para todo mundo com o processo
  // perfeitamente vivo — e o mata em ~45 s. Com `replicas: 1` e `Recreate`, é a
  // chamada de voz caindo em laço. É o isento mortal.
  "GET /healthz": "isento",
  // A SPA: uma carga fria são ~17 GETs, 14 deles no mesmo tick (os clipes de
  // som). Qualquer limite abaixo disso reprova o app ABRINDO.
  "GET /*": "isento",
  // As portas de autenticação. Não existe `user.id` para chavear ANTES do
  // login, então todo limite aqui seria global — e limite global na porta de
  // login é literalmente o bug removido do `oauth.ts`. Agravante: o op 7 do
  // deploy manda todo mundo reconectar junto, e o pico de `/auth/refresh` é
  // ×10, não ×1.
  "POST /auth/session": "isento",
  "POST /auth/refresh": "isento",
  "POST /auth/logout": "isento",
  "POST /auth/dev": "isento",
  "GET /auth/discord/start": "isento",
  "GET /auth/discord/callback": "isento",
  // Única rota sem auth nenhuma. Mantém a janela própria dela (por IP, global
  // neste ambiente — assumido e documentado lá).
  "GET /api/invites/:code": "isento",
  // TIRAR a própria reação. Estava marcado `proprio`, e era mentira: a janela
  // do `reactions.ts` só é consultada no PUT. Fica isento com o motivo escrito,
  // que já está lá desde o M11b — prender o DELETE deixaria alguém preso a uma
  // reação que quer desfazer, e o balde `escrita` (90/min) é MENOR que as 120
  // reações/min que o próprio limitador do PUT autoriza criar.
  //
  // E é barato de verdade, não por suposição: medido, 800 DELETEs que não casam
  // linha nenhuma fazem o `-wal` crescer ZERO byte (o SQLite abre a transação,
  // não suja página e commita sem frame), e o broadcast só sai quando removeu
  // de fato — 800 chamadas, 1 evento.
  "DELETE /api/channels/:channelId/messages/:messageId/reactions/:emoji/@me": "isento",

  // --- rotas com limitador próprio ---
  // As duas do feed de atualização (M14) NÃO trazem Bearer: a credencial delas
  // é um tíquete na query, porque quem as chama é uma NAVEGAÇÃO do navegador
  // (que não sabe do localStorage) e o electron-updater (cujo executor HTTP
  // repassaria um Authorization ao seguir o nosso 302 para o CDN do GitHub).
  // Deixá-las na classe `leitura` faria o hook geral responder 401 antes de
  // qualquer uma funcionar. A janela delas está em `updates/routes.ts` e chaveia
  // pelo usuário DONO do tíquete — a mesma chave honesta que o hook usaria.
  "GET /api/updates/download": "proprio",
  "GET /api/updates/feed/:file": "proprio",
  // As duas do CI: autenticadas por um token de MÁQUINA, num `onRequest` de
  // rota que roda antes do parser de corpo — um POST sem token não escreve um
  // byte no disco. Janela própria, chaveada em "publish" (não há usuário).
  "POST /api/updates/publish": "proprio",
  "POST /api/updates/publish/commit": "proprio",
  "POST /api/attachments": "proprio",
  "POST /api/sounds": "proprio",
  "POST /api/voice/soundboard": "proprio",
  "PUT /api/channels/:channelId/messages/:messageId/reactions/:emoji/@me": "proprio",

  // --- leitura ---
  // O preview é o único caso de cobrança dupla DELIBERADA: a janela própria
  // dele roda DEPOIS do cache, então acerto de cache (uma query por PK) não
  // gasta cota nenhuma e hoje é ilimitado. Mover o `record` para antes do cache
  // quebraria uso legítimo — os previews são lazy por IntersectionObserver e um
  // scroll por histórico com muitos links passa da janela. As duas cobranças
  // resolvem: a específica morde no caminho caro, esta cobre o barato.
  "GET /api/link-preview": "leitura",
  "GET /api/channels/:channelId/messages": "leitura",
  "GET /api/search": "leitura",
  "GET /api/users/:userId": "leitura",
  "GET /api/sounds": "leitura",
  "GET /api/invites": "leitura",
  "GET /api/bans": "leitura",
  "GET /api/mod-log": "leitura",
  "POST /api/channels/:channelId/ack": "leitura",
  // M14. As duas são baratas (uma leitura de cache e um `randomBytes`) e a
  // frequência legítima é ridícula — uma por login e uma a cada 6 h de app
  // aberto. Ficam na `leitura` por serem o que são, não por precisarem de um
  // orçamento próprio.
  "GET /api/updates/latest": "leitura",
  "POST /api/updates/ticket": "leitura",

  // --- mídia (bytes de BLOB) ---
  // Separadas da `leitura` porque o download de anexo NÃO é lazy: ele sai no
  // render (`renderAttachment` → `attachmentObjectUrl`), e cada mensagem carrega
  // até 10 anexos — uma página de 50 mensagens pode disparar centenas de GETs
  // de uma vez, não 50. No mesmo balde da
  // paginação, rolar um canal com fotos estouraria a cota lendo o histórico —
  // um limite que o próprio cliente estoura em uso normal é um bug.
  "GET /api/attachments/:attachmentId": "midia",
  "GET /api/sounds/:soundId/audio": "midia",

  // --- escrita ---
  "POST /api/channels/:channelId/messages": "escrita",
  "PATCH /api/channels/:channelId/messages/:messageId": "escrita",
  "DELETE /api/channels/:channelId/messages/:messageId": "escrita",
  "PATCH /api/users/@me": "escrita",
  "PATCH /api/sounds/:soundId": "escrita",
  "DELETE /api/sounds/:soundId": "escrita",

  // --- o "está digitando" ---
  "POST /api/channels/:channelId/typing": "typing",

  // --- moderação ---
  "POST /api/invites": "moderacao",
  "DELETE /api/invites/:code": "moderacao",
  "POST /api/members/:id/kick": "moderacao",
  "POST /api/members/:id/ban": "moderacao",
  "POST /api/members/:id/timeout": "moderacao",
  "PATCH /api/members/:id/role": "moderacao",
  "DELETE /api/bans/:discordId": "moderacao",
};

/**
 * Os números. Cada um é "pior caso legítimo do CLIENTE" vezes uma folga — um
 * limite que o próprio cliente estoura em uso normal é um bug, não uma defesa.
 * As contas vêm das constantes do cliente, citadas em cada linha.
 */
export const ORCAMENTOS: Record<string, { limite: number; janelaMs: number; frase: string }> = {
  // paginação (~60 páginas/min arrastando a barra sem parar) + ack (debounce de
  // 500 ms mais rajada ao trocar de canal, ~30/min) + busca (debounce de 250
  // ms, ~20/min) + diversos ~10/min = ~120/min legítimo. Folga 2×.
  leitura: { limite: 240, janelaMs: 60_000, frase: "muitas leituras seguidas" },
  // Conta REQUISIÇÕES, não bytes — e isso é uma limitação declarada, não um
  // descuido. Pior caso legítimo: arrastar a barra sem parar (~60 páginas/min)
  // num canal em que boa parte das mensagens tem foto dá algumas centenas de
  // GETs/min, e o cache de 48 blobs do cliente só cobre a cauda. 900 acomoda
  // isso e ainda corta o laço automatizado.
  //
  // O QUE ISTO NÃO DEFENDE: banda. 900 requisições podem ser 900 arquivos de
  // 8 MB. Cobrir isso exige cobrar por MB no `onResponse` (a checagem é antes,
  // a cobrança depois — uma rajada única passa inteira), e essa é a próxima
  // rodada, não esta. O que segura hoje é o teto de 512 MB de anexos da guild
  // inteira e o fato de a rota exigir credencial de membro.
  midia: { limite: 900, janelaMs: 60_000, frase: "muitos downloads seguidos" },
  // ~49/min de teto legítimo pessimista (edições, apagamentos, perfil, sons).
  // Folga ~1,8×.
  escrita: { limite: 90, janelaMs: 60_000, frase: "muitas escritas seguidas" },
  // A conta de "~15/min" que estava aqui esquecia metade do mecanismo: o
  // throttle é de 8 s, MAS enviar a mensagem ZERA o cursor (é deliberado — sem
  // isso, recomeçar a digitar logo depois de enviar deixaria os outros sem
  // indicador). Ou seja, cada mensagem enviada custa um POST de typing a mais,
  // e o pior caso legítimo é a taxa de mensagens: os ~30 msg/min que o
  // MENSAGEM_LIMITE logo abaixo declara como humano rápido. Com 30 aqui a folga
  // era 1,0× — a única classe do arquivo sem margem, e um papo rápido raspava
  // no teto. 60 põe a folga em 2×, igual às outras.
  typing: { limite: 60, janelaMs: 60_000, frase: "muitos avisos de digitação" },
  // Frequência legítima muito abaixo de 1/min, e o ator é sempre staff. A folga
  // é absurda de propósito: o valor aqui é capar o `evict()` — a chamada mais
  // cara do REST inteiro (banco + WebSocket + mediasoup + mensagem de sistema +
  // dois broadcasts) — e a criação de convites em laço por um admin
  // comprometido.
  moderacao: { limite: 20, janelaMs: 60_000, frase: "muitas ações de moderação seguidas" },
};

/**
 * Sub-janela só do POST de mensagem, ALÉM da classe `escrita`. É a escrita mais
 * cara sem freio (mais de uma dezena de queries, fan-out para todas as sessões
 * e até 4000 chars), e o que interessa nela é a RAJADA, não o minuto: um humano
 * rápido faz ~30 msg/min, então 10 por 10 s é 1/s sustentado, folga 2×. (O
 * Discord usa 5 por 5 s.)
 */
export const MENSAGEM_LIMITE = 10;
export const MENSAGEM_JANELA_MS = 10_000;
const CHAVE_MENSAGEM = "POST /api/channels/:channelId/messages";

/** O que o `onRoute` carimba no `config` da rota. */
interface ConfigComClasse {
  limitClass?: LimitClass;
  /** o @fastify/static põe isto em cada arquivo servido — é como o reconhecemos */
  rootPath?: string;
}

/** `METODO caminho`, com HEAD normalizado para GET (o Fastify cria o par). */
function chaveDaRota(method: string, url: string): string {
  return `${method === "HEAD" ? "GET" : method} ${url}`;
}

export function classeDaRota(method: string, url: string, config: ConfigComClasse): LimitClass {
  // Rota de arquivo estático: o @fastify/static registra UMA rota por arquivo
  // (`wildcard: false`), então elas não cabem numa tabela — mas todas trazem
  // `rootPath` no config. Reconhecimento ESTRUTURAL, não por string de caminho.
  if (config.rootPath !== undefined) return "isento";
  // O `OPTIONS *` que o @fastify/cors registra. Na ordem certa (este hook
  // depois do cors) o preflight nem chega aqui; a linha existe para o dia em
  // que alguém "organizar" os hooks — ver a nota no `registerRateLimit`.
  if (method === "OPTIONS") return "isento";
  const classe = TABELA[chaveDaRota(method, url)];
  if (classe === undefined) {
    throw new Error(
      `rate-limit: a rota "${method} ${url}" não está na tabela de classes (apps/server/src/rate-limit.ts). ` +
        "Toda rota precisa de uma classe — inclusive \"isento\". Um default silencioso seria uma rota nova " +
        "nascendo ilimitada sem ninguém notar.",
    );
  }
  return classe;
}

/** Classes que NÃO passam por janela. Todo o resto precisa de orçamento. */
const SEM_JANELA: LimitClass[] = ["isento", "proprio"];

export function registerRateLimit(app: FastifyInstance, store: Store): void {
  const janelas = new Map<string, SlidingWindow>();
  for (const [nome, o] of Object.entries(ORCAMENTOS)) {
    janelas.set(nome, new SlidingWindow(o.limite, o.janelaMs));
  }
  // O mesmo buraco que a tabela fecha para ROTAS, fechado para CLASSES: sem
  // isto, acrescentar uma classe ao `LimitClass` e esquecer o orçamento fazia o
  // hook cair num `return` silencioso e a rota nascer ilimitada — exatamente o
  // modo de falha que o resto do arquivo existe para impedir, uma camada acima.
  for (const classe of Object.keys(TABELA).map((k) => TABELA[k]!)) {
    if (SEM_JANELA.includes(classe) || janelas.has(classe)) continue;
    throw new Error(`rate-limit: a classe "${classe}" é contada mas não tem orçamento em ORCAMENTOS.`);
  }
  const janelaMensagem = new SlidingWindow(MENSAGEM_LIMITE, MENSAGEM_JANELA_MS);

  // Carimbo no REGISTRO: o `onRoute` roda uma vez por rota, no boot, então a
  // busca na tabela não acontece por requisição — e é aqui que a rota sem
  // classe derruba o boot, em vez de virar um 500 no primeiro acesso.
  app.addHook("onRoute", (rota: RouteOptions) => {
    const metodos = Array.isArray(rota.method) ? rota.method : [rota.method];
    const config = (rota.config ?? {}) as ConfigComClasse;
    // método desconhecido no conjunto derruba o boot — de propósito
    const classes = metodos.map((m) => classeDaRota(m, rota.url, config));
    // Método diferente com classe diferente na mesma rota não existe hoje; se
    // um dia existir, a MAIS CARA vence — nunca a mais frouxa.
    const ordem: LimitClass[] = ["moderacao", "escrita", "typing", "leitura", "midia", "proprio", "isento"];
    const escolhida = ordem.find((c) => classes.includes(c)) ?? "isento";
    rota.config = { ...(rota.config ?? {}), limitClass: escolhida };
  });

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const config = (req.routeOptions.config ?? {}) as ConfigComClasse;
    const url = req.routeOptions.url;
    // rota inexistente (404) não casa padrão nenhum: não é nossa para limitar
    if (url === undefined) return;
    // O carimbo do `onRoute` é o caminho normal. O `?? classeDaRota(...)` NÃO é
    // paranoia: o `onRoute` só enxerga rota registrada DEPOIS dele, então
    // chamar `registerRateLimit` no fim do boot deixaria todas as rotas sem
    // carimbo — e o limite inteiro viraria no-op EM SILÊNCIO, que é o mesmo
    // modo de falha que a tabela existe para impedir. Descoberto por um teste
    // que montava o app nessa ordem; agora existe um teste para cada ordem.
    const classe = config.limitClass ?? classeDaRota(req.method, url, config);
    if (classe === "isento" || classe === "proprio") return;

    // A chave. Sem Bearer válido não há chave HONESTA neste ambiente (ver o
    // topo do arquivo), então a requisição não entra em janela nenhuma — ela
    // leva 401 aqui mesmo. E aqui é cedo: `onRequest` roda ANTES do parser de
    // corpo, então uma enxurrada anônima custa roteamento e um `startsWith`,
    // sem os megabytes entrarem em memória.
    const user = authFromHeader(req.headers.authorization, store);
    if (user === null) return reply.code(401).send({ error: "não autenticado" });

    const orcamento = ORCAMENTOS[classe];
    const janela = janelas.get(classe);
    if (orcamento === undefined || janela === undefined) return;

    // Consultar TODAS as janelas antes de gravar em QUALQUER uma: se a segunda
    // barrar, a primeira não pode ter consumido cota. Mesma invariante que o
    // `limits.ts` documenta para o som (usuário × canal), pelo mesmo motivo.
    const ehMensagem = chaveDaRota(req.method, url) === CHAVE_MENSAGEM;
    const esperaClasse = janela.retryAfterMs(user.id);
    const esperaMensagem = ehMensagem ? janelaMensagem.retryAfterMs(user.id) : 0;
    if (esperaClasse > 0 || esperaMensagem > 0) {
      // a frase diz QUAL classe estourou: sem isso, um 429 no histórico e um no
      // envio de mensagem são indistinguíveis num relato de bug
      const frase = esperaMensagem > 0 ? "muitas mensagens seguidas" : orcamento.frase;
      return tooManyRequests(reply, Math.max(esperaClasse, esperaMensagem), frase);
    }
    janela.record(user.id);
    if (ehMensagem) janelaMensagem.record(user.id);
    return;
  });
}

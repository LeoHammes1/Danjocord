/**
 * A landing do convite (M10, item 47): a tela que um amigo vê ao abrir
 * `<origem>/invite/<code>` — ANTES de existir conta, sessão ou token.
 *
 * É a PRIMEIRA coisa que alguém de fora vê deste servidor. Jogar a tela de
 * login genérica ("Entrar com Discord", sem contexto) na cara de quem clicou
 * num link do WhatsApp é a pior recepção possível: a pessoa não sabe onde
 * caiu, quem chamou, nem se é o lugar certo. Por isso a landing busca o
 * preview PÚBLICO do convite e diz, em português e sem jargão, quem convidou e
 * para onde.
 *
 * TRÊS COISAS QUE MANDAM NO DESENHO DESTE ARQUIVO:
 *
 * 1. **Nada de auth.** Nenhum `getAccessToken`, nenhum header `Authorization`,
 *    nenhum refresh. `GET /api/invites/:code` é a única rota pública do
 *    projeto, e ela devolve de propósito quase nada (nome da guild e de quem
 *    convidou): um código vazado não pode virar raio-x do servidor.
 * 2. **O erro é o conteúdo principal, não uma nota de rodapé.** Link expirado,
 *    esgotado, revogado e inexistente são situações DIFERENTES e a pessoa não
 *    tem como saber qual é — ela só sabe que "não funcionou". Cada uma ganha
 *    frase própria e, sobretudo, o que fazer a seguir.
 * 3. **O código precisa sobreviver ao ida-e-volta do OAuth.** Ele não fica
 *    guardado aqui: vai como `?invite=<code>` para o `/auth/discord/start`, e
 *    o servidor o amarra ao `state` assinado. Guardar em localStorage ou em
 *    cookie solto seria justamente o caminho para trocarem o código no meio.
 *
 * Não há roteador neste cliente (decisão do M7: TypeScript puro, DOM
 * imperativo). O "roteamento" é `inviteCodeFromLocation()` no boot — uma
 * função pura, testável, que olha o `location.pathname` e nada mais.
 */
import { z } from "zod";
import { InvitePreview } from "@danjocord/protocol";
import { API } from "../auth.js";
import { desktop } from "../bridge.js";
import { brasao } from "./brasao.js";
import { el } from "./dialog.js";

// ---------------------------------------------------------------------------
// Roteamento (o pouco que existe)
// ---------------------------------------------------------------------------

/**
 * Alfabeto e tamanho conferem com o gerador do servidor (`randomBytes` num
 * alfabeto sem 0/O e 1/l/I). A faixa é folgada de propósito: se o servidor
 * mudar o tamanho do código, um regex apertado aqui viraria "convite
 * inexistente" para links perfeitamente bons. O que ele barra é lixo — `/invite/`
 * vazio, caminho com barra a mais, tentativa de path traversal.
 */
const CODE = /^\/invite\/([A-Za-z0-9]{4,32})\/?$/;

/**
 * Extrai o código de `/invite/<code>`, ou null se a URL não for uma landing de
 * convite. Pura (o `pathname` entra por parâmetro) para poder ser exercitada
 * sem navegador.
 */
export function inviteCodeFromLocation(pathname: string = location.pathname): string | null {
  return CODE.exec(pathname)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// O preview público
// ---------------------------------------------------------------------------

/**
 * Por que o convite não serve. Espelha o `InviteProblem` do servidor — a
 * landing só consegue dizer "expirou" em vez de "não vale" se o 410 trouxer
 * qual foi o problema. Vem OPCIONAL: se o corpo não disser (ou não for JSON), a
 * landing cai numa frase honesta e genérica em vez de chutar.
 */
const ProblemBody = z.object({
  problem: z.enum(["unknown", "revoked", "expired", "exhausted", "banned"]).optional(),
  error: z.string().optional(),
});

type Problem = NonNullable<z.infer<typeof ProblemBody>["problem"]> | "gone";

type LandingState =
  | { kind: "loading" }
  | { kind: "ok"; preview: InvitePreview }
  | { kind: "bad"; problem: Problem }
  | { kind: "offline" };

async function fetchPreview(code: string): Promise<LandingState> {
  let res: Response;
  try {
    // sem header nenhum: é a rota pública, e mandar um Authorization velho
    // daqui só serviria para vazar um token para uma rota que não o pede
    res = await fetch(`${API}/api/invites/${encodeURIComponent(code)}`, { method: "GET" });
  } catch {
    return { kind: "offline" };
  }
  if (res.ok) {
    try {
      // schema Zod na entrada, como todo payload do projeto — e aqui em
      // dobro: esta resposta chega sem sessão nenhuma por trás
      return { kind: "ok", preview: InvitePreview.parse(await res.json()) };
    } catch {
      // 200 com corpo estranho (proxy que responde HTML): tratar como servidor
      // fora é mais honesto do que renderizar um convite sem nome
      return { kind: "offline" };
    }
  }
  if (res.status === 404) return { kind: "bad", problem: "unknown" };
  if (res.status === 410) {
    let problem: Problem = "gone";
    try {
      problem = ProblemBody.parse(await res.json()).problem ?? "gone";
    } catch {
      // corpo ausente ou fora do formato: fica o genérico do 410
    }
    return { kind: "bad", problem };
  }
  // 5xx, 502 do Traefik durante um deploy, rate limit: nada disso é culpa do
  // convite, e dizer "expirado" aqui mandaria a pessoa pedir um link novo à toa
  return { kind: "offline" };
}

// ---------------------------------------------------------------------------
// Texto
//
// Cada erro diz O QUE aconteceu e O QUE FAZER. "Peça um link novo para quem te
// chamou" é a ação certa em quase todos — e é exatamente o que ninguém pensa
// sozinho ao ver uma tela de erro.
// ---------------------------------------------------------------------------

interface Copy {
  title: string;
  body: string;
}

function problemCopy(problem: Problem): Copy {
  switch (problem) {
    case "unknown":
      return {
        title: "Esse link não existe",
        body: "Confira se o endereço veio inteiro — links quebram quando são cortados na mensagem. Se estiver certo, peça um link novo para quem te chamou.",
      };
    case "expired":
      return {
        title: "Esse convite expirou",
        body: "Convites têm prazo. Peça um link novo para quem te chamou — leva dois segundos para gerar outro.",
      };
    case "exhausted":
      return {
        title: "Esse convite já foi todo usado",
        body: "Ele valia para um número limitado de pessoas e o limite acabou. Peça um link novo para quem te chamou.",
      };
    case "revoked":
      return {
        title: "Esse convite foi cancelado",
        body: "Quem criou o link desfez ele. Se você acha que foi engano, fale com a pessoa que te chamou.",
      };
    case "banned":
      return {
        title: "Você não pode entrar neste servidor",
        body: "O acesso desta conta foi bloqueado por um administrador. Nenhum convite muda isso.",
      };
    case "gone":
      return {
        title: "Esse convite não vale mais",
        body: "Ele pode ter expirado, atingido o limite de usos ou sido cancelado. Peça um link novo para quem te chamou.",
      };
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface InviteLandingOptions {
  /**
   * Como começar o login levando o convite junto. Só o main.ts sabe se o
   * ambiente é web ou desktop, e no desktop o fluxo é outro (loopback do M6).
   * Ausente = caminho web: redirecionar para `/auth/discord/start?invite=…`.
   */
  onEnter?: (code: string) => void;
  /**
   * "Já tenho conta, quero só entrar." A landing se remove sozinha antes de
   * chamar — cabe ao main.ts mostrar o login (ou o app, se já houver sessão).
   */
  onDismiss?: () => void;
}

let root: HTMLElement | null = null;
/** corrida: só a resposta do último fetch pode pintar a tela */
let renderToken = 0;

/** Onde o texto de estado mora, para o foco e o leitor de tela acharem. */
function card(): HTMLElement {
  const box = el("div", "inv-landing-card");
  // recebe o foco a cada troca de estado: sem isto, quem usa leitor de tela
  // ouve a página em branco carregar e nunca sabe que o convite foi checado
  box.tabIndex = -1;
  return box;
}

function mountRoot(): HTMLElement {
  if (root !== null) return root;
  const node = el("div");
  node.id = "invite-landing";
  // é a tela inteira e é a única coisa viva na página: as duas views do
  // index.html saem de cena para não sobrar um formulário de login por baixo
  // (elas nascem [hidden], mas um F5 no meio do fluxo já deixou o #app aberto)
  document.getElementById("login")?.setAttribute("hidden", "");
  document.getElementById("app")?.setAttribute("hidden", "");
  document.body.append(node);
  root = node;
  return node;
}

/** Tira a landing e devolve a barra de endereço à raiz. */
export function closeInviteLanding(): void {
  renderToken++; // um fetch em voo não pode ressuscitar a tela depois disto
  root?.remove();
  root = null;
  // o caminho /invite/<code> não significa mais nada depois que a pessoa
  // desistiu; deixá-lo faria o próximo F5 reabrir a landing
  if (inviteCodeFromLocation() !== null) history.replaceState(null, "", "/");
}

function paint(state: LandingState, code: string, opts: InviteLandingOptions): void {
  const box = card();

  if (state.kind === "loading") {
    box.append(el("p", "inv-landing-kicker", "Convite"));
    box.append(el("h1", "", "Verificando o link…"));
    box.append(el("p", "inv-landing-lead", "Só um instante."));
  } else if (state.kind === "offline") {
    box.append(el("h1", "", "Não consegui falar com o servidor"));
    box.append(
      el(
        "p",
        "inv-landing-lead",
        "Pode ser a sua internet, ou o servidor estar reiniciando. O convite continua valendo.",
      ),
    );
    const retry = el("button", "inv-landing-cta", "Tentar de novo");
    retry.type = "button";
    retry.addEventListener("click", () => void run(code, opts));
    box.append(retry);
  } else if (state.kind === "bad") {
    const copy = problemCopy(state.problem);
    box.append(el("div", "inv-landing-badge is-bad", "!"));
    box.append(el("h1", "", copy.title));
    box.append(el("p", "inv-landing-lead", copy.body));
  } else {
    const { guild_name: guild, inviter_name: inviter } = state.preview;
    // O brasão do time, do mesmo jeito que o botão da coluna de servidores —
    // que também deixou de ser uma letra no M13. Esta é a ÚNICA tela que
    // alguém de fora vê antes de ter conta: a inicial do nome da guild dizia
    // muito pouco sobre quem está convidando.
    const marca = el("div", "inv-landing-badge");
    marca.append(brasao(36));
    box.append(marca);
    box.append(el("p", "inv-landing-kicker", "Você foi convidado para"));
    box.append(el("h1", "", guild));

    // o nome de quem convidou em destaque DENTRO da frase: é ele que faz a
    // pessoa reconhecer que o link é de um amigo, e não spam
    const lead = el("p", "inv-landing-lead");
    const who = el("strong", "", inviter);
    lead.append(who, document.createTextNode(" te chamou para entrar."));
    box.append(lead);

    {
      // No desktop o `onEnter` é obrigatório e o main.ts o injeta: o fluxo
      // loopback do M6 passou a levar o convite (`oauthLogin(code)`), então o
      // botão funciona nos dois — web e app. Sem `onEnter`, o web vai direto
      // para o /auth/discord/start?invite=<code>.
      const cta = el("button", "inv-landing-cta", "Entrar com Discord");
      cta.type = "button";
      cta.addEventListener("click", () => {
        cta.disabled = true;
        cta.textContent = "abrindo o Discord…";
        if (opts.onEnter !== undefined) opts.onEnter(code);
        // O código viaja na QUERY do start e o servidor o amarra ao `state`
        // assinado — nunca em cookie nem na query do callback, senão dá para
        // trocar o convite no meio do caminho.
        else location.href = `${API}/auth/discord/start?invite=${encodeURIComponent(code)}`;
      });
      box.append(cta);
      box.append(
        el(
          "p",
          "inv-landing-fine",
          "Você entra com a sua conta do Discord. A gente só vê o seu nome e a sua foto de perfil.",
        ),
      );
    }
  }

  // "já tenho conta" em TODOS os estados menos o carregando: no erro é a única
  // saída que não é fechar a aba, e no sucesso serve a quem já é membro e
  // clicou no link do amigo por curiosidade
  if (state.kind !== "loading") {
    const skip = el("button", "inv-landing-skip", "Já tenho conta — entrar direto");
    skip.type = "button";
    skip.addEventListener("click", () => {
      closeInviteLanding();
      opts.onDismiss?.();
    });
    box.append(skip);
  }

  const node = mountRoot();
  node.replaceChildren(box);
  box.focus();
}

async function run(code: string, opts: InviteLandingOptions): Promise<void> {
  const token = ++renderToken;
  paint({ kind: "loading" }, code, opts);
  const state = await fetchPreview(code);
  if (token !== renderToken) return; // outro run (ou o close) passou na frente
  paint(state, code, opts);
}

/**
 * Mostra a landing do convite `code`. Chamar no boot, ANTES de qualquer coisa
 * de sessão, quando `inviteCodeFromLocation()` devolver um código.
 */
export function renderInviteLanding(code: string, opts: InviteLandingOptions = {}): void {
  document.title = "Convite — Danjocord";
  void run(code, opts);
}

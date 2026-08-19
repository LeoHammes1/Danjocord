/**
 * Busca no histórico (M11b, item 91) — o lado da tela.
 *
 * O servidor faz o trabalho difícil (FTS5 com conteúdo externo, consulta
 * saneada, apagadas e de sistema fora); aqui ficam quatro decisões que são só
 * de interface.
 *
 * 1. DIÁLOGO, não coluna. O `#app` é um grid de QUATRO colunas declarado em
 *    `styles/layout.css`, e um painel lateral de resultados seria a quinta —
 *    o que exigiria mexer no grid e no `index.html`, que têm outros donos, e
 *    espremer a conversa em telas estreitas justamente quando a pessoa quer
 *    ler o resultado ao lado dela. Além disso o gesto que abre a busca também
 *    é Ctrl+K, que é vocabulário de paleta de comandos — e paleta é modal. O
 *    resultado leva para OUTRO canal na maioria das vezes: o painel teria que
 *    sumir de qualquer jeito ao clicar.
 * 2. O botão do header é criado AQUI. O `#head-actions` do `index.html` só tem
 *    o de membros; como o HTML tem dono único, o botão nasce em JS — mesma
 *    solução do botão de emoji no composer e da faixa de conexão do chrome.
 * 3. O trecho vem com marcadores de controle (U+0001/U+0002) em vez de `<b>`,
 *    porque o cliente NÃO usa `innerHTML` em lugar nenhum (regra do M7). O
 *    `snippetParts()` abaixo é a função pura que os transforma em nós.
 * 4. O pulo para a mensagem é do main.ts (só ele conhece a paginação e a
 *    janela de DOM). Se ele não ligar o callback, os resultados aparecem
 *    mesmo assim, sem virarem botões, e a tela DIZ que o pulo não está
 *    disponível — um clique que não faz nada seria pior que a ausência.
 */
import { displayName, SEARCH_HIT_CLOSE, SEARCH_HIT_OPEN, SearchResults, type SearchHit } from "@danjocord/protocol";
import { avatarEl } from "./avatar.js";
import type { UiContext } from "./context.js";
import { createDialog, el as make, type DialogShell } from "./dialog.js";

/**
 * Espera antes de bater no servidor. 250 ms é o intervalo em que uma pessoa
 * digitando "reunião" (7 teclas) gera UMA busca em vez de sete — que é o
 * ponto do item ("digitar rápido não pode disparar 8 buscas"). O aborto do
 * fetch anterior cobre o resto: quem digita devagar dispara mais de uma, e só
 * a última chega a ser lida.
 */
const DEBOUNCE_MS = 250;

/**
 * Consulta com uma letra só casaria o token inteiro (o FTS5 não faz prefixo
 * sem `*`, e o `*` do usuário é saneado no servidor), então o resultado seria
 * quase sempre vazio e pareceria defeito. Mesmo piso do atalho `:` do emoji.
 */
const MIN_CONSULTA = 2;

/** Teto por busca; o servidor tem o dele (25 é o default de lá). */
const LIMITE = 40;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Lupa. Desenhada aqui e não em `ui/icons.ts` pelo mesmo motivo do rostinho do
 * emoji: `icons.ts` é arquivo compartilhado e há outros pacotes do M11b
 * mexendo no cliente ao mesmo tempo. A convenção de lá é respeitada —
 * geometria à mão, `currentColor`, `aria-hidden`.
 */
function iconeLupa(size = 20): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const circulo = document.createElementNS(SVG_NS, "circle");
  for (const [k, v] of Object.entries({
    cx: "10.5",
    cy: "10.5",
    r: "6.5",
    stroke: "currentColor",
    "stroke-width": "2",
  })) {
    circulo.setAttribute(k, v);
  }
  const cabo = document.createElementNS(SVG_NS, "line");
  for (const [k, v] of Object.entries({
    x1: "15.5",
    y1: "15.5",
    x2: "20.5",
    y2: "20.5",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
  })) {
    cabo.setAttribute(k, v);
  }
  svg.append(circulo, cabo);
  return svg;
}

// ---------------------------------------------------------------------------
// Parte pura (testável no Node — nada aqui toca DOM)
// ---------------------------------------------------------------------------

export interface SnippetPart {
  text: string;
  /** true = pedaço que casou com a consulta (vira <mark>) */
  hit: boolean;
}

/**
 * Quebra o trecho do FTS5 nos marcadores U+0001/U+0002 (`SEARCH_HIT_OPEN` /
 * `SEARCH_HIT_CLOSE` do protocolo).
 *
 * É tolerante de propósito: marcador sem par, invertido ou aninhado NÃO pode
 * derrubar o render de um resultado. A regra é a mais simples que sobrevive a
 * tudo — o texto entra em modo "realce" no abre e sai no fecha, e o que ficar
 * aberto no fim é fechado sozinho. Pedaço vazio não vira nó.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const partes: SnippetPart[] = [];
  let buffer = "";
  let dentro = false;
  const empurrar = (): void => {
    if (buffer !== "") partes.push({ text: buffer, hit: dentro });
    buffer = "";
  };
  for (const ch of snippet) {
    if (ch === SEARCH_HIT_OPEN) {
      empurrar();
      dentro = true;
    } else if (ch === SEARCH_HIT_CLOSE) {
      empurrar();
      dentro = false;
    } else {
      buffer += ch;
    }
  }
  empurrar();
  return partes;
}

/** Agrupa os acertos por canal PRESERVANDO a ordem em que o servidor mandou. */
export function groupByChannel(hits: SearchHit[]): Array<{ channelId: string; hits: SearchHit[] }> {
  const ordem: string[] = [];
  const mapa = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const id = hit.message.channel_id;
    let lista = mapa.get(id);
    if (lista === undefined) {
      lista = [];
      mapa.set(id, lista);
      ordem.push(id);
    }
    lista.push(hit);
  }
  return ordem.map((channelId) => ({ channelId, hits: mapa.get(channelId) ?? [] }));
}

// ---------------------------------------------------------------------------
// Contrato com o main.ts
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** o mesmo UiContext de todo módulo de UI (campos são getters vivos) */
  ctx: UiContext;
  /**
   * O `api()` do main.ts — o que carrega a política de renovação de token e de
   * logout do app. O `init` chega inteiro no `fetch`, então o `signal` do
   * cancelamento funciona.
   */
  api(path: string, init?: RequestInit): Promise<unknown>;
  /**
   * Leva a conversa até a mensagem (trocando de canal se preciso) e a destaca.
   * AUSENTE = o main.ts não ligou o recurso: os resultados continuam
   * aparecendo, mas não viram botão e a tela avisa. Ver o relatório para a
   * receita de implementação (ela cabe em ~25 linhas com o que o main já tem).
   */
  jumpTo?(channelId: string, messageId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Estado do módulo (VISUAL, não de domínio — ver a regra em ui/context.ts)
// ---------------------------------------------------------------------------

let opts: SearchOptions | null = null;
let shell: DialogShell | null = null;
let campo: HTMLInputElement | null = null;
let soNesteCanal: HTMLInputElement | null = null;
let estado: HTMLElement | null = null;
let lista: HTMLElement | null = null;
let botaoHeader: HTMLButtonElement | null = null;

let debounce: number | undefined;
let voando: AbortController | null = null;
/** Sequência das buscas: resposta atrasada de uma consulta velha é descartada. */
let seq = 0;
/** Linhas de resultado na ordem da tela — a navegação por seta anda nelas. */
let linhas: HTMLElement[] = [];
let ativo = -1;

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export function mountSearch(options: SearchOptions): void {
  if (shell !== null) return;
  opts = options;

  const acoes = document.getElementById("head-actions");
  const membros = document.getElementById("toggle-members");
  const botao = document.createElement("button");
  botao.type = "button";
  botao.id = "search-open";
  botao.className = "icon-btn";
  // rótulo invariante (M7): o objeto é "Buscar mensagens"; o atalho vai no title
  botao.setAttribute("aria-label", "Buscar mensagens");
  botao.setAttribute("aria-haspopup", "dialog");
  botao.title = "Buscar mensagens (Ctrl+K)";
  botao.append(iconeLupa());
  botao.addEventListener("click", () => openSearch());
  // antes do botão de membros: a busca é sobre o CONTEÚDO do canal, o outro é
  // sobre a moldura — e a ordem espelha o Discord
  if (acoes !== null) acoes.insertBefore(botao, membros);
  botaoHeader = botao;

  shell = createDialog({
    id: "search-dialog",
    title: "Buscar mensagens",
    onOpen: () => {
      montarCorpo();
      // o `open()` do ui/dialog.ts foca o PAINEL logo depois deste gancho —
      // focar aqui perderia a corrida. O microtask roda quando o open()
      // inteiro terminou, e aí o campo ganha o cursor de verdade.
      queueMicrotask(() => {
        campo?.focus();
        campo?.select();
      });
      atualizarFiltroDeCanal();
      // reabrir com o termo de antes é o comportamento útil (a pessoa fecha
      // para conferir uma coisa e volta); o que não sobrevive é a rolagem
      if ((campo?.value.trim().length ?? 0) >= MIN_CONSULTA) void buscar();
      else pintarEstado("inicial");
    },
    onClose: () => {
      cancelar();
    },
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key.toLowerCase() !== "k" || !(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.repeat) return;
    // outro modal aberto (som, voz, convites): Ctrl+K abriria um diálogo por
    // cima de outro, e o `inert` do #app deixaria os dois sem foco coerente
    if (outroModalAberto()) return;
    ev.preventDefault();
    openSearch();
  });
}

function outroModalAberto(): boolean {
  for (const overlay of document.querySelectorAll<HTMLElement>(".dialog-overlay, #sound-settings")) {
    if (overlay !== shell?.overlay && !overlay.hidden) return true;
  }
  return false;
}

export function openSearch(): void {
  // já aberto (Ctrl+K duas vezes, ou o botão do header com o diálogo na tela):
  // o `open()` da casca só devolveria o foco ao PAINEL, e quem apertou o atalho
  // de busca quer o cursor no campo, com o termo selecionado para trocar
  if (shell?.isOpen === true) {
    campo?.focus();
    campo?.select();
    return;
  }
  shell?.open(botaoHeader ?? undefined);
}

export function closeSearch(): void {
  shell?.close();
}

export function isSearchOpen(): boolean {
  return shell?.isOpen === true;
}

/** O corpo é montado UMA vez, na primeira abertura (o diálogo já existe). */
function montarCorpo(): void {
  if (shell === null || campo !== null) return;

  const barra = make("div", "sr-bar");
  const entrada = document.createElement("input");
  entrada.type = "search";
  entrada.className = "sr-field";
  entrada.placeholder = "Procurar no histórico…";
  entrada.setAttribute("aria-label", "Termo de busca");
  entrada.autocomplete = "off";
  // combobox + activedescendant: o foco NUNCA sai do campo, e as setas andam
  // na lista — mesmo padrão do seletor de emoji do item 88
  entrada.setAttribute("role", "combobox");
  entrada.setAttribute("aria-expanded", "false");
  entrada.setAttribute("aria-autocomplete", "list");
  entrada.addEventListener("input", agendar);
  entrada.addEventListener("keydown", teclado);
  campo = entrada;

  const filtro = make("label", "sr-filter");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.addEventListener("change", () => {
    void buscar();
  });
  soNesteCanal = check;
  filtro.append(check, make("span", "", "só neste canal"));

  barra.append(entrada, filtro);

  const status = make("p", "sr-status");
  // polite: o resultado chega enquanto a pessoa ainda digita; assertive
  // interromperia a leitura da própria digitação
  status.setAttribute("role", "status");
  estado = status;

  const resultados = make("div", "sr-list");
  resultados.setAttribute("role", "listbox");
  resultados.setAttribute("aria-label", "Resultados");
  lista = resultados;

  shell.body.append(barra, status, resultados);
  shell.body.classList.add("sr-body");
  pintarEstado("inicial");
}

/** O filtro só faz sentido com um canal de TEXTO aberto. */
function atualizarFiltroDeCanal(): void {
  if (soNesteCanal === null || opts === null) return;
  const atual = canalAtual();
  const label = soNesteCanal.closest(".sr-filter");
  soNesteCanal.disabled = atual === null;
  if (atual === null) soNesteCanal.checked = false;
  const texto = label?.querySelector("span");
  if (texto !== null && texto !== undefined) {
    texto.textContent = atual === null ? "só neste canal" : `só em #${atual.name}`;
  }
}

function canalAtual(): { id: string; name: string } | null {
  if (opts === null) return null;
  const id = opts.ctx.state.currentChannel;
  const canal = opts.ctx.state.channels.find((c) => c.id === id);
  return canal === undefined || canal.type !== "text" ? null : { id: canal.id, name: canal.name };
}

// ---------------------------------------------------------------------------
// Busca: debounce, cancelamento e os quatro estados
// ---------------------------------------------------------------------------

function agendar(): void {
  clearTimeout(debounce);
  const termo = campo?.value.trim() ?? "";
  if (termo.length < MIN_CONSULTA) {
    // some com o resultado velho JÁ: deixá-lo na tela enquanto a pessoa apaga
    // o termo faz parecer que ele ainda corresponde ao que está escrito
    cancelar();
    limparLista();
    pintarEstado(termo === "" ? "inicial" : "curto");
    return;
  }
  debounce = window.setTimeout(() => void buscar(), DEBOUNCE_MS);
}

/** Corta o que estiver em voo (fechar o diálogo, apagar o termo, buscar de novo). */
function cancelar(): void {
  clearTimeout(debounce);
  debounce = undefined;
  voando?.abort();
  voando = null;
  seq += 1; // qualquer resposta anterior vira resposta velha
}

async function buscar(): Promise<void> {
  if (opts === null || campo === null) return;
  const termo = campo.value.trim();
  if (termo.length < MIN_CONSULTA) return;

  cancelar();
  const meu = ++seq;
  const controle = new AbortController();
  voando = controle;
  pintarEstado("buscando", termo);

  const canal = soNesteCanal?.checked === true ? canalAtual() : null;
  const path =
    `/api/search?q=${encodeURIComponent(termo)}&limit=${LIMITE}` +
    (canal === null ? "" : `&channel_id=${encodeURIComponent(canal.id)}`);

  try {
    const bruto = await opts.api(path, { signal: controle.signal });
    if (meu !== seq) return; // chegou depois de outra busca começar: lixo
    // regra do projeto: nada que entra vira objeto confiável sem passar pelo Zod
    const parsed = SearchResults.safeParse(bruto);
    if (!parsed.success) {
      pintarEstado("erro", termo);
      return;
    }
    pintarResultados(parsed.data.hits, termo);
  } catch (err) {
    if (controle.signal.aborted || meu !== seq) return; // cancelamento não é erro
    if (err instanceof Error && err.message.includes("404")) {
      // canal do filtro sumiu (apagado por outro admin enquanto a busca rodava)
      atualizarFiltroDeCanal();
    }
    pintarEstado("erro", termo);
  } finally {
    if (voando === controle) voando = null;
  }
}

type Estado = "inicial" | "curto" | "buscando" | "vazio" | "erro";

function pintarEstado(qual: Estado, termo = ""): void {
  if (estado === null) return;
  estado.className = `sr-status is-${qual}`;
  estado.replaceChildren();
  campo?.setAttribute("aria-expanded", qual === "vazio" || qual === "inicial" ? "false" : "true");

  if (qual === "inicial") {
    estado.append(
      make("span", "", "Procure por palavras das mensagens deste servidor."),
      make("span", "sr-hint", "A busca ignora mensagens apagadas e avisos do sistema."),
    );
    return;
  }
  if (qual === "curto") {
    estado.textContent = `Digite pelo menos ${MIN_CONSULTA} caracteres.`;
    return;
  }
  if (qual === "buscando") {
    estado.textContent = "Procurando…";
    return;
  }
  if (qual === "vazio") {
    estado.append(
      make("span", "", `Nada encontrado para “${termo}”.`),
      make("span", "sr-hint", "A busca casa palavras inteiras — tente outra palavra da frase."),
    );
    return;
  }
  // erro: distinto do "nada encontrado" de propósito — um diz que não existe,
  // o outro diz que não deu para saber
  estado.append(make("span", "", "Não deu para buscar agora."));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "sr-retry";
  retry.textContent = "Tentar de novo";
  retry.addEventListener("click", () => void buscar());
  estado.append(retry);
}

function limparLista(): void {
  lista?.replaceChildren();
  linhas = [];
  ativo = -1;
  campo?.removeAttribute("aria-activedescendant");
}

// ---------------------------------------------------------------------------
// Desenho dos resultados
// ---------------------------------------------------------------------------

function pintarResultados(hits: SearchHit[], termo: string): void {
  if (lista === null || opts === null) return;
  limparLista();
  if (hits.length === 0) {
    pintarEstado("vazio", termo);
    return;
  }

  const grupos = groupByChannel(hits);
  const plural = hits.length === 1 ? "1 resultado" : `${hits.length} resultados`;
  if (estado !== null) {
    estado.className = "sr-status is-ok";
    estado.replaceChildren(
      make(
        "span",
        "",
        grupos.length === 1 ? plural : `${plural} em ${grupos.length} canais`,
      ),
    );
    if (opts.jumpTo === undefined) {
      // honestidade em vez de um clique que não faz nada
      estado.append(make("span", "sr-hint", "O pulo para a mensagem não está disponível neste cliente."));
    }
  }
  campo?.setAttribute("aria-expanded", "true");

  const frag = document.createDocumentFragment();
  for (const grupo of grupos) {
    const canal = opts.ctx.state.channels.find((c) => c.id === grupo.channelId);
    const cabecalho = make("h3", "sr-group", `#${canal?.name ?? "canal"}`);
    frag.append(cabecalho);
    for (const hit of grupo.hits) frag.append(linhaDe(hit));
  }
  lista.append(frag);
  if (linhas.length > 0) setAtivo(0);
}

function linhaDe(hit: SearchHit): HTMLElement {
  const podePular = opts?.jumpTo !== undefined;
  /*
   * `div role="option"` e NÃO `<button>`, por dois motivos que se somam:
   * (a) filho de listbox tem que ser `option` — um botão ali é ARIA errada; e
   * (b) o `ui/dialog.ts` monta a armadilha de Tab com
   *     `button:not(:disabled), input…`, e quarenta botões de resultado (todos
   *     com tabindex -1, que o Tab pula) fariam o `last` da armadilha ser uma
   *     linha inalcançável — o Tab escaparia do diálogo em silêncio.
   * O teclado do resultado é o do combobox: setas e Enter no campo de busca.
   */
  const linha = make("div", "sr-hit");
  linha.id = `sr-hit-${hit.message.id}`;
  linha.setAttribute("role", "option");
  linha.setAttribute("aria-selected", "false");
  if (!podePular) linha.setAttribute("aria-disabled", "true");

  const autor = opts?.ctx.state.members.get(hit.message.author_id);
  const nome = autor === undefined ? "Usuário desconhecido" : displayName(autor);

  const topo = make("div", "sr-hit-head");
  if (autor !== undefined) topo.append(avatarEl(autor, 20));
  topo.append(make("span", "sr-hit-author", nome), make("span", "sr-hit-time", quando(hit.message.created_at)));

  const corpo = make("p", "sr-hit-text");
  for (const parte of snippetParts(hit.snippet)) {
    if (parte.hit) corpo.append(make("mark", "", parte.text));
    else corpo.append(document.createTextNode(parte.text));
  }

  linha.append(topo, corpo);
  if (podePular) {
    linha.addEventListener("click", () => void pular(hit));
    linha.addEventListener("mousemove", () => setAtivo(linhas.indexOf(linha)));
  }
  linhas.push(linha);
  return linha;
}

/** Data curta e completa no `title` — mesma ideia dos horários das mensagens. */
function quando(ts: number): string {
  const d = new Date(ts);
  const hoje = new Date();
  const mesmoDia =
    d.getFullYear() === hoje.getFullYear() && d.getMonth() === hoje.getMonth() && d.getDate() === hoje.getDate();
  return mesmoDia
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

async function pular(hit: SearchHit): Promise<void> {
  const jump = opts?.jumpTo;
  if (jump === undefined) return;
  closeSearch(); // fecha JÁ: o resultado está em outro canal na maioria das vezes
  try {
    await jump(hit.message.channel_id, hit.message.id);
  } catch {
    // não conseguiu carregar em volta da mensagem: a busca volta, com o erro —
    // sumir e não levar a lugar nenhum deixaria a pessoa sem nem o resultado
    openSearch();
    if (estado !== null) {
      estado.className = "sr-status is-erro";
      estado.replaceChildren(make("span", "", "Não deu para abrir essa mensagem."));
    }
  }
}

// ---------------------------------------------------------------------------
// Teclado: o foco fica no campo e as setas andam na lista
// ---------------------------------------------------------------------------

function teclado(ev: KeyboardEvent): void {
  if (linhas.length === 0) return;
  switch (ev.key) {
    case "ArrowDown":
      setAtivo(ativo + 1);
      break;
    case "ArrowUp":
      setAtivo(ativo - 1);
      break;
    case "Home":
      setAtivo(0);
      break;
    case "End":
      setAtivo(linhas.length - 1);
      break;
    case "Enter": {
      const alvo = linhas[ativo];
      if (alvo === undefined) return;
      alvo.click();
      break;
    }
    default:
      return; // qualquer outra tecla continua digitando no campo
  }
  // só chega aqui quem foi tratado: o Esc segue para o overlay (que fecha) e o
  // Tab segue para a armadilha de foco do ui/dialog.ts
  ev.preventDefault();
}

function setAtivo(i: number): void {
  if (linhas.length === 0) return;
  const proximo = Math.max(0, Math.min(linhas.length - 1, i));
  linhas[ativo]?.classList.remove("is-active");
  linhas[ativo]?.setAttribute("aria-selected", "false");
  ativo = proximo;
  const alvo = linhas[ativo];
  if (alvo === undefined) return;
  alvo.classList.add("is-active");
  alvo.setAttribute("aria-selected", "true");
  alvo.scrollIntoView({ block: "nearest" });
  campo?.setAttribute("aria-activedescendant", alvo.id);
}

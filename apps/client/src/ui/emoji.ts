/**
 * Emoji (M11b, item 88): a parte pura (busca e `:atalho:`) e o seletor.
 *
 * Duas metades no mesmo arquivo, com uma regra rígida entre elas: **nada de
 * DOM no topo do módulo**. As quatro funções puras (`searchEmoji`,
 * `emojiByName`, `activeShortcode`, `applyShortcode`) precisam ser importáveis
 * pelo `node --test`, que não tem `document` — se um `createElement` rodasse na
 * carga, o teste morreria no import e a política de teclado ficaria sem teste.
 * Por isso o painel inteiro nasce dentro de `garantirPainel()`, na primeira
 * abertura, e não em `const`s de topo como no `ui/soundboard.ts` (lá o pad é
 * puro DOM e não tem parte testável).
 *
 * O seletor serve a DOIS chamadores — o botão do composer e o de reagir
 * (item 87) — então ele não sabe o que fazer com a escolha: recebe
 * `onPick(emoji)` e pronto. É o mesmo desenho do `UiContext` do M7: o módulo
 * de UI não conhece quem o usa.
 *
 * O que este arquivo NÃO faz, de propósito:
 *  - não escreve em `main.ts` nem no `index.html` (dono único). O botão do
 *    composer é criado aqui e pendurado no `#composer`, como o pad do M9 faz
 *    com o rodapé de voz;
 *  - não chama nada de `ui/composer.ts`. Depois de mexer no valor da textarea
 *    ele **dispara um `input`**, e é o listener que já existe lá que refaz
 *    altura e contador. Um `setComposerValue()` daqui perderia a posição do
 *    cursor, que é o dado central do autocomplete.
 */
import { CATEGORIAS, EMOJIS, POR_NOME, type Emoji, type EmojiCategoria } from "./emoji-data.js";

export type { Emoji, EmojiCategoria };
export { CATEGORIAS, EMOJIS };

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * Tira acento e caixa. É o que faz `corac` achar 💜 e `cafe` achar ☕ sem que
 * cada palavra da tabela precise ser escrita duas vezes. NFD separa a letra do
 * sinal diacrítico e `\p{M}` (categoria Mark do Unicode) varre o sinal — a
 * propriedade em vez da faixa U+0300..U+036F porque escrever a faixa deixaria
 * dois caracteres INVISÍVEIS no código-fonte, que ninguém revisa direito.
 */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Um emoji com os campos de busca já normalizados — calculado uma vez só. */
interface Indice {
  readonly emoji: Emoji;
  readonly nome: string;
  readonly aliases: readonly string[];
  readonly palavras: readonly string[];
}

const INDICE: readonly Indice[] = EMOJIS.map((emoji) => ({
  emoji,
  nome: normalizar(emoji.name),
  aliases: emoji.aliases.map(normalizar),
  palavras: emoji.keywords.map(normalizar),
}));

/**
 * Quanto pior o casamento, maior o número. A escala existe para `:sm` colocar
 * `smile` antes de `slightly_smiling_face`: sem ela a ordem seria a da tabela,
 * e o emoji mais óbvio apareceria no fim da lista.
 */
const SEM_CASAR = Number.POSITIVE_INFINITY;

function pontuar(item: Indice, termo: string): number {
  if (item.nome === termo) return 0;
  if (item.aliases.includes(termo)) return 1;
  if (item.nome.startsWith(termo)) return 2;
  if (item.aliases.some((a) => a.startsWith(termo))) return 3;
  if (item.palavras.some((p) => p.startsWith(termo))) return 4;
  // `includes` no fim: casar no meio da palavra é o último recurso, senão
  // `ar` traria meio catálogo antes do que começa com "ar"
  if (item.nome.includes(termo)) return 5;
  if (item.palavras.some((p) => p.includes(termo))) return 6;
  return SEM_CASAR;
}

/** Teto padrão de resultados: 6 linhas de 9 na grade do seletor. */
const LIMITE_BUSCA = 54;

/**
 * Busca por nome, apelido ou palavra-chave, com ou sem acento.
 *
 * Consulta vazia devolve **lista vazia**, e não o catálogo: quem quer o
 * catálogo inteiro usa `EMOJIS` (é o que a grade faz). Devolver 469 itens de
 * uma função chamada `searchEmoji` seria uma armadilha para quem chama.
 *
 * Vários termos são E lógico (`gato bravo` só traz o que casa com os dois) —
 * mais útil que OU numa lista pequena, onde OU devolveria quase tudo.
 */
export function searchEmoji(query: string, limite: number = LIMITE_BUSCA): Emoji[] {
  // os dois-pontos do atalho são ruído aqui: quem digita `:smi` no composer
  // manda `smi`, mas colar `:smile:` inteiro na busca também tem que funcionar
  const termos = normalizar(query)
    .replace(/:/g, " ")
    .split(/[\s_]+/)
    .filter((t) => t !== "");
  if (termos.length === 0 || limite <= 0) return [];

  const achados: { item: Indice; peso: number }[] = [];
  for (const item of INDICE) {
    let peso = 0;
    for (const termo of termos) {
      const p = pontuar(item, termo);
      if (p === SEM_CASAR) {
        peso = SEM_CASAR;
        break;
      }
      peso += p;
    }
    if (peso !== SEM_CASAR) achados.push({ item, peso });
  }
  // desempate por TAMANHO DO NOME, e é o desempate que importa: `:smi` casa
  // como prefixo em `smile`, `smiley` e `smiling_face_with_three_hearts` com
  // o mesmo peso, e sem isto quem ganharia seria quem estivesse mais acima na
  // tabela — `smiley` na frente de `smile`, que é o oposto do esperado. Nome
  // mais curto é o mais canônico.
  // Empate completo mantém a ordem do catálogo: o sort é estável por
  // especificação desde ES2019.
  achados.sort((a, b) => a.peso - b.peso || a.item.nome.length - b.item.nome.length);
  return achados.slice(0, limite).map((a) => a.item.emoji);
}

/**
 * Acha pelo nome exato ou por apelido. Aceita com e sem os dois-pontos porque
 * quem chama às vezes tem `smile` (do autocomplete) e às vezes `:smile:` (de
 * um texto colado) — e ter duas funções para isso só criaria a chance de
 * chamar a errada.
 */
export function emojiByName(name: string): Emoji | null {
  const limpo = name.trim().replace(/^:+|:+$/g, "").toLowerCase();
  if (limpo === "") return null;
  return POR_NOME.get(limpo) ?? null;
}

// ---------------------------------------------------------------------------
// `:atalho:` no texto
// ---------------------------------------------------------------------------

/** Caracteres que um shortcode aceita — o mesmo conjunto dos nomes da tabela. */
const CHAR_ATALHO = /[a-z0-9_+-]/i;
/** Letra, número ou `_` antes do `:` fecham a porta (ver `activeShortcode`). */
const PALAVRA = /[\p{L}\p{N}_]/u;
/**
 * Mínimo de letras para abrir a lista. Com 1 o painel piscaria a cada
 * dois-pontos seguido de qualquer letra (`http:` já basta); com 2 ele só
 * aparece quando alguém está mesmo escrevendo um nome. É o número que o
 * Discord usa, e a razão é a mesma.
 */
const MIN_ATALHO = 2;
/** O maior nome da tabela tem 30 e poucos caracteres; acima disso não é atalho. */
const MAX_ATALHO = 40;

/**
 * Mesma regra do `ui/markdown.ts`: o que está dentro de código não é
 * interpretado. Se o autocomplete abrisse dentro de uma crase, o emoji entraria
 * num trecho que a mensagem vai mostrar literal — o cliente ofereceria uma
 * coisa que o renderizador desfaz.
 *
 * A varredura espelha o `segments`/`scan` de lá, inclusive no caso chato:
 * **cerca ou crase sem par não é código**, é texto literal. Divergir disso
 * criaria um terceiro entendimento de "isto é código" no mesmo cliente.
 */
function emCodigo(src: string, pos: number): boolean {
  let i = 0;
  while (i < src.length && i <= pos) {
    const c = src[i] as string;
    // `\` + crase é crase literal (ESCAPABLE do markdown.ts inclui a crase)
    if (c === "\\" && src[i + 1] === "`") {
      i += 2;
      continue;
    }
    if (c !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (src[i + run] === "`") run += 1;
    const marca = "`".repeat(run >= 3 ? 3 : run);
    const fecha = src.indexOf(marca, i + run);
    if (fecha === -1) {
      i += run; // sem par: literal
      continue;
    }
    // `pos > i`: o cursor EM CIMA da crase de abertura ainda está fora
    if (pos > i && pos < fecha + marca.length) return true;
    i = fecha + marca.length;
  }
  return false;
}

/**
 * Acha o `:nome` incompleto que o cursor está escrevendo.
 *
 * `end` é o **cursor**, não o fim da palavra: com o cursor no meio de
 * `:smile`, o que se está escrevendo é `:smi` — completar até o fim da palavra
 * comeria letras que a pessoa ainda vai usar.
 *
 * Não abre quando: faltam letras (`:` sozinho), o `:` vem colado numa palavra
 * (`foo:`, `http://`), ou o cursor está dentro de código.
 */
export function activeShortcode(
  texto: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const fim = Math.max(0, Math.min(cursor, texto.length));
  let i = fim - 1;
  while (i >= 0 && CHAR_ATALHO.test(texto[i] as string) && fim - i <= MAX_ATALHO) i -= 1;
  if (i < 0 || texto[i] !== ":") return null;

  const query = texto.slice(i + 1, fim);
  if (query.length < MIN_ATALHO) return null;

  // `foo:` não abre: ali os dois-pontos são pontuação, não início de atalho.
  // É o que impede `http://x` e `12:30` de virarem seletor de emoji.
  const antes = texto[i - 1];
  if (antes !== undefined && PALAVRA.test(antes)) return null;

  if (emCodigo(texto, i)) return null;
  return { start: i, end: fim, query };
}

/**
 * Espaço depois do glifo (padrão do Discord): sem ele a próxima palavra gruda
 * no emoji. Só quando já não há espaço adiante — dobrar seria pior.
 */
function sufixoDe(depois: string): string {
  return depois === "" || !/^\s/.test(depois) ? " " : "";
}

/** Troca `texto[start..end)` pelo caractere e diz onde o cursor fica. */
export function applyShortcode(
  texto: string,
  start: number,
  end: number,
  emoji: Emoji,
): { texto: string; cursor: number } {
  const depois = texto.slice(end);
  const antes = texto.slice(0, start) + emoji.char + sufixoDe(depois);
  return { texto: antes + depois, cursor: antes.length };
}

// ---------------------------------------------------------------------------
// Recentes (localStorage)
// ---------------------------------------------------------------------------

/**
 * Mesma decisão do M8 (`sound/prefs.ts`): localStorage e NÃO a ponte de
 * segredos do desktop — isto não é segredo, é conforto, e no Electron o
 * localStorage persiste no perfil normalmente.
 *
 * Guardamos NOMES, não caracteres: se um emoji sair da tabela um dia, a
 * entrada morta some sozinha na leitura em vez de virar um quadrado na grade.
 */
const CHAVE_RECENTES = "danjocord_emoji_recentes";
/** três linhas de nove — mais que isso e "recentes" vira uma segunda grade */
const MAX_RECENTES = 27;

function lerRecentes(): Emoji[] {
  let bruto: string | null = null;
  try {
    bruto = localStorage.getItem(CHAVE_RECENTES);
  } catch {
    return []; // storage bloqueado (modo restrito): recentes é um luxo, não quebra nada
  }
  if (bruto === null) return [];
  try {
    const lido: unknown = JSON.parse(bruto);
    if (!Array.isArray(lido)) return [];
    const out: Emoji[] = [];
    for (const nome of lido) {
      if (typeof nome !== "string") continue;
      const emoji = POR_NOME.get(nome);
      if (emoji !== undefined && !out.includes(emoji)) out.push(emoji);
    }
    return out.slice(0, MAX_RECENTES);
  } catch {
    return [];
  }
}

function guardarRecente(emoji: Emoji): void {
  const lista = [emoji, ...lerRecentes().filter((e) => e !== emoji)].slice(0, MAX_RECENTES);
  try {
    localStorage.setItem(CHAVE_RECENTES, JSON.stringify(lista.map((e) => e.name)));
  } catch {
    /* idem: sem storage, os recentes só não sobrevivem à aba */
  }
}

// ---------------------------------------------------------------------------
// DOM: helpers (os mesmos do ui/soundboard.ts — o cliente não usa innerHTML)
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function botao(className: string, text = ""): HTMLButtonElement {
  const b = make("button", className, text);
  b.type = "button";
  return b;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * O rostinho do botão do composer. Mora aqui e não em `ui/icons.ts` por um
 * motivo prático: `icons.ts` é arquivo compartilhado e este é o único lugar do
 * cliente que precisa deste desenho. Se um dia um segundo lugar precisar, ele
 * muda de casa. A convenção é a de lá — geometria à mão, `currentColor`, nada
 * de emoji como ícone (um emoji aqui ignoraria `color` e o botão não
 * conseguiria acender no hover).
 */
function iconeSorriso(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const circulo = document.createElementNS(SVG_NS, "circle");
  circulo.setAttribute("cx", "12");
  circulo.setAttribute("cy", "12");
  circulo.setAttribute("r", "9");
  circulo.setAttribute("fill", "none");
  circulo.setAttribute("stroke", "currentColor");
  circulo.setAttribute("stroke-width", "2");
  const boca = document.createElementNS(SVG_NS, "path");
  boca.setAttribute("d", "M8 14a4.5 4.5 0 0 0 8 0");
  boca.setAttribute("fill", "none");
  boca.setAttribute("stroke", "currentColor");
  boca.setAttribute("stroke-width", "2");
  boca.setAttribute("stroke-linecap", "round");
  svg.append(circulo, boca);
  for (const x of [9, 15]) {
    const olho = document.createElementNS(SVG_NS, "circle");
    olho.setAttribute("cx", String(x));
    olho.setAttribute("cy", "10");
    olho.setAttribute("r", "1.3");
    olho.setAttribute("fill", "currentColor");
    svg.append(olho);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// O seletor
// ---------------------------------------------------------------------------

export interface EmojiPickerOptions {
  /** o botão que abriu: define onde o painel aparece e para onde o foco volta */
  anchor: HTMLElement;
  /** o que fazer com a escolha — o seletor não sabe e não quer saber */
  onPick(emoji: Emoji): void;
  /** rótulo do diálogo, para quem usa leitor de tela ("Escolher emoji" é o padrão) */
  label?: string;
  /** foco de volta ao fechar; `null` não devolve. Default: o próprio `anchor`. */
  returnFocusTo?: HTMLElement | null;
  /** fechar depois de escolher (default). `false` serve para escolher vários. */
  closeOnPick?: boolean;
}

interface Nos {
  raiz: HTMLDivElement;
  busca: HTMLInputElement;
  abas: HTMLDivElement;
  grade: HTMLDivElement;
  previewChar: HTMLSpanElement;
  previewNome: HTMLSpanElement;
}

let nos: Nos | null = null;
let sessao: EmojiPickerOptions | null = null;
/** os emoji desenhados agora, na ordem visual — índice de `ativo` */
let visiveis: Emoji[] = [];
let botoes: HTMLButtonElement[] = [];
let ativo = -1;
/** um botão por emoji, reaproveitado entre buscas: 469 nós criados uma vez só */
const cacheBotoes = new Map<string, HTMLButtonElement>();

const ID_GRADE = "emoji-grid";
const ROTULO_RECENTES = "Usados recentemente";

function opcaoDe(emoji: Emoji): HTMLButtonElement {
  const pronto = cacheBotoes.get(emoji.name);
  if (pronto !== undefined) return pronto;
  const b = botao("ep-emoji", emoji.char);
  b.id = `ep-op-${emoji.name}`;
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", "false");
  // o leitor de tela lê o NOME: o glifo sozinho é lido de forma diferente em
  // cada plataforma, e "rosto sorridente de olhos sorridentes" não ajuda a
  // escolher entre trinta rostos parecidos
  b.setAttribute("aria-label", emoji.name);
  b.title = `:${emoji.name}:`;
  b.tabIndex = -1; // o foco fica na busca; quem anda é o aria-activedescendant
  b.addEventListener("click", () => escolher(emoji));
  // mousemove e não mouseenter: entrar com o mouse parado enquanto a grade
  // rola por teclado roubaria a seleção de quem está usando as setas
  b.addEventListener("mousemove", () => {
    const i = botoes.indexOf(b);
    if (i !== -1 && i !== ativo) setAtivo(i, false);
  });
  cacheBotoes.set(emoji.name, b);
  return b;
}

function tituloCategoria(texto: string): HTMLDivElement {
  const t = make("div", "ep-cat", texto);
  t.setAttribute("role", "presentation");
  return t;
}

/** Redesenha a grade: catálogo inteiro quando não há busca, resultados quando há. */
function pintarGrade(query: string): void {
  const n = nos;
  if (n === null) return;
  const filhos: HTMLElement[] = [];
  visiveis = [];

  const empurrar = (lista: readonly Emoji[]): void => {
    for (const emoji of lista) {
      visiveis.push(emoji);
      filhos.push(opcaoDe(emoji));
    }
  };

  if (query.trim() !== "") {
    const achados = searchEmoji(query);
    if (achados.length === 0) {
      filhos.push(tituloCategoria(`Nenhum emoji para "${query.trim()}"`));
    } else {
      filhos.push(tituloCategoria("Resultados"));
      empurrar(achados);
    }
  } else {
    const recentes = lerRecentes();
    if (recentes.length > 0) {
      filhos.push(tituloCategoria(ROTULO_RECENTES));
      empurrar(recentes);
    }
    for (const { id, rotulo } of CATEGORIAS) {
      filhos.push(tituloCategoria(rotulo));
      empurrar(EMOJIS.filter((e) => e.categoria === id));
    }
  }

  n.grade.replaceChildren(...filhos);
  botoes = filhos.filter((f): f is HTMLButtonElement => f instanceof HTMLButtonElement);
  ativo = -1;
  if (visiveis.length > 0) setAtivo(0, false);
  else pintarPreview(null);
  n.grade.scrollTop = 0;
}

function pintarPreview(emoji: Emoji | null): void {
  const n = nos;
  if (n === null) return;
  n.previewChar.textContent = emoji === null ? "" : emoji.char;
  n.previewNome.textContent = emoji === null ? "" : `:${emoji.name}:`;
}

function setAtivo(indice: number, rolar = true): void {
  const n = nos;
  if (n === null || visiveis.length === 0) return;
  const i = Math.max(0, Math.min(indice, visiveis.length - 1));
  const anterior = botoes[ativo];
  if (anterior !== undefined) {
    anterior.classList.remove("is-active");
    anterior.setAttribute("aria-selected", "false");
  }
  ativo = i;
  const alvo = botoes[i];
  const emoji = visiveis[i];
  if (alvo === undefined || emoji === undefined) return;
  alvo.classList.add("is-active");
  alvo.setAttribute("aria-selected", "true");
  n.busca.setAttribute("aria-activedescendant", alvo.id);
  if (rolar) alvo.scrollIntoView({ block: "nearest" });
  pintarPreview(emoji);
}

/**
 * Sobe/desce uma linha usando a GEOMETRIA e não `índice ± 9`.
 *
 * A conta simples estaria errada: os títulos de categoria ocupam a linha
 * inteira, então a primeira linha de cada categoria recomeça na coluna 1 e o
 * salto de 9 pularia para a coluna errada logo depois de um título. Ler
 * `offsetTop`/`offsetLeft` não assume nada sobre o layout — se um dia a grade
 * mudar de 9 colunas, isto continua certo sozinho.
 */
function moverLinha(direcao: -1 | 1): void {
  const atual = botoes[ativo];
  if (atual === undefined) return;
  const topo = atual.offsetTop;
  const centro = atual.offsetLeft + atual.offsetWidth / 2;
  let linha: number | null = null;
  let melhor = ativo;
  let dist = Number.POSITIVE_INFINITY;
  for (let i = ativo + direcao; i >= 0 && i < botoes.length; i += direcao) {
    const b = botoes[i] as HTMLButtonElement;
    if (b.offsetTop === topo) continue;
    if (linha === null) linha = b.offsetTop;
    else if (b.offsetTop !== linha) break; // passou da linha vizinha: parar
    const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - centro);
    if (d < dist) {
      dist = d;
      melhor = i;
    }
  }
  setAtivo(melhor);
}

function escolher(emoji: Emoji): void {
  const atual = sessao;
  if (atual === null) return;
  guardarRecente(emoji);
  atual.onPick(emoji);
  if (atual.closeOnPick !== false) closeEmojiPicker();
}

function aoTeclar(ev: KeyboardEvent): void {
  if (nos === null || sessao === null) return;
  switch (ev.key) {
    case "Escape":
      ev.preventDefault();
      closeEmojiPicker();
      return;
    case "ArrowRight":
      ev.preventDefault();
      setAtivo(ativo + 1);
      return;
    case "ArrowLeft":
      ev.preventDefault();
      setAtivo(ativo - 1);
      return;
    case "ArrowDown":
      ev.preventDefault();
      moverLinha(1);
      return;
    case "ArrowUp":
      ev.preventDefault();
      moverLinha(-1);
      return;
    case "Home":
      ev.preventDefault();
      setAtivo(0);
      return;
    case "End":
      ev.preventDefault();
      setAtivo(visiveis.length - 1);
      return;
    case "Enter": {
      const emoji = visiveis[ativo];
      if (emoji === undefined) return;
      ev.preventDefault();
      escolher(emoji);
      return;
    }
    case "Tab":
      // Tab sai do painel: fechar aqui evita deixar um diálogo aberto atrás de
      // um foco que já foi embora
      closeEmojiPicker();
      return;
    default:
  }
}

function garantirPainel(): Nos {
  if (nos !== null) return nos;

  const raiz = make("div", "emoji-picker");
  raiz.setAttribute("role", "dialog");
  raiz.setAttribute("aria-label", "Escolher emoji");
  raiz.hidden = true;

  const busca = make("input", "ep-search");
  busca.type = "text";
  busca.autocomplete = "off";
  busca.placeholder = "Buscar emoji";
  busca.setAttribute("aria-label", "Buscar emoji");
  // combobox + listbox: as setas andam pela grade sem tirar o foco do campo,
  // então dá para continuar digitando e navegando ao mesmo tempo
  busca.setAttribute("role", "combobox");
  busca.setAttribute("aria-expanded", "true");
  busca.setAttribute("aria-controls", ID_GRADE);
  busca.setAttribute("aria-autocomplete", "list");
  busca.addEventListener("input", () => pintarGrade(busca.value));

  const abas = make("div", "ep-tabs");
  abas.setAttribute("role", "group");
  abas.setAttribute("aria-label", "Categorias");

  const grade = make("div", "ep-grid");
  grade.id = ID_GRADE;
  grade.setAttribute("role", "listbox");
  grade.setAttribute("aria-label", "Emojis");

  const preview = make("div", "ep-preview");
  const previewChar = make("span", "ep-preview-char");
  const previewNome = make("span", "ep-preview-name");
  preview.append(previewChar, previewNome);

  for (const { id, rotulo } of CATEGORIAS) {
    const primeiro = EMOJIS.find((e) => e.categoria === id);
    const aba = botao("ep-tab", primeiro === undefined ? "?" : primeiro.char);
    aba.setAttribute("aria-label", rotulo);
    aba.title = rotulo;
    aba.addEventListener("click", () => {
      // a aba é um atalho de ROLAGEM, não um filtro: manter tudo numa lista só
      // é o que deixa a rolagem contínua e o teclado atravessar categorias
      busca.value = "";
      pintarGrade("");
      rolarPara(rotulo);
      busca.focus();
    });
    abas.append(aba);
  }

  raiz.append(busca, abas, grade, preview);
  raiz.addEventListener("keydown", aoTeclar);
  document.body.append(raiz);

  // fechar ao clicar fora. pointerdown e não click: arrastar de dentro para
  // fora e soltar no fundo não pode fechar (mesma razão do diálogo do M9).
  // O âncora está isento — senão o clique nele fecharia aqui e o `toggle`
  // reabriria em seguida, e o botão nunca conseguiria fechar o painel.
  document.addEventListener("pointerdown", (ev) => {
    if (sessao === null) return;
    const alvo = ev.target;
    if (!(alvo instanceof Node)) return;
    if (raiz.contains(alvo) || sessao.anchor.contains(alvo)) return;
    closeEmojiPicker();
  });
  // o painel é `position: fixed` ancorado num botão que anda com o layout:
  // rolar ou redimensionar sem reposicionar deixaria o painel órfão na tela
  window.addEventListener("resize", () => {
    if (sessao !== null) posicionar(sessao.anchor);
  });
  window.addEventListener(
    "scroll",
    () => {
      if (sessao !== null) posicionar(sessao.anchor);
    },
    true, // capture: rolagem de container interno não borbulha
  );

  nos = { raiz, busca, abas, grade, previewChar, previewNome };
  return nos;
}

function rolarPara(rotulo: string): void {
  const n = nos;
  if (n === null) return;
  for (const filho of n.grade.children) {
    if (filho instanceof HTMLElement && filho.classList.contains("ep-cat") && filho.textContent === rotulo) {
      // offsetTop já é relativo à grade: o CSS a deixa `position: relative`, e
      // é ela o offsetParent dos filhos (o mesmo que `moverLinha` assume)
      n.grade.scrollTop = filho.offsetTop;
      return;
    }
  }
}

/** margem entre o painel e o âncora/bordas da janela */
const FOLGA = 8;

function posicionar(anchor: HTMLElement): void {
  const n = nos;
  if (n === null) return;
  const a = anchor.getBoundingClientRect();
  const p = n.raiz.getBoundingClientRect();
  // acima do botão é o lugar natural: o composer vive no rodapé, e abrir para
  // baixo jogaria o painel para fora da janela
  let top = a.top - p.height - FOLGA;
  if (top < FOLGA) top = Math.min(a.bottom + FOLGA, window.innerHeight - p.height - FOLGA);
  const left = Math.max(FOLGA, Math.min(a.right - p.width, window.innerWidth - p.width - FOLGA));
  n.raiz.style.top = `${Math.max(FOLGA, top)}px`;
  n.raiz.style.left = `${left}px`;
}

export function isEmojiPickerOpen(): boolean {
  return sessao !== null;
}

export function openEmojiPicker(opts: EmojiPickerOptions): void {
  const n = garantirPainel();
  fecharAutocomplete(); // os dois flutuam no mesmo lugar; nunca os dois juntos
  sessao = opts;
  n.raiz.setAttribute("aria-label", opts.label ?? "Escolher emoji");
  n.raiz.hidden = false;
  n.busca.value = "";
  pintarGrade("");
  posicionar(opts.anchor);
  opts.anchor.setAttribute("aria-expanded", "true");
  n.busca.focus();
}

export function closeEmojiPicker(): void {
  const atual = sessao;
  if (atual === null || nos === null) return;
  sessao = null;
  nos.raiz.hidden = true;
  atual.anchor.setAttribute("aria-expanded", "false");
  const volta = atual.returnFocusTo === undefined ? atual.anchor : atual.returnFocusTo;
  // só devolve o foco se o alvo ainda existe: um membro pode ter saído da
  // lista (e o botão de reagir, sumido) enquanto o painel estava aberto
  if (volta !== null && volta.isConnected) volta.focus();
}

/** Abre, ou fecha se já estiver aberto NESTE âncora — é o que um botão faz. */
export function toggleEmojiPicker(opts: EmojiPickerOptions): void {
  if (sessao !== null && sessao.anchor === opts.anchor) {
    closeEmojiPicker();
    return;
  }
  openEmojiPicker(opts);
}

// ---------------------------------------------------------------------------
// Autocomplete `:nome:` no composer
// ---------------------------------------------------------------------------

/** quantos aparecem na listinha — mais que isso e ela vira um segundo seletor */
const LIMITE_AUTOCOMPLETE = 8;

interface AcNos {
  raiz: HTMLDivElement;
  lista: HTMLDivElement;
}

let acNos: AcNos | null = null;
let acVisiveis: Emoji[] = [];
let acBotoes: HTMLButtonElement[] = [];
let acAtivo = -1;
let acAlvo: HTMLTextAreaElement | null = null;

function garantirAutocomplete(): AcNos {
  if (acNos !== null) return acNos;
  const raiz = make("div", "emoji-ac");
  raiz.hidden = true;
  const lista = make("div", "emoji-ac-list");
  lista.setAttribute("role", "listbox");
  lista.setAttribute("aria-label", "Emoji sugeridos");
  raiz.append(lista);
  document.body.append(raiz);
  acNos = { raiz, lista };
  return acNos;
}

function fecharAutocomplete(): void {
  acVisiveis = [];
  acBotoes = [];
  acAtivo = -1;
  if (acNos !== null) acNos.raiz.hidden = true;
  if (acAlvo !== null) acAlvo.removeAttribute("aria-activedescendant");
}

function setAcAtivo(indice: number): void {
  if (acVisiveis.length === 0) return;
  const i = Math.max(0, Math.min(indice, acVisiveis.length - 1));
  const anterior = acBotoes[acAtivo];
  if (anterior !== undefined) {
    anterior.classList.remove("is-active");
    anterior.setAttribute("aria-selected", "false");
  }
  acAtivo = i;
  const alvo = acBotoes[i];
  if (alvo === undefined) return;
  alvo.classList.add("is-active");
  alvo.setAttribute("aria-selected", "true");
  alvo.scrollIntoView({ block: "nearest" });
  if (acAlvo !== null) acAlvo.setAttribute("aria-activedescendant", alvo.id);
}

function aplicarAutocomplete(emoji: Emoji): void {
  const campo = acAlvo;
  if (campo === null) return;
  const alvo = activeShortcode(campo.value, campo.selectionStart ?? 0);
  if (alvo === null) {
    fecharAutocomplete();
    return;
  }
  guardarRecente(emoji);
  const r = applyShortcode(campo.value, alvo.start, alvo.end, emoji);
  campo.value = r.texto;
  campo.setSelectionRange(r.cursor, r.cursor);
  fecharAutocomplete();
  notificarComposer(campo);
  campo.focus();
}

function pintarAutocomplete(campo: HTMLTextAreaElement): void {
  const alvo = activeShortcode(campo.value, campo.selectionStart ?? 0);
  if (alvo === null) {
    fecharAutocomplete();
    return;
  }
  const achados = searchEmoji(alvo.query, LIMITE_AUTOCOMPLETE);
  if (achados.length === 0) {
    fecharAutocomplete();
    return;
  }

  const n = garantirAutocomplete();
  acAlvo = campo;
  acVisiveis = achados;
  acBotoes = achados.map((emoji, i) => {
    const b = botao("emoji-ac-item");
    b.id = `emoji-ac-${i}`;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", "false");
    b.setAttribute("aria-label", emoji.name);
    b.tabIndex = -1;
    b.append(make("span", "emoji-ac-char", emoji.char), make("span", "emoji-ac-name", `:${emoji.name}:`));
    // mousedown e não click: o click só chega depois do blur da textarea, e
    // com o campo já sem foco a posição do cursor deixaria de valer
    b.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      aplicarAutocomplete(emoji);
    });
    b.addEventListener("mousemove", () => setAcAtivo(i));
    return b;
  });
  n.lista.replaceChildren(...acBotoes);
  n.raiz.hidden = false;
  acAtivo = -1;
  setAcAtivo(0);
  posicionarAutocomplete(campo);
}

function posicionarAutocomplete(campo: HTMLTextAreaElement): void {
  const n = acNos;
  if (n === null) return;
  const caixa = (campo.closest("form") ?? campo).getBoundingClientRect();
  const p = n.raiz.getBoundingClientRect();
  const top = Math.max(FOLGA, caixa.top - p.height - FOLGA);
  const left = Math.max(FOLGA, Math.min(caixa.left, window.innerWidth - p.width - FOLGA));
  n.raiz.style.top = `${top}px`;
  n.raiz.style.left = `${left}px`;
}

/**
 * Avisa o `ui/composer.ts` de que o campo mudou POR FORA do teclado.
 *
 * Ele já escuta `input` na textarea (é lá que moram o auto-resize e o contador
 * de caracteres); disparar o evento é mais honesto que importar as funções de
 * lá e chamá-las na mão — se o composer ganhar mais um comportamento no
 * `input`, este caminho o herda de graça.
 */
function notificarComposer(campo: HTMLTextAreaElement): void {
  campo.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Insere o caractere na posição do cursor (caminho do SELETOR, não do atalho). */
function inserirNoCampo(campo: HTMLTextAreaElement, emoji: Emoji): void {
  const inicio = campo.selectionStart ?? campo.value.length;
  const fim = campo.selectionEnd ?? inicio;
  const depois = campo.value.slice(fim);
  const antes = campo.value.slice(0, inicio) + emoji.char + sufixoDe(depois);
  campo.value = antes + depois;
  campo.setSelectionRange(antes.length, antes.length);
  notificarComposer(campo);
  campo.focus();
}

// ---------------------------------------------------------------------------
// Montagem no composer
// ---------------------------------------------------------------------------

let montado = false;

/**
 * Pendura o botão de emoji no `#composer` e liga o autocomplete na textarea.
 * Chamado UMA vez pelo `main.ts`, depois do `mountComposer()`.
 *
 * O keydown entra na fase de CAPTURA de propósito: o `ui/composer.ts` já
 * escuta keydown na mesma textarea (Enter envia, ↑ edita a última mensagem), e
 * a captura roda antes de qualquer listener de bolha, independentemente de
 * quem registrou primeiro. Com a lista de sugestões aberta, Enter escolhe o
 * emoji e ↑/↓ andam nela — e o `stopImmediatePropagation` impede que a mesma
 * tecla também envie a mensagem. Fechada a lista, este listener não faz nada e
 * o composer se comporta exatamente como antes.
 */
export function mountEmojiComposer(): void {
  if (montado) return;
  const form = document.getElementById("composer");
  const campo = document.getElementById("input");
  if (!(form instanceof HTMLFormElement) || !(campo instanceof HTMLTextAreaElement)) return;
  montado = true;

  const abrir = botao("icon-btn emoji-btn");
  abrir.id = "emoji-toggle";
  abrir.setAttribute("aria-label", "Emoji"); // invariante: o objeto, não o verbo (M7)
  abrir.setAttribute("aria-expanded", "false");
  abrir.setAttribute("aria-haspopup", "dialog");
  abrir.title = "Escolher emoji";
  abrir.append(iconeSorriso());
  abrir.addEventListener("click", () => {
    // timeout de chat (M10): o `ui/composer.ts` desabilita a textarea e não
    // avisa ninguém. Abrir o seletor aqui daria um painel que escreve num
    // campo que não aceita nada — a checagem no clique é o jeito de saber,
    // porque `disabled` não gera evento.
    if (campo.disabled) return;
    toggleEmojiPicker({
      anchor: abrir,
      onPick: (emoji) => inserirNoCampo(campo, emoji),
      // o foco volta para a conversa, não para o botão: quem escolheu um emoji
      // quase sempre vai continuar escrevendo
      returnFocusTo: campo,
    });
  });
  // logo depois da textarea: antes do contador e do "Enviar", que são a ponta
  // direita do bloco e não podem trocar de ordem
  campo.after(abrir);

  campo.addEventListener("input", () => pintarAutocomplete(campo));
  // clicar/andar com o cursor muda o atalho ativo sem gerar `input`
  campo.addEventListener("click", () => pintarAutocomplete(campo));
  campo.addEventListener("blur", () => fecharAutocomplete());

  campo.addEventListener(
    "keydown",
    (ev) => {
      if (acVisiveis.length === 0) return;
      switch (ev.key) {
        case "ArrowDown":
          setAcAtivo(acAtivo + 1);
          break;
        case "ArrowUp":
          setAcAtivo(acAtivo - 1);
          break;
        case "Enter":
        case "Tab": {
          const emoji = acVisiveis[acAtivo];
          if (emoji === undefined) return;
          aplicarAutocomplete(emoji);
          break;
        }
        case "Escape":
          fecharAutocomplete();
          break;
        default:
          return; // qualquer outra tecla segue o caminho normal
      }
      ev.preventDefault();
      // o composer escuta keydown na mesma textarea: sem isto, o Enter que
      // escolheu o emoji enviaria a mensagem junto
      ev.stopImmediatePropagation();
    },
    true,
  );

  // setas/Home/End movem o cursor sem disparar `input`; reavaliar depois da
  // tecla mantém a lista coerente com onde o cursor foi parar
  campo.addEventListener("keyup", (ev) => {
    if (ev.key.startsWith("Arrow") || ev.key === "Home" || ev.key === "End") pintarAutocomplete(campo);
  });
}

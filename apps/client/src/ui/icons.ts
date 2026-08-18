/**
 * Iconografia do cliente (M7). Substitui os emojis de texto (📷 🎙️ 🎧 ▾ …)
 * que o M0–M6 usava: emoji renderiza colorido, muda de métrica por sistema
 * operacional e ignora `color`, então um botão de mute "ligado" não conseguia
 * ficar vermelho. SVG com fill/stroke em `currentColor` herda a cor do botão
 * e resolve os três problemas de uma vez.
 *
 * Os desenhos são geometria básica feita à mão (linhas, círculos, retângulos)
 * — nada copiado de biblioteca de ícones, que costumam vir com licença presa.
 *
 * A função devolve SVGElement, não string: o resto do cliente nunca usa
 * innerHTML (a CSP é apertada e o renderer do desktop guarda os tokens
 * decifrados — um caminho de HTML cru aqui seria um convite ao XSS).
 */

export type IconName =
  | "hash"
  | "volume"
  | "mic"
  | "mic-off"
  | "headphones"
  | "headphones-off"
  | "video"
  | "video-off"
  | "screen"
  | "settings"
  | "logout"
  | "pencil"
  | "trash"
  | "chevron"
  | "members"
  | "close"
  | "check"
  | "plus"
  | "live";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Só as tags que os desenhos abaixo usam — mantém o createElementNS tipado. */
type ShapeTag = "path" | "circle" | "line" | "rect";
type Shape = [tag: ShapeTag, attrs: Record<string, string>];

/**
 * Atalho para os traços: quase todo ícone é linha, não mancha. Espalhar
 * `stroke-linecap` em cada forma deixaria a tabela ilegível.
 */
const S = (d: string, width = "2"): Shape => [
  "path",
  {
    d,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
];
const LINE = (x1: number, y1: number, x2: number, y2: number): Shape => [
  "line",
  {
    x1: String(x1),
    y1: String(y1),
    x2: String(x2),
    y2: String(y2),
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
  },
];
/** Barra diagonal de "desligado" — mic-off, video-off, headphones-off. */
const SLASH: Shape = LINE(4, 3, 20, 21);

const SHAPES: Record<IconName, Shape[]> = {
  // # do canal de texto: as verticais são inclinadas, como no glifo real
  hash: [LINE(9.5, 3, 7.5, 21), LINE(17, 3, 15, 21), LINE(4, 9, 20, 9), LINE(3, 15, 19, 15)],

  // alto-falante + duas ondas
  volume: [["path", { d: "M4 9h3.5L13 4.5v15L7.5 15H4z", fill: "currentColor" }], S("M16.5 8.8a4.6 4.6 0 0 1 0 6.4"), S("M19.4 5.8a8.8 8.8 0 0 1 0 12.4")],

  // cápsula do microfone + arco do suporte
  mic: [
    ["rect", { x: "9", y: "2.5", width: "6", height: "11", rx: "3", fill: "currentColor" }],
    S("M5.5 11a6.5 6.5 0 0 0 13 0"),
    LINE(12, 17.5, 12, 21),
    LINE(8.5, 21, 15.5, 21),
  ],
  "mic-off": [
    ["rect", { x: "9", y: "2.5", width: "6", height: "11", rx: "3", fill: "currentColor" }],
    S("M5.5 11a6.5 6.5 0 0 0 13 0"),
    LINE(12, 17.5, 12, 21),
    LINE(8.5, 21, 15.5, 21),
    SLASH,
  ],

  // arco da haste + as duas conchas
  headphones: [
    S("M4 15.5V12a8 8 0 0 1 16 0v3.5"),
    ["rect", { x: "2", y: "13.5", width: "5", height: "7.5", rx: "2.5", fill: "currentColor" }],
    ["rect", { x: "17", y: "13.5", width: "5", height: "7.5", rx: "2.5", fill: "currentColor" }],
  ],
  "headphones-off": [
    S("M4 15.5V12a8 8 0 0 1 16 0v3.5"),
    ["rect", { x: "2", y: "13.5", width: "5", height: "7.5", rx: "2.5", fill: "currentColor" }],
    ["rect", { x: "17", y: "13.5", width: "5", height: "7.5", rx: "2.5", fill: "currentColor" }],
    SLASH,
  ],

  // corpo da câmera + a "lente" triangular
  video: [
    ["rect", { x: "2", y: "6", width: "13", height: "12", rx: "3", fill: "currentColor" }],
    ["path", { d: "M16 10.5 22 7v10l-6-3.5z", fill: "currentColor" }],
  ],
  "video-off": [
    ["rect", { x: "2", y: "6", width: "13", height: "12", rx: "3", fill: "currentColor" }],
    ["path", { d: "M16 10.5 22 7v10l-6-3.5z", fill: "currentColor" }],
    SLASH,
  ],

  // monitor + pé
  screen: [
    ["rect", { x: "2", y: "4", width: "20", height: "12.5", rx: "2", fill: "currentColor" }],
    LINE(12, 16.5, 12, 20),
    LINE(8, 20, 16, 20),
  ],

  // engrenagem: anel central + oito dentes radiais (45° em 45°)
  settings: [
    ["circle", { cx: "12", cy: "12", r: "3.2", fill: "none", stroke: "currentColor", "stroke-width": "2" }],
    LINE(18, 12, 21, 12),
    LINE(16.24, 7.76, 18.36, 5.64),
    LINE(12, 6, 12, 3),
    LINE(7.76, 7.76, 5.64, 5.64),
    LINE(6, 12, 3, 12),
    LINE(7.76, 16.24, 5.64, 18.36),
    LINE(12, 18, 12, 21),
    LINE(16.24, 16.24, 18.36, 18.36),
  ],

  // porta aberta + seta saindo
  logout: [S("M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"), S("M15.5 8 19.5 12l-4 4"), LINE(19.5, 12, 9.5, 12)],

  // lápis: corpo + a marca da ponta
  pencil: [S("M4 20.5l4-1L20 8l-3-3L5 16.5z"), LINE(15.5, 6.5, 18.5, 9.5)],

  // lixeira: tampa, alça, corpo e os dois riscos
  trash: [LINE(4, 6.5, 20, 6.5), S("M9.5 6.5V4h5v2.5"), S("M6 6.5 7 20.5h10l1-14"), LINE(10.5, 10, 10.5, 17), LINE(13.5, 10, 13.5, 17)],

  // seta para BAIXO — colapsado/expandido se resolve girando via CSS
  chevron: [S("M6 9.5 12 15.5 18 9.5")],

  // duas silhuetas; a de trás é só o ombro aparecendo
  members: [
    ["circle", { cx: "8.5", cy: "8", r: "3.5", fill: "currentColor" }],
    ["path", { d: "M2 20.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5z", fill: "currentColor" }],
    ["circle", { cx: "17.5", cy: "9.5", r: "2.5", fill: "currentColor" }],
    ["path", { d: "M16.2 20.5c0-2.3-.9-4.4-2.4-5.9.9-.4 1.9-.6 2.9-.6 3 0 5.3 2.4 5.3 6.5z", fill: "currentColor" }],
  ],

  close: [LINE(6, 6, 18, 18), LINE(18, 6, 6, 18)],
  check: [S("M5 12.5 9.5 17 19 7", "2.5")],
  plus: [LINE(12, 5, 12, 19), LINE(5, 12, 19, 12)],

  // ponto de transmissão + as ondas saindo dele
  live: [
    ["circle", { cx: "12", cy: "12", r: "3", fill: "currentColor" }],
    S("M7.4 7.4a6.5 6.5 0 0 0 0 9.2"),
    S("M16.6 16.6a6.5 6.5 0 0 0 0-9.2"),
  ],
};

/**
 * Cria o <svg> do ícone. Sempre `aria-hidden`: o ícone NUNCA é o rótulo —
 * quem carrega o nome acessível é o `aria-label` (ou o texto) do botão que
 * o contém. Se um ícone aparecer sem rótulo por perto, o bug é no chamador.
 */
export function icon(name: IconName, size = 20): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false"); // alguns navegadores põem <svg> na ordem de tabulação
  for (const [tag, attrs] of SHAPES[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

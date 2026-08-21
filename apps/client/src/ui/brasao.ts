/**
 * O brasão do Danjomar (M13) — a marca do time dentro do app.
 *
 * POR QUE NÃO ESTÁ NO `icons.ts`. Aquele arquivo tem uma regra no topo que vale
 * a pena preservar: "os desenhos são geometria básica feita à mão — nada
 * copiado de biblioteca de ícones, que costumam vir com licença presa". O
 * brasão é o oposto disso nos três eixos: não é feito à mão (sai do
 * `scripts/trace-logo.mjs`), não é geometria básica (são 92 pontos num path só)
 * e não é genérico — é a identidade de um time específico. Misturá-lo à tabela
 * `SHAPES` faria a frase daquele arquivo virar mentira.
 *
 * Também não cabe no formato de lá: os ícones são `viewBox="0 0 24 24"` com
 * traço; o brasão é mancha, tem proporção própria (1048 × 944) e depende de
 * `fill-rule="evenodd"` para os recortes internos aparecerem.
 *
 * O que ele MANTÉM do `icons.ts`, porque não é estilo e sim segurança: devolve
 * SVGElement construído com `createElementNS`, nunca string de HTML, e pinta
 * com `currentColor` — quem decide a cor é o CSS de quem o hospeda.
 */
import { BRASAO_ALTURA, BRASAO_LARGURA, BRASAO_PATH, BRASAO_VIEWBOX } from "./brasao-path.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param largura em px. A altura sai da proporção do desenho (é mais largo do
 *   que alto por pouco), então o chamador nunca precisa saber o número.
 */
export function brasao(largura = 24): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", BRASAO_VIEWBOX);
  svg.setAttribute("width", String(largura));
  svg.setAttribute("height", String(Math.round((largura * BRASAO_ALTURA) / BRASAO_LARGURA)));
  svg.setAttribute("fill", "currentColor");
  // decorativo em todo lugar onde é usado: o botão da guild e o card de login
  // já dizem o nome em texto, e um "Danjomar" repetido pelo leitor de tela
  // seria ruído, não informação
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  // `setAttribute` e não `className`: em SVGElement o `className` é um
  // SVGAnimatedString somente-leitura. A classe existe para o CSS poder
  // distinguir o brasão do chevron dentro do #sidebar-head — os dois são svg.
  svg.setAttribute("class", "brasao");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", BRASAO_PATH);
  // os recortes internos (o miolo do escudo, o vazado das letras) são laços de
  // orientação contrária dentro do MESMO path — sem esta regra eles se enchem
  path.setAttribute("fill-rule", "evenodd");
  svg.append(path);
  return svg;
}

/**
 * O mesmo desenho como `data:` URI, para o favicon.
 *
 * POR QUE EM JS, e não cravado no `index.html`: o path tem 726 bytes e existe
 * num lugar só (`brasao-path.ts`, gerado). Colar uma segunda cópia no HTML
 * criaria duas fontes da verdade que ninguém lembraria de sincronizar no dia em
 * que o time trocasse a logo — exatamente o defeito que o `--check` do
 * `trace-logo.mjs` existe para impedir.
 *
 * Passa na CSP: favicon é governado por `img-src`, e as três CSPs do projeto
 * já trazem `data:` ali (era assim que o "D" azul anterior era servido).
 *
 * A cor entra por parâmetro porque este é o ÚNICO desenho do app que não pode
 * herdar `currentColor`: o favicon é renderizado pelo navegador fora do
 * documento, onde `var(--brand)` não existe.
 */
export function faviconDataUri(cor: string): string {
  const svg =
    `<svg xmlns="${SVG_NS}" viewBox="${BRASAO_VIEWBOX}">` +
    `<path fill="${cor}" fill-rule="evenodd" d="${BRASAO_PATH}"/>` +
    `</svg>`;
  // encodeURIComponent e não `encodeURI`: o path usa `#` em nenhum lugar hoje,
  // mas a cor usa — e um `#` cru corta a URI ali, deixando um favicon vazio
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Troca o `<link rel="icon">` do documento pelo brasão, na cor dada. */
export function aplicarFavicon(cor: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link !== null) link.href = faviconDataUri(cor);
}

/**
 * Põe a marca nos três lugares em que ela aparece, no boot: o cabeçalho da
 * sidebar (o app), o cartão de login e o favicon.
 *
 * Chamado uma vez pelo `main.ts`, antes de qualquer decisão de sessão — um dos
 * alvos é a tela de login, e desenhar a marca só depois de saber quem entrou
 * faria o brasão aparecer com atraso justamente onde ele é o principal.
 *
 * Os `?.` calam: se um dos ids sumir do HTML, a marca desaparece da tela sem
 * exceção e sem log. Nenhum teste cobre isso hoje (o `brand-asset.test.ts`
 * olha os arquivos, não o DOM) — é regressão silenciosa aceita de olhos
 * abertos, e vale saber disso antes de renomear um id.
 */
export function mountBrand(): void {
  // O cabeçalho da sidebar, à esquerda do nome do servidor. Era o pill da
  // coluna de guilds até o M13; a coluna saiu (um servidor só) e a marca veio
  // para cá.
  //
  // `prepend` e NUNCA `replaceChildren`: quando isto roda, o #sidebar-head já
  // tem o texto do index.html E o chevron que o ui/sidebar.ts pendurou —
  // `mountSidebar` é chamado no topo do main.ts, antes do `boot()`. Um
  // `replaceChildren` apagaria os dois, e o chevron não voltaria: aquele
  // módulo tem guarda de "já montei" e não roda de novo.
  //
  // 20px, e não mais: "DANJOCORD" em Orbitron ocupa ~111px dos 208 úteis a
  // 264px de sidebar; com o chevron e os gaps, 24px estouraria a barra quando
  // a media query de 820px encolhe a coluna para 200px — e o texto é uma
  // palavra só, sem ellipsis, então ele não cede: vaza.
  document.getElementById("sidebar-head")?.prepend(brasao(20));
  document.getElementById("login-mark")?.replaceChildren(brasao(64));

  // A cor sai do PRÓPRIO token, lido do documento — não de um hex repetido
  // aqui, que seria a segunda fonte da verdade que o resto deste arquivo
  // existe para evitar. Se vier vazio (o CSS ainda não aplicou), não mexe: o
  // index.html já traz um escudo vermelho de marcador, e trocá-lo por um
  // literal de reserva reintroduziria a duplicata pela porta dos fundos.
  const brand = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
  if (brand !== "") aplicarFavicon(brand);
}

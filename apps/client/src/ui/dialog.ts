/**
 * Casca de diálogo modal (M9) — a parte do `ui/settings.ts` do M8 que não tem
 * nada a ver com som.
 *
 * O M8 escreveu overlay + `role="dialog"` + `aria-modal` + `inert` no `#app` +
 * armadilha de Tab + Esc + foco de volta para quem abriu. Nada disso é sobre
 * som: é o que QUALQUER modal deste cliente precisa fazer para não prender
 * quem navega por teclado. O M9 traz o segundo diálogo (voz e vídeo), e um
 * segundo copy-paste dessas ~60 linhas seria a garantia de que os dois vão
 * divergir na primeira correção de acessibilidade.
 *
 * O `ui/settings.ts` NÃO foi alterado (dono é o pacote do M8): ele continua com
 * a cópia dele. A sugestão de passar a usar esta casca está no relatório — se
 * for aceita, as regras `.dialog-*` do voice-settings.css viram um
 * `styles/dialog.css` próprio.
 *
 * O que a casca dá e o que ela NÃO dá: ela cuida do CONTINENTE (abrir, fechar,
 * foco, fundo inerte). O conteúdo — e o ciclo de vida do que ele liga, como
 * medidor de microfone e timer de estatísticas — é de quem chama, pelos
 * ganchos `onOpen`/`onClose`.
 */
import { icon } from "./icons.js";

/**
 * `:disabled` (pseudo-classe) e não `[disabled]` (atributo): o `<fieldset>`
 * desabilita os descendentes SEM marcar atributo em nenhum deles, e a
 * armadilha de Tab precisa enxergar exatamente o que é focável AGORA.
 * `select` está aqui porque o diálogo de voz é feito deles — a casca do M8
 * não precisava, e é justamente o tipo de detalhe que dois arquivos copiados
 * teriam divergido em silêncio.
 */
const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled)";

export interface DialogOptions {
  /** id do overlay (também usado para derivar o id do título) */
  id: string;
  title: string;
  /** roda DEPOIS de o diálogo aparecer — ligue aqui timers e assinaturas */
  onOpen?: () => void;
  /** roda DEPOIS de o diálogo sumir — desligue aqui TUDO o que o onOpen ligou */
  onClose?: () => void;
}

export interface DialogShell {
  readonly overlay: HTMLElement;
  /** o `role="dialog"`; tem `tabIndex = -1` para receber o foco inicial */
  readonly panel: HTMLElement;
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  readonly foot: HTMLElement;
  readonly isOpen: boolean;
  /** `opener` é quem recebe o foco de volta ao fechar */
  open(opener?: HTMLElement): void;
  close(): void;
  /**
   * Traz o foco de volta ao painel se ele tiver escapado. Desabilitar um
   * controle que está com o foco joga o foco no `<body>`, e de lá o Tab não
   * passa mais pelo listener do overlay — a armadilha morreria calada.
   */
  keepFocus(): void;
}

/** Cria elemento com classe e texto — o mesmo utilitário do M8, agora um só. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

/** O `#app` inteiro sai de cena enquanto o diálogo está aberto (foco, mouse e leitor de tela). */
function setBackgroundInert(inert: boolean): void {
  const app = document.getElementById("app");
  if (app !== null) app.inert = inert;
}

export function createDialog(options: DialogOptions): DialogShell {
  /** para onde o foco volta ao fechar — quem abriu decide, no `open()` */
  let returnFocusTo: HTMLElement | null = null;

  const overlay = el("div", "dialog-overlay");
  overlay.id = options.id;
  overlay.hidden = true;

  const panel = el("div", "dialog-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const titleId = `${options.id}-title`;
  panel.setAttribute("aria-labelledby", titleId);
  // alvo do foco inicial: não há "primeiro controle" óbvio, e mandar o foco
  // para o diálogo faz o leitor de tela anunciar o título antes de tudo
  panel.tabIndex = -1;

  const head = el("header", "dialog-head");
  const title = el("h2", "", options.title);
  title.id = titleId;
  const closeBtn = el("button", "icon-btn");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Fechar");
  closeBtn.title = "Fechar";
  closeBtn.append(icon("close"));
  head.append(title, closeBtn);

  const body = el("div", "dialog-body");
  const foot = el("footer", "dialog-foot");

  panel.append(head, body, foot);
  overlay.append(panel);

  function keepFocus(): void {
    if (!panel.contains(document.activeElement)) panel.focus();
  }

  function open(opener?: HTMLElement): void {
    if (!overlay.hidden) {
      panel.focus();
      return;
    }
    returnFocusTo = opener ?? null;
    overlay.hidden = false;
    setBackgroundInert(true);
    options.onOpen?.();
    panel.focus();
  }

  function close(): void {
    if (overlay.hidden) return;
    overlay.hidden = true;
    setBackgroundInert(false);
    // o onClose vem ANTES de devolver o foco: é ele que desabilita/limpa
    // controles, e mexer no DOM depois de focar poderia roubar o foco de novo
    options.onClose?.();
    // sem isto quem abriu pelo teclado volta com o foco no <body>, no fim do
    // documento — o mesmo cuidado que o menu da engrenagem já tem com o Esc
    returnFocusTo?.focus();
    returnFocusTo = null;
  }

  closeBtn.addEventListener("click", () => close());

  // Esc e a armadilha de Tab escutam no OVERLAY: o foco vive dentro dele
  // enquanto o diálogo está aberto (o `#app` está inert), então tudo bubbla
  // até aqui — e um listener no `document` fecharia diálogo de todo mundo.
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key !== "Tab") return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items.at(0);
    const last = items.at(-1);
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    // o painel em si (tabindex -1) é o foco recém-aberto: dali, Shift+Tab tem
    // que ir para o FIM da lista, senão o primeiro Shift+Tab escapa do diálogo
    if (ev.shiftKey && (active === first || active === panel)) {
      last.focus();
      ev.preventDefault();
    } else if (!ev.shiftKey && active === last) {
      first.focus();
      ev.preventDefault();
    }
  });

  // pointerdown e não click: com click, arrastar de dentro do painel para fora
  // e soltar no fundo fecharia o diálogo (o click sobe até o ancestral comum)
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) close();
  });

  document.body.append(overlay);

  return {
    overlay,
    panel,
    head,
    body,
    foot,
    get isOpen(): boolean {
      return !overlay.hidden;
    },
    open,
    close,
    keepFocus,
  };
}

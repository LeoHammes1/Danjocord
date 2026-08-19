/**
 * Composer (M7). O campo de mensagem era um `<input type="text">` de uma
 * linha: não existia mensagem com quebra de linha, colar um bloco virava uma
 * linha só, e o limite de 4000 caracteres do servidor só aparecia como um 400
 * silencioso depois do envio. A Fase 1 trocou a tag para `<textarea rows="1">`;
 * este módulo é o comportamento que a troca pede.
 *
 * O `<form id="composer">` continua sendo o dono do envio — Enter e o botão
 * "Enviar" passam pelo MESMO submit. Isso mantém o comportamento nativo do
 * formulário (e o botão continua sendo um `type="submit"` de verdade, não um
 * div que finge).
 *
 * O módulo não conhece canal, mensagem nem REST: recebe callbacks. Quem sabe
 * o que fazer com o texto é o main.ts.
 */

/**
 * Limite do servidor: `content: z.string().min(1).max(4000)` em
 * packages/protocol (CreateMessageBody e UpdateMessageBody). Duplicado como
 * número aqui porque o protocolo não exporta a constante — se um dia exportar,
 * este const some.
 */
const MAX_CONTENT = 4000;
/** O contador só aparece perto do fim: um número fixo na tela seria ruído. */
const COUNTER_AT = Math.floor(MAX_CONTENT * 0.9);
/**
 * Piso do teto de altura: no boot o #app ainda está [hidden] e clientHeight é
 * 0 — sem o piso, o campo nasceria com altura zero.
 */
const MIN_MAX_HEIGHT = 120;

const el = {
  messages: document.getElementById("messages")!,
  composer: document.getElementById("composer") as HTMLFormElement,
  input: document.getElementById("input") as HTMLTextAreaElement,
};

/**
 * O botão Enviar não tem id (o index.html tem dono único), então vem por
 * seletor — e pode ser null se o markup mudar. Nesse caso o composer continua
 * funcionando por Enter; só o "desabilitar no estouro" se perde.
 */
const sendBtn = el.composer.querySelector<HTMLButtonElement>('button[type="submit"]');

/** Contador de caracteres — criado aqui porque é inteiramente deste módulo. */
const counter = document.createElement("span");
counter.className = "composer-count";
// aria-hidden: um número que muda a cada tecla, lido em voz alta, é tortura.
// O bloqueio real do envio é o `disabled` do botão, que o leitor de tela lê.
counter.setAttribute("aria-hidden", "true");
counter.hidden = true;

let mounted = false;

// ---------------------------------------------------------------------------
// Altura e contador
// ---------------------------------------------------------------------------

/**
 * Cresce com o texto até ~metade da área de mensagens; daí em diante rola por
 * dentro. O campo pode tomar espaço da conversa, mas nunca engolir a conversa
 * que está sendo respondida.
 */
function autoResize(): void {
  // zerar a altura ANTES de ler o scrollHeight: com a altura anterior aplicada
  // o scrollHeight nunca encolhe (ele mede o conteúdo OU a caixa, o que for
  // maior) e o campo só saberia crescer
  el.input.style.height = "auto";
  const full = el.input.scrollHeight;
  if (full === 0) {
    // app ainda oculto: medir agora daria 0 e travaria o campo fechado
    el.input.style.height = "";
    return;
  }
  const max = Math.max(MIN_MAX_HEIGHT, Math.round(el.messages.clientHeight * 0.5));
  el.input.style.height = `${Math.min(full, max)}px`;
  el.input.style.overflowY = full > max ? "auto" : "hidden";
}

function updateCounter(): void {
  const left = MAX_CONTENT - el.input.value.length;
  counter.hidden = el.input.value.length < COUNTER_AT;
  counter.textContent = String(left);
  counter.classList.toggle("over", left < 0);
  // estourou: o envio some da mesa antes de virar 400 do servidor
  // durante um timeout quem manda é o paintComposer; sem o `||` o contador
  // reabriria o botão a cada tecla
  if (sendBtn !== null) sendBtn.disabled = left < 0 || (mutedUntil !== null && mutedUntil > Date.now());
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ComposerOptions {
  /** texto já trimado, não vazio e dentro do limite */
  onSubmit(content: string): void;
  /** só dispara quando há texto de verdade (espaço em branco não é digitar) */
  onTyping(): void;
  /**
   * ↑ com o campo VAZIO (item 93). Devolve `true` se alguém tratou — só então
   * o composer engole a tecla. O composer não sabe o que é "minha última
   * mensagem"; ele só sabe que o campo está vazio, que é a condição da tecla.
   */
  onEditLast?: () => boolean;
}

export function mountComposer(opts: ComposerOptions): void {
  if (mounted) return;
  mounted = true;
  el.composer.insertBefore(counter, sendBtn); // insertBefore(x, null) === append

  el.input.addEventListener("input", () => {
    autoResize();
    updateCounter();
    // mesma regra do M2: colar espaços ou apagar tudo não conta como digitar
    if (el.input.value.trim() !== "") opts.onTyping();
  });

  // textarea não submete o formulário no Enter como o <input> fazia
  el.input.addEventListener("keydown", (ev) => {
    // ↑ no campo vazio abre a edição da última mensagem própria (padrão de
    // Discord/Slack). Com texto no campo a tecla faz o de sempre: andar o cursor.
    if (
      ev.key === "ArrowUp" &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      el.input.value === "" &&
      opts.onEditLast?.() === true
    ) {
      ev.preventDefault();
      return;
    }
    // isComposing: no meio de um IME (acento morto, teclado japonês) o Enter é
    // "confirmar o caractere", não "enviar"
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    el.composer.requestSubmit(); // passa pelo submit — validação em um lugar só
  });

  el.composer.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const content = el.input.value.trim();
    if (content === "" || content.length > MAX_CONTENT) return;
    // limpa ANTES do callback: o envio é otimista, o campo tem que estar livre
    // para a próxima frase. Falhou? quem chamou devolve o texto com
    // setComposerValue() — que também refaz altura e contador.
    setComposerValue("");
    opts.onSubmit(content);
  });

  // o teto de altura é uma fração da área de mensagens, que muda com a janela
  window.addEventListener("resize", autoResize);
}

/**
 * Timeout de chat (M10, item 53). O servidor recusa o POST com 403 enquanto
 * durar — mas deixar o campo habilitado faria a pessoa digitar uma frase
 * inteira para ela sumir num erro. Aqui o campo se fecha e DIZ até quando.
 *
 * O relógio é local: o vencimento não gera evento no servidor (ele só compara
 * `Date.now()` na próxima mensagem), então quem reabre o campo é este timer.
 */
let mutedUntil: number | null = null;
let mutedTimer: number | undefined;
let channelName: string | null = null;

function fimDoTimeout(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return "menos de um minuto";
  if (min < 60) return `${min} minutos`;
  const h = Math.round(min / 60);
  return h === 1 ? "cerca de uma hora" : `cerca de ${h} horas`;
}

function paintComposer(): void {
  const falta = mutedUntil === null ? 0 : mutedUntil - Date.now();
  const calado = falta > 0;
  el.input.disabled = calado;
  if (sendBtn !== null) sendBtn.disabled = calado;
  el.input.placeholder = calado
    ? `Você está silenciado — faltam ${fimDoTimeout(falta)}`
    : channelName === null
      ? "Selecione um canal"
      : `Conversar em #${channelName}`;
  if (mutedTimer !== undefined) clearTimeout(mutedTimer);
  mutedTimer = undefined;
  if (!calado) return;
  // reacorda no vencimento (ou em 1 min, o que vier antes, para o texto do
  // contador não ficar velho na tela)
  mutedTimer = window.setTimeout(paintComposer, Math.min(falta, 60_000) + 250);
}

/** `until` em epoch ms; null (ou passado) libera o campo. */
export function setComposerMuted(until: number | null): void {
  mutedUntil = until;
  paintComposer();
}

/** Placeholder segue o canal — "Mensagem em #geral" cravado no HTML mentia. */
export function setComposerChannel(name: string | null): void {
  channelName = name;
  paintComposer();
  // primeira chance real de medir: na troca de canal o #app já está visível
  autoResize();
}

export function focusComposer(): void {
  el.input.focus();
  autoResize();
}

/** Repõe o texto no campo (retry de envio que falhou) e reajusta o campo. */
export function setComposerValue(content: string): void {
  el.input.value = content;
  autoResize();
  updateCounter();
}

export function clearComposer(): void {
  setComposerValue("");
}

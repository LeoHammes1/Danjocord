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
 *
 * M11b (item 89) somou a BANDEJA DE ANEXOS: botão, arrastar-e-soltar, colar do
 * clipboard, preview antes de enviar. O upload continua entrando por callback
 * (`uploadAttachment`) — o módulo segue sem conhecer rede, e o cliente ganha a
 * possibilidade honesta de não ter o recurso: sem o callback, o botão de
 * anexar nem nasce (ver `mountComposer`).
 *
 * O botão de emoji e o autocomplete `:nome:` (item 88) NÃO estão aqui: eles
 * são de `ui/emoji.ts`, que se pendura na mesma textarea por fora
 * (`mountEmojiComposer`). A convivência entre os dois está documentada lá — o
 * ponto que importa para este arquivo é que o keydown do autocomplete roda na
 * fase de CAPTURA e engole Enter/setas só quando a lista está aberta.
 */
import type { Attachment } from "@danjocord/protocol";
import {
  attachmentProblem,
  formatBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  SNIFF_BYTES,
} from "./attachments.js";
import { icon } from "./icons.js";

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
  /**
   * Texto já trimado e dentro do limite. Desde o M11b ele pode vir VAZIO —
   * mensagem só de imagem é legítima (o `CreateMessageBody` do servidor pede
   * "ou texto ou anexo"). `attachments` são os anexos JÁ criados no servidor:
   * o call site manda os ids em `attachment_ids` e, de quebra, tem os objetos
   * inteiros (com width/height) para o render otimista não pular de layout.
   */
  onSubmit(content: string, attachments: Attachment[]): void;
  /** só dispara quando há texto de verdade (espaço em branco não é digitar) */
  onTyping(): void;
  /**
   * ↑ com o campo VAZIO (item 93). Devolve `true` se alguém tratou — só então
   * o composer engole a tecla. O composer não sabe o que é "minha última
   * mensagem"; ele só sabe que o campo está vazio, que é a condição da tecla.
   */
  onEditLast?: () => boolean;
  /**
   * Sobe UM arquivo e devolve o anexo criado (M11b, item 89). AUSENTE = o
   * cliente não tem anexos: o botão não nasce, o drop e o Ctrl+V de imagem são
   * ignorados. A implementação pronta é `uploadAttachment` de `ui/upload.ts` —
   * ela mora lá, e não aqui, para este módulo continuar sem conhecer rede.
   */
  uploadAttachment?: (file: File, signal: AbortSignal) => Promise<Attachment>;
}

let opts: ComposerOptions | null = null;

export function mountComposer(options: ComposerOptions): void {
  if (mounted) return;
  mounted = true;
  opts = options;
  el.composer.insertBefore(counter, sendBtn); // insertBefore(x, null) === append
  if (options.uploadAttachment !== undefined) montarAnexos();

  el.input.addEventListener("input", () => {
    autoResize();
    updateCounter();
    // mesma regra do M2: colar espaços ou apagar tudo não conta como digitar
    if (el.input.value.trim() !== "") options.onTyping();
  });

  // textarea não submete o formulário no Enter como o <input> fazia
  el.input.addEventListener("keydown", (ev) => {
    // ↑ no campo vazio abre a edição da última mensagem própria (padrão de
    // Discord/Slack). Com texto no campo a tecla faz o de sempre: andar o cursor.
    // Com IMAGEM na bandeja também não: a seta ali é para revisar o que vai
    // junto, e abrir a edição de outra mensagem descartaria o anexo.
    if (
      ev.key === "ArrowUp" &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      el.input.value === "" &&
      anexos.length === 0 &&
      options.onEditLast?.() === true
    ) {
      ev.preventDefault();
      return;
    }
    // Esc cancela a resposta em curso (e só ela: sem alvo, a tecla segue
    // adiante para quem mais quiser tratá-la)
    if (ev.key === "Escape" && replyTarget !== null) {
      ev.preventDefault();
      setReplyTarget(null);
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
    if (content.length > MAX_CONTENT) return;
    // M11b: só texto vazio não basta mais para desistir — mensagem só de
    // imagem é legítima. O que não pode é os dois vazios.
    if (content === "" && anexos.length === 0) return;

    // Anexo ainda subindo: a mensagem espera. Sair na frente mandaria a frase
    // sem a imagem que a pessoa acabou de colar — e ela só descobriria depois.
    // O `envioPendente` faz o último upload a terminar re-disparar este submit.
    if (anexos.some((a) => a.estado === "enviando")) {
      envioPendente = true;
      pintarBandeja();
      return;
    }
    // Anexo que falhou: não dá para "enviar mesmo assim" sem descartar em
    // silêncio o que a pessoa anexou. Ela remove ou manda tentar de novo.
    if (anexos.some((a) => a.estado === "erro")) {
      envioPendente = false;
      mostrarAviso("uma imagem não subiu — tente de novo ou remova antes de enviar");
      return;
    }

    const enviados = anexos.map((a) => a.anexo).filter((a): a is Attachment => a !== null);
    // limpa ANTES do callback: o envio é otimista, o campo tem que estar livre
    // para a próxima frase. Falhou? quem chamou devolve o texto com
    // setComposerValue() — que também refaz altura e contador — e os anexos
    // com restoreComposerAttachments().
    setComposerValue("");
    esvaziarBandeja("enviado");
    options.onSubmit(content, enviados);
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

/** Silenciado agora? A resposta é a mesma para o campo, o botão e o drop. */
function calado(): boolean {
  return mutedUntil !== null && mutedUntil - Date.now() > 0;
}

function paintComposer(): void {
  const falta = mutedUntil === null ? 0 : mutedUntil - Date.now();
  const mudo = falta > 0;
  el.input.disabled = mudo;
  if (sendBtn !== null) sendBtn.disabled = mudo;
  if (attachBtn !== null) attachBtn.disabled = mudo;
  el.input.placeholder = mudo
    ? `Você está silenciado — faltam ${fimDoTimeout(falta)}`
    : channelName === null
      ? "Selecione um canal"
      : `Conversar em #${channelName}`;
  if (mutedTimer !== undefined) clearTimeout(mutedTimer);
  mutedTimer = undefined;
  if (!mudo) return;
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
  esvaziarBandeja("descartado");
  setReplyTarget(null);
}

// ---------------------------------------------------------------------------
// Responder (M11b, item 86)
//
// A barra vive AQUI e não no ui/messages porque ela é estado do CAMPO, não da
// timeline: o alvo acompanha o que está sendo escrito, some no envio e some na
// troca de canal (o servidor recusa citar mensagem de outro canal).
// ---------------------------------------------------------------------------

let replyTarget: { id: string; autor: string } | null = null;
let replyBar: HTMLElement | null = null;

function pintarReply(): void {
  if (replyBar === null) {
    replyBar = document.createElement("div");
    replyBar.className = "composer-reply";
    el.composer.parentElement?.insertBefore(replyBar, el.composer);
  }
  replyBar.replaceChildren();
  if (replyTarget === null) {
    replyBar.hidden = true;
    return;
  }
  replyBar.hidden = false;
  const rotulo = document.createElement("span");
  rotulo.className = "composer-reply-label";
  rotulo.append(document.createTextNode("Respondendo a "));
  const nome = document.createElement("strong");
  nome.textContent = replyTarget.autor;
  rotulo.append(nome);
  const cancelar = document.createElement("button");
  cancelar.type = "button";
  cancelar.className = "icon-btn";
  cancelar.setAttribute("aria-label", "Cancelar resposta");
  cancelar.append(icon("close", 14));
  cancelar.addEventListener("click", () => {
    setReplyTarget(null);
    el.input.focus();
  });
  replyBar.append(rotulo, cancelar);
}

/** null cancela. O `autor` é o nome EXIBIDO, resolvido por quem chama. */
export function setReplyTarget(target: { id: string; autor: string } | null): void {
  replyTarget = target;
  pintarReply();
  if (target !== null) el.input.focus();
}

/** id da mensagem citada, para o corpo do POST. */
export function replyTargetId(): string | null {
  return replyTarget?.id ?? null;
}

// ---------------------------------------------------------------------------
// Bandeja de anexos (M11b, item 89)
//
// O fluxo é o de duas etapas do servidor: o arquivo sobe ASSIM QUE entra na
// bandeja (`POST /api/attachments` → id) e o id só é usado no envio da
// mensagem. Subir na hora e não no envio é o que dá preview, barra de
// progresso e erro ANTES de a frase ir embora — e o que faz o Enter ser
// instantâneo quando a imagem já terminou.
//
// O preço é o anexo ÓRFÃO de quem desiste; o servidor o varre em 15 minutos
// (ORPHAN_TTL_MS), e é por isso que remover da bandeja aborta o fetch em vez de
// tentar apagar algo que talvez nem exista ainda.
// ---------------------------------------------------------------------------

interface AnexoLocal {
  readonly arquivo: File;
  /** blob: do preview local — REVOGADO ao sair da bandeja (senão vaza) */
  readonly url: string;
  readonly abort: AbortController;
  readonly card: HTMLElement;
  readonly sub: HTMLElement;
  estado: "enviando" | "pronto" | "erro";
  anexo: Attachment | null;
  erro: string | null;
}

const anexos: AnexoLocal[] = [];
/** Submit pedido enquanto ainda havia upload em voo — dispara sozinho no fim. */
let envioPendente = false;

let tray: HTMLElement | null = null;
let trayItens: HTMLElement | null = null;
let trayMsg: HTMLElement | null = null;
let attachBtn: HTMLButtonElement | null = null;
let fileInput: HTMLInputElement | null = null;
/** contador de dragenter/dragleave: sem ele, entrar num filho "sai" da zona */
let arrastando = 0;

function montarAnexos(): void {
  const botao = document.createElement("button");
  botao.type = "button"; // NUNCA submit: um botão sem type dentro de form envia
  botao.className = "icon-btn attach-btn";
  // rótulo invariante (regra do M7): o objeto é "imagem", o verbo vai no title
  botao.setAttribute("aria-label", "Anexar imagem");
  botao.title = "Anexar imagem";
  botao.append(icon("plus"));
  botao.addEventListener("click", () => {
    if (el.input.disabled) return; // timeout de chat: `disabled` não gera evento
    fileInput?.click();
  });
  attachBtn = botao;

  const campo = document.createElement("input");
  campo.type = "file";
  campo.accept = "image/png,image/jpeg,image/gif,image/webp";
  campo.multiple = true;
  campo.hidden = true;
  // sem `name`: o <input type=file> mora dentro do <form>, e um dia em que
  // alguém trocar o submit por um POST nativo o arquivo não pode ir junto
  campo.addEventListener("change", () => {
    void adicionarArquivos(campo.files);
    // zera para que escolher O MESMO arquivo de novo volte a disparar change
    campo.value = "";
  });
  fileInput = campo;

  const bandeja = document.createElement("div");
  bandeja.className = "composer-tray";
  bandeja.hidden = true;
  const itens = document.createElement("div");
  itens.className = "composer-tray-items";
  const msg = document.createElement("p");
  msg.className = "composer-tray-msg";
  // role=status e não alert: a recusa de um arquivo não é urgente a ponto de
  // interromper quem está digitando — mas precisa ser anunciada
  msg.setAttribute("role", "status");
  msg.hidden = true;
  bandeja.append(itens, msg);
  tray = bandeja;
  trayItens = itens;
  trayMsg = msg;

  // ordem no DOM: botão e campo antes da textarea (o botão fica à esquerda,
  // como no Discord); a bandeja é irmã e o CSS a joga para a linha de cima
  el.composer.insertBefore(bandeja, el.input);
  el.composer.insertBefore(botao, el.input);
  el.composer.insertBefore(campo, el.input);

  // --- colar (Ctrl+V) — metade do uso real: print da tela vai para o clipboard
  el.input.addEventListener("paste", (ev) => {
    const arquivos = imagensDe(ev.clipboardData);
    if (arquivos.length === 0) return; // colar TEXTO segue o caminho nativo
    ev.preventDefault();
    void adicionarArquivos(arquivos);
  });

  /*
   * --- arrastar e soltar ---------------------------------------------------
   *
   * Os quatro listeners são no DOCUMENTO, e não no `#composer`, por causa do
   * comportamento padrão do navegador: soltar uma imagem numa página NAVEGA
   * para o arquivo. Numa aba comum isso é chato; aqui é perder a chamada de
   * voz por errar a mira. Então o documento inteiro engole o drop, e a mira
   * deixa de existir — soltar em qualquer lugar da conversa anexa.
   *
   * A coordenação com os outros donos de drop (o pad de sons do M9 tem dois)
   * é o `defaultPrevented`: quem tratou o evento antes já chamou
   * `preventDefault`, e este bloco sai de fininho.
   */
  document.addEventListener("dragenter", (ev) => {
    if (!zonaValida(ev)) return;
    arrastando += 1;
    el.composer.classList.add("is-dragging");
  });
  document.addEventListener("dragover", (ev) => {
    // sem preventDefault no dragover o navegador NÃO dispara drop
    if (zonaValida(ev)) ev.preventDefault();
  });
  document.addEventListener("dragleave", (ev) => {
    if (!temArquivo(ev.dataTransfer)) return;
    arrastando = Math.max(0, arrastando - 1);
    if (arrastando === 0) el.composer.classList.remove("is-dragging");
  });
  document.addEventListener("drop", (ev) => {
    if (!temArquivo(ev.dataTransfer) || ev.defaultPrevented) return;
    // preventDefault ANTES de qualquer outra decisão: mesmo um drop numa área
    // que não aceita anexo não pode virar navegação
    ev.preventDefault();
    arrastando = 0;
    el.composer.classList.remove("is-dragging");
    if (!zonaValida(ev) || el.input.disabled) return;
    void adicionarArquivos(imagensDe(ev.dataTransfer));
  });
}

/**
 * O drop vale? Precisa (a) trazer arquivo, (b) não ter sido tratado por outro
 * dono, e (c) cair dentro do `#app` e fora de um modal — o diálogo de som tem
 * a própria área de soltar, e o pad de voz também.
 */
function zonaValida(ev: DragEvent): boolean {
  if (ev.defaultPrevented || !temArquivo(ev.dataTransfer)) return false;
  const alvo = ev.target;
  if (!(alvo instanceof Element)) return false;
  return alvo.closest("#app") !== null && alvo.closest(".dialog-overlay, #sound-settings, #soundboard") === null;
}

/** Nome do arquivo cabe na linha de erro; o nome inteiro fica no `title` do card. */
function nomeCurto(nome: string): string {
  return nome.length <= 28 ? nome : `${nome.slice(0, 25)}…`;
}

function temArquivo(dt: DataTransfer | null): boolean {
  return dt !== null && [...dt.types].includes("Files");
}

/**
 * Só os arquivos que se dizem imagem. O `type` aqui NÃO é a decisão (quem
 * decide são os magic bytes, no `attachmentProblem` e depois no servidor): ele
 * serve para não engolir o Ctrl+V de um .zip ou de um trecho de texto rico e
 * deixar esses casos seguirem o caminho nativo do navegador.
 */
function imagensDe(dt: DataTransfer | null): File[] {
  if (dt === null) return [];
  return [...dt.files].filter((f) => f.type.startsWith("image/") || f.type === "");
}

async function adicionarArquivos(lista: FileList | File[] | null): Promise<void> {
  if (lista === null || opts?.uploadAttachment === undefined) return;
  if (calado()) {
    mostrarAviso("você está silenciado neste servidor");
    return;
  }
  const arquivos = [...lista];
  if (arquivos.length === 0) return;
  limparAviso();
  let recusados = 0;
  let primeiraRecusa: string | null = null;

  for (const arquivo of arquivos) {
    // lê SÓ o cabeçalho: sniffar não precisa do arquivo inteiro na memória, e
    // um .mkv de 2 GB arrastado por engano não pode virar um ArrayBuffer
    const head = new Uint8Array(await arquivo.slice(0, SNIFF_BYTES).arrayBuffer());
    const problema = attachmentProblem({ size: arquivo.size, head, anexosAtuais: anexos.length });
    if (problema !== null) {
      recusados += 1;
      primeiraRecusa ??= `${nomeCurto(arquivo.name)}: ${problema}`;
      continue;
    }
    criarCard(arquivo);
  }

  if (primeiraRecusa !== null) {
    mostrarAviso(recusados === 1 ? primeiraRecusa : `${primeiraRecusa} (e mais ${recusados - 1})`);
  }
  pintarBandeja();
}

function criarCard(arquivo: File): void {
  const card = document.createElement("div");
  card.className = "attach-card";

  const img = document.createElement("img");
  img.className = "attach-thumb";
  img.alt = ""; // decorativo: o nome do arquivo está ao lado, em texto
  // blob: e não data: — um data URI de 8 MB viraria +33% de base64 numa string
  // de DOM. ATENÇÃO: exige `blob:` no img-src da CSP (ver relatório).
  const url = URL.createObjectURL(arquivo);
  img.src = url;

  const meta = document.createElement("div");
  meta.className = "attach-meta";
  const nome = document.createElement("span");
  nome.className = "attach-name";
  nome.textContent = arquivo.name;
  nome.title = arquivo.name;
  const sub = document.createElement("span");
  sub.className = "attach-sub";
  meta.append(nome, sub);

  const remover = document.createElement("button");
  remover.type = "button";
  remover.className = "icon-btn attach-remove";
  remover.setAttribute("aria-label", `Remover ${arquivo.name}`);
  remover.title = "Remover";
  remover.append(icon("close", 14));

  card.append(img, meta, remover);

  const item: AnexoLocal = {
    arquivo,
    url,
    abort: new AbortController(),
    card,
    sub,
    estado: "enviando",
    anexo: null,
    erro: null,
  };
  remover.addEventListener("click", () => removerAnexo(item));
  anexos.push(item);
  trayItens?.append(card);
  pintarCard(item);
  void subir(item);
}

async function subir(item: AnexoLocal): Promise<void> {
  const upload = opts?.uploadAttachment;
  if (upload === undefined) return;
  item.estado = "enviando";
  item.erro = null;
  pintarCard(item);
  pintarBandeja();
  try {
    item.anexo = await upload(item.arquivo, item.abort.signal);
    item.estado = "pronto";
  } catch (err) {
    // abortado = removido pela pessoa: o card já saiu da tela, não há erro
    if (err instanceof DOMException && err.name === "AbortError") return;
    item.estado = "erro";
    item.erro = err instanceof Error ? err.message : "falha ao enviar";
    // um upload que falhou cancela o envio automático: mandar a frase sem a
    // imagem seria decidir pela pessoa
    envioPendente = false;
  }
  pintarCard(item);
  pintarBandeja();
}

function removerAnexo(item: AnexoLocal): void {
  const i = anexos.indexOf(item);
  if (i < 0) return;
  anexos.splice(i, 1);
  item.abort.abort(); // corta o upload em voo (o órfão o servidor varre)
  if (item.url !== "") URL.revokeObjectURL(item.url);
  item.card.remove();
  limparAviso();
  pintarBandeja();
  el.input.focus(); // o foco estava no botão que acabou de sumir do DOM
}

/** Estado visual de UM card. O texto do `sub` é o que o leitor de tela lê. */
function pintarCard(item: AnexoLocal): void {
  item.card.dataset["estado"] = item.estado;
  item.sub.textContent =
    item.estado === "enviando"
      ? "enviando…"
      : item.estado === "erro"
        ? (item.erro ?? "falha ao enviar")
        : formatBytes(item.arquivo.size);
  item.card.classList.toggle("is-error", item.estado === "erro");
  // clicar no card com erro tenta de novo — o botão de remover continua ao lado
  item.card.onclick =
    item.estado === "erro"
      ? (ev): void => {
          if (ev.target instanceof Element && ev.target.closest(".attach-remove") !== null) return;
          void subir(item);
        }
      : null;
  item.card.title = item.estado === "erro" ? "Clique para tentar de novo" : "";
}

function pintarBandeja(): void {
  if (tray === null) return;
  const subindo = anexos.filter((a) => a.estado === "enviando").length;
  tray.hidden = anexos.length === 0 && (trayMsg?.hidden ?? true);
  if (anexos.length > 0 && envioPendente && subindo > 0) {
    mostrarAviso(subindo === 1 ? "enviando a imagem antes da mensagem…" : `enviando ${subindo} imagens…`);
  }
  // a última carga terminou e havia um Enter esperando: dispara o submit real
  if (envioPendente && subindo === 0) {
    envioPendente = false;
    if (anexos.every((a) => a.estado === "pronto")) {
      limparAviso();
      el.composer.requestSubmit();
    }
  }
  if (attachBtn !== null) {
    attachBtn.disabled = calado() || anexos.length >= MAX_ATTACHMENTS_PER_MESSAGE;
  }
}

function mostrarAviso(texto: string): void {
  if (trayMsg === null || tray === null) return;
  trayMsg.textContent = texto;
  trayMsg.hidden = false;
  tray.hidden = false;
}

function limparAviso(): void {
  if (trayMsg === null) return;
  trayMsg.textContent = "";
  trayMsg.hidden = true;
}

/**
 * Esvazia a bandeja. `motivo` decide o destino do blob: no DESCARTE a URL é
 * revogada na hora; no ENVIO ela sobrevive um instante, porque
 * `restoreComposerAttachments()` pode devolver o mesmo anexo à bandeja se o
 * POST da mensagem falhar (e um `src` revogado viraria imagem quebrada).
 */
function esvaziarBandeja(motivo: "enviado" | "descartado"): void {
  const guardadas = new Map<string, string>();
  for (const item of anexos) {
    item.abort.abort();
    item.card.remove();
    if (motivo === "enviado" && item.anexo !== null && item.url !== "") {
      guardadas.set(item.anexo.id, item.url);
    } else if (item.url !== "") {
      URL.revokeObjectURL(item.url);
    }
  }
  // revoga a leva ANTERIOR, menos o que acabou de ser reaproveitado (um anexo
  // restaurado e reenviado carrega a mesma URL das duas vezes)
  for (const [id, url] of urlsDoUltimoEnvio) {
    if (guardadas.get(id) !== url) URL.revokeObjectURL(url);
  }
  urlsDoUltimoEnvio.clear();
  for (const [id, url] of guardadas) urlsDoUltimoEnvio.set(id, url);
  anexos.length = 0;
  envioPendente = false;
  limparAviso();
  pintarBandeja();
}

/**
 * Miniaturas do ÚLTIMO envio, para o restore não perder o preview. É um mapa
 * de UMA leva só: o `esvaziarBandeja` revoga a leva anterior antes de guardar
 * a nova, então o consumo é limitado ao que cabe numa mensagem (10 imagens).
 */
const urlsDoUltimoEnvio = new Map<string, string>();

/**
 * Devolve à bandeja anexos que JÁ subiram (o `onSubmit` recebeu, mas o POST da
 * mensagem falhou). Sem isto o texto voltaria pelo `setComposerValue()` e a
 * imagem sumiria em silêncio — o pior desfecho possível, porque o arquivo pode
 * ter sido uma print que a pessoa nem salvou.
 *
 * NÃO há upload aqui: o anexo já existe no servidor (e o relógio de órfão dele
 * só começa a contar quando ele fica 15 minutos sem mensagem).
 */
export function restoreComposerAttachments(lista: Attachment[]): void {
  if (tray === null || lista.length === 0) return;
  for (const anexo of lista.slice(0, MAX_ATTACHMENTS_PER_MESSAGE - anexos.length)) {
    const card = document.createElement("div");
    card.className = "attach-card";

    const url = urlsDoUltimoEnvio.get(anexo.id) ?? null;
    if (url !== null) {
      const img = document.createElement("img");
      img.className = "attach-thumb";
      img.alt = "";
      img.src = url;
      card.append(img);
    } else {
      // sem miniatura (recarregou a página no meio): um bloco neutro, e não
      // uma imagem quebrada — o `GET /api/attachments/:id` exige Authorization
      // e um <img src> não manda header
      const vazio = document.createElement("div");
      vazio.className = "attach-thumb attach-thumb-empty";
      vazio.append(icon("plus", 16));
      card.append(vazio);
    }

    const meta = document.createElement("div");
    meta.className = "attach-meta";
    const nome = document.createElement("span");
    nome.className = "attach-name";
    nome.textContent = anexo.filename;
    nome.title = anexo.filename;
    const sub = document.createElement("span");
    sub.className = "attach-sub";
    meta.append(nome, sub);

    const remover = document.createElement("button");
    remover.type = "button";
    remover.className = "icon-btn attach-remove";
    remover.setAttribute("aria-label", `Remover ${anexo.filename}`);
    remover.title = "Remover";
    remover.append(icon("close", 14));
    card.append(meta, remover);

    const item: AnexoLocal = {
      // não há File de volta (o restore vem do anexo do servidor); o size sai
      // do próprio anexo e o `arquivo` só é usado para nome e tamanho
      arquivo: new File([], anexo.filename, { type: anexo.mime }),
      url: url ?? "",
      abort: new AbortController(),
      card,
      sub,
      estado: "pronto",
      anexo,
      erro: null,
    };
    // o tamanho verdadeiro vem do servidor, não do File vazio acima
    sub.textContent = formatBytes(anexo.size_bytes);
    remover.addEventListener("click", () => removerAnexo(item));
    anexos.push(item);
    trayItens?.append(card);
    card.dataset["estado"] = "pronto";
  }
  pintarBandeja();
}

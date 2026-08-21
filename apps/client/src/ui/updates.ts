/**
 * Auto-update visto do lado do renderer (M14; fecha o roadmap 107).
 *
 * ---------------------------------------------------------------------------
 * POR QUE É O RENDERER QUEM MANDA CHECAR
 * ---------------------------------------------------------------------------
 *
 * O feed de atualização é PRIVADO (o instalador leva os sons proprietários
 * dentro — ATTRIBUTIONS.md), e a credencial que o abre é um tíquete que só sai
 * para quem tem sessão. O processo main do Electron não tem sessão: ele guarda
 * os segredos cifrados, mas quem sabe se eles ainda valem — e quem os renova —
 * é este lado. Então o main virou executor (`updateCheck(ticket)`) e a decisão
 * de QUANDO checar mora aqui, onde "estou logado" é uma pergunta respondível.
 *
 * ---------------------------------------------------------------------------
 * O QUE ACONTECE SOZINHO E O QUE PRECISA DE UM CLIQUE
 * ---------------------------------------------------------------------------
 *
 * A checagem e o DOWNLOAD são automáticos (`autoDownload` no updater.ts). A
 * INSTALAÇÃO não é forçada, e isso é decisão: instalar significa fechar o app,
 * e fechar o app no meio de uma chamada de voz é a pior coisa que um
 * atualizador pode fazer com este projeto em particular. Então:
 *
 *   - baixou → aparece a faixa com "Reiniciar agora";
 *   - ninguém clicou → o `autoInstallOnAppQuit` instala no dia em que a pessoa
 *     sair de verdade pelo menu do tray. Ninguém fica para trás por ignorar o
 *     aviso; só demora mais.
 */
import type { UiContext } from "./context.js";
import { getAccessToken } from "../auth.js";
import { desktop } from "../bridge.js";
import { el } from "./dialog.js";

/**
 * De quanto em quanto tempo re-checar com o app aberto.
 *
 * 6 h e não "uma vez no boot": este app mora na bandeja, e um cliente que fica
 * semanas sem reiniciar nunca veria uma versão nova — que é exatamente o perfil
 * de uso que o tray criou (M6). E não menos que isso porque cada checagem custa
 * um tíquete (`POST /api/updates/ticket`) e uma ida do servidor à API do
 * GitHub; com dez amigos, 6 h dá ~40 checagens por dia, que some no cache de
 * 5 min do servidor.
 */
export const INTERVALO_CHECAGEM_MS = 6 * 60 * 60_000;

export interface UpdatesOptions {
  ctx: UiContext;
  /** o `api()` do main.ts — com renovação de token e leitura de erro */
  api: (path: string, init?: RequestInit) => Promise<unknown>;
}

/** guarda de "já montei": o main.ts chama isto a cada login, e o app não recarrega */
let montado = false;
let faixa: HTMLElement | null = null;

/**
 * Checa uma vez. Nunca lança — nem falta de rede, nem servidor em deploy, nem
 * servidor sem release configurado são erro para quem está usando o app, e um
 * `throw` daqui viraria uma rejeição não tratada num timer.
 */
async function checar(opts: UpdatesOptions): Promise<void> {
  const bridge = desktop;
  if (bridge === undefined) return;
  // Sem sessão não há tíquete, e insistir seria pior que não checar: o `api()`
  // do main.ts trata 401 tentando renovar e, falhando, DESLOGA — um timer de
  // 6 h derrubando a tela de login de quem já está deslogado.
  if (getAccessToken() === null) return;
  try {
    const { ticket } = (await opts.api("/api/updates/ticket", { method: "POST" })) as { ticket: string };
    const versao = await bridge.updateCheck(ticket);
    if (versao !== null) console.log("[update] versão disponível:", versao);
  } catch (err) {
    // console e não tela: a pessoa não pediu esta checagem e não pode fazer
    // nada a respeito. O que ela precisa ver é o resultado FELIZ (a faixa).
    console.warn("[update] checagem não deu certo", err);
  }
}

/**
 * A faixa. Só aparece quando há uma versão baixada e pronta — antes disso não
 * existe nada acionável para mostrar, e uma barra de progresso de download que
 * ninguém pediu é ruído.
 */
function mostrarFaixa(versao: string, opts: UpdatesOptions): void {
  const bridge = desktop;
  if (bridge === undefined) return;
  faixa?.remove();

  const box = el("div", "upd-toast");
  // status e não alert: é uma boa notícia que pode esperar, e `alert`
  // interromperia a leitura de quem está no meio de uma mensagem
  box.setAttribute("role", "status");
  box.append(el("div", "upd-title", `Danjocord ${versao} está pronto`));

  // A frase muda com a chamada, porque a CONSEQUÊNCIA muda: fora dela reiniciar
  // custa segundos; dentro, derruba a voz de quem está falando agora.
  const naChamada = opts.ctx.state.voiceChannelId !== null;
  box.append(
    el(
      "div",
      "upd-body",
      naChamada
        ? "Reiniciar agora vai te desconectar da chamada. Se preferir, a atualização é instalada sozinha quando você sair do app."
        : "Reiniciar leva alguns segundos. Se preferir, ela é instalada sozinha quando você sair do app.",
    ),
  );

  const acoes = el("div", "upd-actions");
  const depois = el("button", "upd-later", "Depois");
  depois.type = "button";
  depois.addEventListener("click", () => fecharFaixa());

  const agora = el("button", "upd-now", "Reiniciar agora");
  agora.type = "button";
  agora.addEventListener("click", () => {
    agora.disabled = true;
    agora.textContent = "reiniciando…";
    void bridge.updateInstall().then(
      (ok) => {
        // false = o main não tinha nada baixado (e NÃO fechou o app). Acontece
        // se a faixa sobreviveu a um estado que o main já esqueceu; some em vez
        // de deixar um botão que não faz nada na tela.
        if (!ok) fecharFaixa();
      },
      (err: unknown) => {
        console.warn("[update] instalação falhou", err);
        agora.disabled = false;
        agora.textContent = "Reiniciar agora";
      },
    );
  });

  acoes.append(depois, agora);
  box.append(acoes);
  document.body.append(box);
  faixa = box;
}

function fecharFaixa(): void {
  faixa?.remove();
  faixa = null;
}

/**
 * Liga o auto-update. Chamar depois do login (é quando existe sessão para
 * trocar por tíquete). No NAVEGADOR é no-op: não há o que atualizar — a página
 * já é sempre a última versão.
 */
export function mountUpdates(opts: UpdatesOptions): void {
  const bridge = desktop;
  if (bridge === undefined || montado) return;
  montado = true;

  bridge.onUpdateReady((versao) => mostrarFaixa(versao, opts));
  // Consulta o estado ANTES de assinar servir de algo: a janela pode ter sido
  // recriada pelo tray depois de um `closed`, e aí o evento `update-ready` já
  // passou — sem esta linha a atualização ficaria baixada e invisível.
  void bridge.updatePending().then(
    (versao) => {
      if (versao !== null) mostrarFaixa(versao, opts);
    },
    () => undefined,
  );

  void checar(opts);
  // sem clearInterval: este timer vive enquanto o app vive, e o app é a janela.
  // Um logout não o cancela de propósito — checar update não depende de quem
  // está logado, e o `checar` sai calado se o tíquete não sair.
  setInterval(() => void checar(opts), INTERVALO_CHECAGEM_MS);
}

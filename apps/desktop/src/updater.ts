import { autoUpdater } from "electron-updater";

/**
 * Auto-update do app desktop (M14; fecha o roadmap 107).
 *
 * ---------------------------------------------------------------------------
 * O QUE MUDOU DO M6 PARA CÁ, E POR QUÊ
 * ---------------------------------------------------------------------------
 *
 * Até aqui o main chamava `checkForUpdatesAndNotify()` no `ready` e pronto.
 * Duas coisas nesse desenho não funcionam neste projeto:
 *
 * 1. **O feed é PRIVADO.** O `publish` do package.json aponta para
 *    `LeoHammes1/Danjocord`, que é um repo privado — o electron-updater bateria
 *    em `api.github.com` sem credencial e levaria 404 para sempre. A alternativa
 *    óbvia (embutir um token do GitHub no instalador) é entregar a credencial a
 *    quem tiver o `.exe`. Por isso o feed é o NOSSO servidor
 *    (`/api/updates/feed/`), autenticado por tíquete: o token do GitHub fica no
 *    Secret do cluster e nunca sai de lá.
 *
 * 2. **Checar no `ready` é cedo demais.** O tíquete precisa de sessão, e no
 *    `ready` ainda não houve login. Quem dispara a checagem agora é o RENDERER,
 *    depois de logar — ele é o único lado que sabe se há sessão e o único que
 *    tem um access token fresco para trocar por tíquete.
 *
 * ---------------------------------------------------------------------------
 * DOWNLOAD DIFERENCIAL: DESLIGADO, DE PROPÓSITO
 * ---------------------------------------------------------------------------
 *
 * O `blockmap` do electron-updater baixa só os pedaços que mudaram — em geral
 * uma boa ideia, e aqui uma má. Ele o faz com muitas requisições de RANGE, e no
 * nosso feed CADA requisição vira uma ida à API do GitHub para emitir uma URL
 * pré-assinada nova (`updates/routes.ts`). Trocar ~100 MB de CDN por dezenas de
 * chamadas de API — com o rate limit do GitHub no meio e o pod pagando a
 * latência de cada uma — é pior nos dois eixos que importam: tempo até
 * atualizar e superfície que pode falhar. Uma release nova acontece raramente e
 * os bytes vêm do CDN do GitHub, não do nó da mídia.
 */

/**
 * A URL base do feed `generic`.
 *
 * **A BARRA NO FIM NÃO É ESTILO.** O electron-updater resolve cada arquivo com
 * `new URL(nome, base)`. Sem a barra, `new URL("latest.yml", ".../feed?t=x")`
 * dá `.../latest.yml` — o último segmento é SUBSTITUÍDO, e a rota
 * `/api/updates/feed/:file` nunca é alcançada. O sintoma seria um 404 do
 * fallback de SPA (index.html com content-type de HTML), que o updater relata
 * como YAML inválido.
 *
 * E a QUERY é o que carrega a credencial: o `newUrlFromBase` do
 * electron-updater propaga a query da base para todo arquivo que resolve. É o
 * mecanismo documentado para feed privado, e é por isso que o tíquete vai ali
 * em vez de num header — header vazaria para o CDN do GitHub ao seguir o 302.
 */
export function feedUrl(serverUrl: string, ticket: string): string {
  const base = serverUrl.replace(/\/+$/, "");
  return `${base}/api/updates/feed/?ticket=${encodeURIComponent(ticket)}`;
}

/** A versão já baixada e esperando reinício, ou null. */
let baixada: string | null = null;
/** true entre o começo de uma checagem e o fim dela — evita checagens sobrepostas. */
let ocupado = false;

export function versaoBaixada(): string | null {
  return baixada;
}

/**
 * Liga os listeners UMA vez. `aoFicarPronta` avisa o renderer, que mostra a
 * faixa de "reiniciar para atualizar" — sem ela, um app que mora na bandeja
 * ficaria com a atualização baixada e parada até o dia em que alguém saísse de
 * verdade.
 */
export function configurarUpdater(aoFicarPronta: (versao: string) => void): void {
  autoUpdater.autoDownload = true;
  // o padrão já é true; explícito porque é ele que faz a atualização acontecer
  // sozinha para quem nunca clica na faixa — o app fecha, o NSIS roda
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true; // ver o cabeçalho
  autoUpdater.logger = {
    info: (m: unknown) => console.log("[updater]", m),
    warn: (m: unknown) => console.warn("[updater]", m),
    error: (m: unknown) => console.error("[updater]", m),
    debug: () => undefined,
  };

  autoUpdater.on("update-available", (info) => console.log("[updater] versão nova:", info.version));
  autoUpdater.on("update-not-available", () => console.log("[updater] já está na última versão"));
  autoUpdater.on("download-progress", (p) => console.log(`[updater] baixando ${Math.round(p.percent)}%`));
  autoUpdater.on("update-downloaded", (info) => {
    baixada = info.version;
    console.log("[updater] baixada e pronta para instalar:", info.version);
    aoFicarPronta(info.version);
  });
  autoUpdater.on("error", (err) => console.warn("[updater] erro", err));
}

/**
 * Checa (e, havendo versão nova, baixa) usando um tíquete recém-emitido.
 *
 * Devolve a versão disponível ou null. **Nunca lança**: sem rede, sem release
 * publicado, tíquete vencido, servidor em deploy — nada disso é erro para quem
 * está usando o app, e um `unhandledRejection` no main mataria o processo
 * inteiro por causa de uma checagem de update.
 */
export async function checarAtualizacao(serverUrl: string, ticket: string): Promise<string | null> {
  if (ocupado) return null;
  ocupado = true;
  try {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl(serverUrl, ticket) });
    const resultado = await autoUpdater.checkForUpdates();
    return resultado?.updateInfo.version ?? null;
  } catch (err) {
    console.warn("[updater] checagem falhou", err);
    return null;
  } finally {
    ocupado = false;
  }
}

/**
 * Sai e instala. `isSilent` porque o instalador é `oneClick` (não há assistente
 * para mostrar) e `isForceRunAfter` para o app voltar sozinho — quem clicou em
 * "Reiniciar agora" está no meio de uma conversa e espera voltar a ela.
 *
 * Devolve false quando não há nada baixado: chamar `quitAndInstall` sem
 * atualização pronta FECHA o app e não instala nada, que é a pior surpresa
 * possível para quem estava numa chamada.
 */
export function instalarAtualizacao(): boolean {
  if (baixada === null) return false;
  console.log("[updater] instalando", baixada);
  autoUpdater.quitAndInstall(true, true);
  return true;
}

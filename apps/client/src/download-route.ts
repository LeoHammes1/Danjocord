/**
 * O "roteamento" de `/download` (M14) — e o caminho de volta depois do OAuth.
 *
 * Módulo à parte, e não dentro do `ui/download-page.ts`, pelo mesmo motivo do
 * `pagination.ts` e do `sound/policy.ts`: aqui não há import de nada que só
 * exista no navegador, então o Node consegue carregá-lo e as decisões viram
 * testáveis sem DOM. O `download-page.ts` importa `auth.ts`, que importa
 * `bridge.ts`, que lê `window` no topo — um teste que tocasse nele morreria no
 * import.
 *
 * Não existe roteador neste cliente (decisão do M7: TypeScript puro, DOM
 * imperativo). O roteamento é isto: duas funções puras olhando o `pathname`.
 */

const ROTA = /^\/download\/?$/;

/** `/download` (com ou sem barra final) → true. */
export function isDownloadRoute(pathname: string = location.pathname): boolean {
  return ROTA.test(pathname);
}

/**
 * Onde a aba deve voltar depois do OAuth.
 *
 * O fluxo de login traz o navegador para a RAIZ (`APP_URL`, definido no
 * servidor), então o `/download` se perde no meio do caminho: sem isto, quem
 * clica em "Entrar com Discord" na página de download loga e cai no chat, e
 * tem que descobrir sozinho como voltar.
 *
 * `sessionStorage` e não `localStorage`: é intenção de UMA aba e de UMA vez, e
 * não pode sobreviver a nada. E não é credencial — o código de convite, que É
 * credencial, continua viajando no `state` assinado do OAuth, justamente para
 * não poder ser trocado no meio do caminho.
 */
const CHAVE_VOLTA = "danjocord_depois_do_login";

export function lembrarVoltaParaDownload(): void {
  try {
    sessionStorage.setItem(CHAVE_VOLTA, "/download");
  } catch {
    // modo privativo, storage cheio, ou Node num teste: perder o caminho de
    // volta é chato, não é erro — a pessoa loga e cai no app, que funciona
  }
}

/** Consome a intenção (serve uma vez só). Chamada pelo boot depois do OTC. */
export function consumirVoltaParaDownload(): boolean {
  try {
    const alvo = sessionStorage.getItem(CHAVE_VOLTA);
    sessionStorage.removeItem(CHAVE_VOLTA);
    return alvo === "/download";
  } catch {
    return false;
  }
}

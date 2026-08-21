/**
 * A ponte desktop (M6, doc §7): o preload do Electron (pacote A) expõe esta
 * superfície em window.danjocord via contextBridge.exposeInMainWorld. No
 * NAVEGADOR o campo simplesmente não existe — todo o resto do cliente lê a
 * ponte pelo módulo desktop.ts (uma vez), nunca pelo window direto.
 *
 * RESTRIÇÃO: este tipo é CONTRATO entre os pacotes A (main do Electron) e B
 * (este cliente) — não mudar sem combinar com o preload.
 */
export {};

declare global {
  interface DanjocordDesktop {
    isDesktop: true;
    /** base da API que o main injetou (produção: baked no build; dev: http://localhost:8080) */
    serverUrl: string;
    /** safeStorage: cifrado no main, arquivo em userData */
    secretGet(key: string): Promise<string | null>;
    /** null apaga */
    secretSet(key: string, value: string | null): Promise<void>;
  /** grava vários segredos numa transação só (o trio da sessão não vai pela metade) */
  secretSetMany(entries: [string, string | null][]): Promise<void>;
    /**
     * Fluxo loopback completo: abre o navegador externo em
     * <serverUrl>/auth/discord/start?redirect_port=<porta do listener>;
     * resolve com o OTC; rejeita em timeout (120s) ou erro (auth_error).
     */
    oauthLogin(inviteCode?: string | null): Promise<string>;
    /** instala/troca o hook global; null desliga (uiohook para) */
    pttSetKey(keycode: number | null): Promise<void>;
    /** modo captura p/ remap: próxima tecla pressionada */
    pttCaptureNextKey(): Promise<{ keycode: number; label: string }>;
    /** keydown/keyup da tecla configurada */
    onPtt(cb: (down: boolean) => void): void;

    /**
     * Auto-update (M14). Quem dispara é o RENDERER, e não o main, porque o feed
     * de atualização é privado: o tíquete que o abre só sai para quem tem
     * sessão, e sessão é coisa que só este lado conhece.
     *
     * Devolve a versão disponível, ou null (sem versão nova, sem rede, app não
     * empacotado). NUNCA rejeita por falta de atualização — checar update não é
     * o tipo de coisa que pode virar erro na tela de alguém.
     */
    updateCheck(ticket: string): Promise<string | null>;
    /** A versão já baixada e esperando reinício, ou null. Consultável no mount. */
    updatePending(): Promise<string | null>;
    /** Sai e instala. `false` = não havia nada baixado (e o app NÃO fecha). */
    updateInstall(): Promise<boolean>;
    /** Uma versão terminou de baixar e está pronta para instalar. */
    onUpdateReady(cb: (versao: string) => void): void;
  }

  interface Window {
    danjocord?: DanjocordDesktop;
  }
}

/**
 * Acesso à ponte desktop (M6): lida do window UMA vez, aqui — todo módulo que
 * precisa da ponte importa esta constante. undefined = rodando no navegador
 * (o caminho web continua idêntico ao que sempre foi).
 */
export const desktop: DanjocordDesktop | undefined = window.danjocord;

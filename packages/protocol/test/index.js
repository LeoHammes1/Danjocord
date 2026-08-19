/**
 * Entry do diretório de testes do protocolo (M11a). Mesmo desenho do
 * `apps/server/test/index.js`: o script é `node --test test/` e o Node executa
 * o DIRETÓRIO como um entry point só (via test/index.js) — cada suíte nova
 * precisa ser importada aqui, com a extensão ".ts" explícita.
 *
 * A diferença para o servidor é que aqui NÃO há tsx: o pacote não tem essa
 * dependência (e o M11a não instala nenhuma). Não precisa — o type stripping
 * nativo do Node dá conta porque o módulo testado é PURO: ele não importa nada,
 * então não existe o problema de remapear ".js" → ".ts" que obriga o servidor a
 * registrar os hooks.
 */
import "./mentions.test.ts";

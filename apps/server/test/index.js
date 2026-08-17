/**
 * Entry do diretório de testes. O script "test" é `node --test test/` e o
 * Node (24.x) executa o diretório como UM entry point via resolução de main
 * (test/index.js) — ele não expande o diretório em arquivos *.test.ts. Cada
 * suíte nova precisa ser importada aqui, com a extensão .ts explícita (o
 * type stripping não remapeia ".js" → ".ts").
 */
import "./sessions.test.ts";
// depois de sessions de propósito: os testes de lá com relógio mockado deixam
// o gerador de snowflakes "no futuro", e esta suíte usa banco novo — sem risco
import "./messages.test.ts";

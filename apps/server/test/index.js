/**
 * Entry do diretório de testes. O script "test" é `node --test test/` e o
 * Node (24.x) executa o diretório como UM entry point via resolução de main
 * (test/index.js) — ele não expande o diretório em arquivos *.test.ts. Cada
 * suíte nova precisa ser importada aqui, com a extensão .ts explícita (o
 * type stripping não remapeia ".js" → ".ts").
 */
import "./sessions.test.ts";

/**
 * Entry do diretório de testes do desktop. O script é `node --test test/` e o
 * Node (24.x) executa o diretório como UM entry point via resolução de main
 * (test/index.js) — ele NÃO expande *.test.js. Suíte nova entra aqui, igual ao
 * apps/server e ao apps/client.
 *
 * Aqui é CommonJS (este é o único pacote sem `"type": "module"`, porque o main
 * do Electron é CJS), então é `require` e não `import`, e os testes rodam
 * contra o `dist` construído — o `npm run build` do script de teste garante que
 * ele existe e está fresco.
 */
require("./csp.test.js");
require("./updater.test.js");

/**
 * Entry do diretório de testes do cliente. O script é `node --test test/` e o
 * Node (24.x) executa o diretório como UM entry point via resolução de main
 * (test/index.js) — igual ao apps/server. Cada suíte nova entra aqui, com a
 * extensão .ts explícita.
 *
 * O gancho abaixo faz o que o `tsx/esm/api` faz no servidor: o type stripping
 * do Node NÃO remapeia ".js" → ".ts", e o código do cliente importa com ".js"
 * (convenção do repo inteiro). O cliente não tem tsx nas dependências e o M8
 * não pode instalar nada — então o remap vira estas seis linhas, só para o
 * teste. Nada disso existe no navegador: lá quem resolve é o Vite.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});

await import("./sound-policy.test.ts");
await import("./lru.test.ts");
await import("./markdown.test.ts");
await import("./unread.test.ts");
await import("./emoji.test.ts");
await import("./attachments.test.ts");
await import("./search.test.ts");
await import("./messages-core.test.ts");

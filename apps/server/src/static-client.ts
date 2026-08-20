import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Cliente estático em produção: a imagem copia o build do vite
 * (apps/client/dist) para <raiz do pacote server>/client-dist e ele é servido
 * na MESMA origem do backend — sem CORS, sem segundo processo. Em dev o
 * diretório não existe e o vite (:5173) segue sendo o servidor do cliente.
 */

// Mesmo padrão do migrationsDir (db/index.ts): resolve a partir do próprio
// módulo, que fica um nível abaixo da raiz do pacote tanto em src/ (tsx)
// quanto em dist/ (build).
const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..", "client-dist");

/** Prefixos que pertencem ao backend — nunca caem no fallback de SPA. */
const RESERVED_PREFIXES = ["/api", "/auth", "/gateway", "/healthz"];

/**
 * `dir` existe para o TESTE, e o default é o de produção — o `index.ts` chama
 * sem argumento. Sem isto o único jeito de exercitar este módulo seria criar
 * `apps/server/client-dist` de verdade no meio da suíte, que atropelaria o
 * build local de quem tivesse um. Ele é o arquivo que define o que NÃO cai no
 * fallback de SPA, e isso precisa de rede antes de trocar de major do
 * `@fastify/static`.
 */
export function registerStaticClient(app: FastifyInstance, dir: string = clientDir): void {
  if (!existsSync(dir)) {
    app.log.info({ clientDir: dir }, "client-dist ausente — cliente estático desligado (dev usa o vite)");
    return;
  }

  // wildcard: false — o plugin enumera os arquivos do build no boot e registra
  // uma rota por arquivo, deixando o GET /* abaixo livre para o fallback.
  app.register(fastifyStatic, { root: dir, wildcard: false });

  // Fallback de SPA: rota desconhecida devolve o index.html (o roteamento fica
  // no cliente). setNotFoundHandler engoliria também os 404 legítimos de
  // /api etc. — por isso o guard explícito de prefixos.
  app.get("/*", (req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    // /assets/ também não cai no fallback: um bundle de hash antigo (aba
    // aberta durante um deploy) deve receber 404, não o index.html com MIME
    // errado — que viraria um erro críptico de módulo ES no navegador
    if (RESERVED_PREFIXES.some((p) => path.startsWith(p)) || path.startsWith("/assets/")) {
      return reply.callNotFound();
    }
    return reply.sendFile("index.html");
  });
}

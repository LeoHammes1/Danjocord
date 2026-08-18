// Bundle do renderer (M6): o cliente Electron é casca fina — a UI é o MESMO
// bundle web de apps/client. Este script roda o build do cliente com a base
// da API baked (VITE_API_BASE) e copia apps/client/dist → renderer-dist, que
// o main serve via app:// em produção. Também carimba o serverUrl usado num
// danjocord-server-url.json ao lado do bundle: a ponte (window.danjocord
// .serverUrl) lê DALI — ponte e bundle nunca divergem.
//
// Uso: pnpm --filter @danjocord/desktop bundle-renderer
//      (DANJOCORD_SERVER_URL=... para apontar para outro servidor)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/desktop/scripts
const desktopDir = path.join(here, "..");
const repoRoot = path.join(desktopDir, "..", "..");
const clientDist = path.join(repoRoot, "apps", "client", "dist");
const rendererDist = path.join(desktopDir, "renderer-dist");

const serverUrl = process.env.DANJOCORD_SERVER_URL ?? "https://danjocord.leohammes.dev";

console.log(`[bundle-renderer] build do cliente com VITE_API_BASE=${serverUrl}`);
const result = spawnSync("pnpm", ["--filter", "@danjocord/client", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  // pnpm é .cmd no Windows — sem shell o spawn não o encontra
  shell: process.platform === "win32",
  env: { ...process.env, VITE_API_BASE: serverUrl },
});
if (result.status !== 0) {
  console.error("[bundle-renderer] build do cliente falhou");
  process.exit(result.status ?? 1);
}
if (!existsSync(clientDist)) {
  console.error(`[bundle-renderer] ${clientDist} não existe após o build — algo muito errado`);
  process.exit(1);
}

rmSync(rendererDist, { recursive: true, force: true });
mkdirSync(rendererDist, { recursive: true });
cpSync(clientDist, rendererDist, { recursive: true });
// snake_case no fio (e em arquivos que cruzam pacotes) — convenção do repo
writeFileSync(
  path.join(rendererDist, "danjocord-server-url.json"),
  JSON.stringify({ server_url: serverUrl }, null, 2),
  "utf8",
);
console.log(`[bundle-renderer] bundle copiado para ${rendererDist} (server_url=${serverUrl})`);

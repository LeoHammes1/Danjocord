import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();
process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerLinkRoutes } = await import("../src/links/routes.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poc-preview-"));
const dbPath = path.join(dir, "poc.db");
const db = openDb(dbPath);
const store = new Store(db);
const app = Fastify();
registerLinkRoutes(app, store);

function bigUrl(i: number): string {
  const host = `x${i}${"a".repeat(50)}.invalid`;
  const pad = "p".repeat(2040 - `http://${host}/`.length);
  return `http://${host}/${pad}`;
}
async function hit(user: string, url: string) {
  return app.inject({
    method: "GET",
    url: `/api/link-preview?url=${encodeURIComponent(url)}`,
    headers: { authorization: `Bearer dev.${user}` },
  });
}
function size(): number {
  db.pragma("wal_checkpoint(TRUNCATE)");
  return fs.statSync(dbPath).size;
}

test("PoC: custo marginal por linha e permanencia", async () => {
  await hit("warmup", "http://warmupaaaa.invalid/");
  const base = size();
  const baseRows = Number((db.prepare("SELECT COUNT(*) AS n FROM link_previews").get() as { n: bigint }).n);
  console.log("baseline:", base, "bytes,", baseRows, "linhas");

  const N = 600;
  for (let i = 0; i < N; i++) {
    const res = await hit(`u${Math.floor(i / 30)}`, bigUrl(i + 1));
    assert.equal(res.statusCode, 200, `pedido ${i}: ${res.statusCode} ${res.body.slice(0, 120)}`);
  }
  const after = size();
  const rows = Number((db.prepare("SELECT COUNT(*) AS n FROM link_previews").get() as { n: bigint }).n);
  const perRow = (after - base) / N;
  console.log("depois:", after, "bytes,", rows, "linhas");
  console.log("BYTES POR LINHA (marginal):", perRow.toFixed(0));

  const future = Date.now() + 365 * 24 * 3600_000;
  const vivas = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM link_previews WHERE expires_at > ?").get(future) as { n: bigint }).n,
  );
  console.log("linhas ainda uteis daqui a 1 ano:", vivas, "de", rows);

  // 30/min de UM usuario
  const perDay = 30 * 60 * 24 * perRow;
  console.log("um atacante sozinho:", (perDay / 1024 / 1024).toFixed(1), "MB/dia");
  console.log("dias para encher 2 GiB:", (2 * 1024 * 1024 * 1024 / perDay).toFixed(1));
});

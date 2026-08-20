import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
register();
process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerLinkRoutes, NEGATIVE_TTL_MS } = await import("../src/links/routes.js");

const db = openDb(":memory:");
const store = new Store(db);
const app = Fastify();
registerLinkRoutes(app, store, { fetchDeps: { resolve: async () => { throw new Error("ENOTFOUND"); } } });

const rows = (): number => Number((db.prepare("SELECT count(*) c FROM link_previews").get() as { c: bigint }).c);

test("POC: cache negativo acumula linha por URL e nada apaga", async () => {
  const junk = "b".repeat(1980);
  for (let i = 0; i < 30; i++) {
    const url = `http://${String(i).padStart(6, "0")}${junk}.example.com/`;
    const res = await app.inject({ method: "GET", url: `/api/link-preview?url=${encodeURIComponent(url)}`, headers: { authorization: "Bearer dev.leo" } });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { ok: boolean }).ok, false);
  }
  console.log("linhas apos 30 pedidos:", rows());
  assert.equal(rows(), 30);

  const futuro = Date.now() + NEGATIVE_TTL_MS + 1;
  const url0 = `http://000000${junk}.example.com/`;
  assert.equal(store.getLinkPreview(url0, futuro), null);
  console.log("depois de vencer -> getLinkPreview:", store.getLinkPreview(url0, futuro), "| linhas:", rows());
  assert.equal(rows(), 30);
});

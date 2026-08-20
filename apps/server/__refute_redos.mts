/** TEMP auditoria: ponta a ponta com os modulos REAIS. Apagar. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchHtmlForPreview, MAX_HTML_BYTES } from "./src/links/fetch.js";
import { blockedAddressReason } from "./src/links/guard.js";
import { extractMeta } from "./src/links/html.js";

const ATTRS = Number(process.env.ATTRS ?? 523000);
const variant = process.env.VARIANT ?? "a";
const body = variant === "a" ? `<meta ${"a".repeat(ATTRS)}>` : "<meta ".repeat(Math.floor(ATTRS / 6));
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

const deps = {
  allowAnyPort: true,
  blockedAddressReason: (ip: string) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)),
};
const t0 = process.hrtime.bigint();
const fetched = await fetchHtmlForPreview(`http://127.0.0.1:${port}/p1`, deps);
const t1 = process.hrtime.bigint();
console.log(
  `variante=${variant} corpo enviado=${Buffer.byteLength(body)} B | teto=${MAX_HTML_BYTES} | html entregue=${fetched.html.length} chars | fetch=${(Number(t1 - t0) / 1e6).toFixed(0)} ms`,
);
const t2 = process.hrtime.bigint();
const meta = extractMeta(fetched.html);
const t3 = process.hrtime.bigint();
console.log(`extractMeta = ${(Number(t3 - t2) / 1e6).toFixed(0)} ms  -> ${JSON.stringify(meta)}`);
server.close();

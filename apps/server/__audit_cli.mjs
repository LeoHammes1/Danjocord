const [appPort, evilPort] = process.argv.slice(2);
const ms = async (f) => { const t = Date.now(); const r = await f(); return [Date.now() - t, r]; };
const health = () => fetch(`http://127.0.0.1:${appPort}/healthz`, { signal: AbortSignal.timeout(10000) })
  .then((r) => String(r.status)).catch((e) => "ERRO:" + e.name);

console.log(`healthz ocioso: ${(await ms(health)).join(" ms / status ")}`);
const url = encodeURIComponent(`http://127.0.0.1:${evilPort}/x?i=1`);
const attack = ms(() => fetch(`http://127.0.0.1:${appPort}/api/link-preview?url=${url}`,
  { headers: { authorization: "Bearer dev.atacante" } }).then((r) => r.status));
await new Promise((r) => setTimeout(r, 400));
for (let i = 0; i < 4; i++) console.log(`healthz DURANTE: ${(await ms(health)).join(" ms / status ")}`);
console.log(`ataque: ${(await attack).join(" ms / status ")}`);

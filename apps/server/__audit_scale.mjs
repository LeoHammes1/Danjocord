import { extractMeta } from "./dist/links/html.js";
const CAP = 512 * 1024;
for (const n of [160000, 250000, CAP - 7]) {
  const html = "<meta " + "a".repeat(n) + ">";
  if (Buffer.byteLength(html) > CAP) { console.log(`n=${n} passa do teto`); continue; }
  const t = process.hrtime.bigint();
  extractMeta(html);
  console.log(`n=${n} (${Buffer.byteLength(html)} B, cabe no teto de ${CAP})\t${(Number(process.hrtime.bigint()-t)/1000).toFixed(0)} ms`);
}

// tsc não copia arquivos que não sejam .ts — o picker.html (HTML/CSS inline
// do seletor de Go Live) precisa ir junto para dist/, de onde o picker.ts o
// carrega via loadFile. Roda como parte do script "build".
import { copyFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src", "picker.html");
const outDir = path.join(here, "..", "dist");
mkdirSync(outDir, { recursive: true });
copyFileSync(src, path.join(outDir, "picker.html"));
console.log("[copy-static] picker.html → dist/");

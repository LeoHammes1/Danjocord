// tsc não copia arquivos que não sejam .ts — o picker.html (HTML/CSS inline
// do seletor de Go Live) precisa ir junto para dist/, de onde o picker.ts o
// carrega via loadFile. Roda como parte do script "build".
//
// M13: deixou de ser um copyFileSync. O picker ganhou o brasão do time, e ele
// entra AQUI em vez de estar colado no HTML por uma razão só: o path é gerado
// (apps/client/scripts/trace-logo.mjs, a partir do PNG da logo) e uma segunda
// cópia à mão ficaria desatualizada no dia em que o time trocasse a marca —
// numa janela que abre por três segundos, ninguém repararia.
//
// Ler o pacote do cliente daqui é feio, e é o menor dos males: a alternativa é
// duplicar 726 bytes de coordenadas. Se o caminho mudar, isto QUEBRA O BUILD
// em vez de silenciosamente publicar um picker sem marca — é o ponto.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src", "picker.html");
const outDir = path.join(here, "..", "dist");
const brasaoSrc = path.join(here, "..", "..", "client", "src", "ui", "brasao-path.ts");

/** Extrai uma constante string do módulo gerado, sem importar TypeScript. */
function constante(fonte, nome) {
  const m = new RegExp(`export const ${nome} =\\s*"([^"]+)"`).exec(fonte);
  if (m === null) {
    throw new Error(
      `[copy-static] não achei ${nome} em ${brasaoSrc}. ` +
        `O gerador do brasão mudou de formato ou de lugar — rode ` +
        `\`node scripts/trace-logo.mjs\` em apps/client e confira o arquivo.`,
    );
  }
  return m[1];
}

const brasao = readFileSync(brasaoSrc, "utf8");
const html = readFileSync(src, "utf8")
  .replaceAll("__BRASAO_VIEWBOX__", constante(brasao, "BRASAO_VIEWBOX"))
  .replaceAll("__BRASAO_PATH__", constante(brasao, "BRASAO_PATH"));

if (html.includes("__BRASAO_")) {
  throw new Error("[copy-static] sobrou um marcador __BRASAO_* no picker.html — a substituição não casou.");
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "picker.html"), html);
console.log("[copy-static] picker.html (+ brasão) → dist/");

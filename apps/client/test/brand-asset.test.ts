/**
 * Os assets de MARCA (M13): o brasão vetorizado e o ícone do app desktop.
 *
 * POR QUE ELE EXISTE, e é o mesmo raciocínio do `sound-assets.test.ts`. O
 * `src/ui/brasao-path.ts` é gerado: 726 bytes de coordenadas que nenhum humano
 * confere de olho. Se alguém trocar `assets/brand/danjomar-logo-fonte.png` — e
 * é para trocar, é a logo de um time — sem rodar o gerador, NADA quebra: o
 * cliente compila, o app sobe e continua desenhando a logo velha. O defeito é
 * invisível até alguém reparar que o app não bate com o site.
 *
 * O amarrador é o sha256 do PNG de origem, carimbado dentro do arquivo gerado.
 * Enquanto os dois baterem, o que está no disco descreve o que está na tela.
 *
 * E o teste vai além do sha porque PODE: ao contrário dos sons — que o Node
 * não decodifica, e por isso a medição vive num JSON produzido pelo Chromium —
 * o vetorizador é Node puro (só zlib). Então aqui dá para REFAZER o trabalho
 * inteiro e comparar, em vez de confiar num carimbo.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gerarFonte, tracar } from "../scripts/trace-logo.mjs";
import { BRASAO_ALTURA, BRASAO_LARGURA, BRASAO_ORIGEM_SHA256, BRASAO_PATH, BRASAO_VIEWBOX } from "../src/ui/brasao-path.js";

const ORIGEM = fileURLToPath(new URL("../assets/brand/danjomar-logo-fonte.png", import.meta.url));
const GERADO = fileURLToPath(new URL("../src/ui/brasao-path.ts", import.meta.url));
const ICONE = fileURLToPath(new URL("../../desktop/assets/icon.png", import.meta.url));
const FONTE = fileURLToPath(new URL("../assets/fonts/orbitron-latin.woff2", import.meta.url));

const REGERAR = "rode `node scripts/trace-logo.mjs` de apps/client";

test("o brasão gerado descreve o PNG que está no disco AGORA", () => {
  const sha = createHash("sha256").update(readFileSync(ORIGEM)).digest("hex");
  assert.equal(
    BRASAO_ORIGEM_SHA256,
    sha,
    `o PNG de origem mudou e o brasão não foi regerado — ${REGERAR}`,
  );
});

test("o arquivo gerado é byte a byte o que o gerador produz hoje", () => {
  // pega o --check do script pelo lado de dentro: se a tolerância, o formato do
  // path ou o cabeçalho mudarem sem alguém regerar, isto reprova
  const esperado = gerarFonte(readFileSync(ORIGEM));
  assert.equal(readFileSync(GERADO, "utf8"), esperado, `brasao-path.ts está desatualizado — ${REGERAR}`);
});

test("o path é um desenho fechado, e não uma tira de coordenadas soltas", () => {
  const inicios = BRASAO_PATH.match(/M/g) ?? [];
  const fechamentos = BRASAO_PATH.match(/Z/g) ?? [];
  assert.equal(inicios.length, fechamentos.length, "todo subpath tem de fechar com Z");
  assert.ok(inicios.length >= 2, "o brasão tem contorno externo e recortes: um subpath só significa que os buracos sumiram");
  // o `fill-rule="evenodd"` do ui/brasao.ts só resolve os recortes se os laços
  // vierem com orientações opostas — o que o gerador garante, e o que se perde
  // em silêncio se alguém "otimizar" o path à mão num editor
  assert.match(BRASAO_PATH, /^M[\d.]/, "o path começa com um moveto absoluto");
  assert.equal(BRASAO_VIEWBOX, `0 0 ${BRASAO_LARGURA} ${BRASAO_ALTURA}`, "o viewBox e as dimensões não podem discordar");
});

test("a vetorização continua fiel à origem (erro medido, não confiado)", () => {
  const r = tracar(readFileSync(ORIGEM));
  // 1% é folga sobre os 0,63% de hoje, que são a borda de antialiasing do PNG.
  // O que este teto pega é uma tolerância afrouxada por engano — a diferença
  // entre "o desenho está certo" e "o desenho virou um hexágono".
  assert.ok(r.erroPct < 1, `a vetorização divergiu ${r.erroPct.toFixed(2)}% da origem (teto: 1%)`);
});

test("o ícone do desktop é grande o bastante para o electron-builder", () => {
  const png = readFileSync(ICONE);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "não é um PNG");
  const largura = png.readUInt32BE(16);
  const altura = png.readUInt32BE(20);
  // o electron-builder REPROVA o build com PNG menor que 256×256, e o erro dele
  // aparece só no workflow de release — longe de quem trocou o ícone
  assert.ok(largura >= 256 && altura >= 256, `ícone ${largura}×${altura}: o electron-builder exige 256×256 ou mais`);
  assert.equal(largura, altura, "o ícone tem de ser quadrado (o brasão é mais largo que alto: entra centralizado)");
  assert.equal(png[25], 6, "o ícone precisa ser RGBA — o fundo transparente é o que faz a bandeja funcionar nos dois temas");
});

test("a Orbitron está no disco e acima do limite de inline do Vite", () => {
  const bytes = statSync(FONTE).size;
  assert.deepEqual([...readFileSync(FONTE).subarray(0, 4)], [0x77, 0x4f, 0x46, 0x32], "não é um woff2 (magic wOF2)");
  // Este teto NÃO é o que protege a fonte — quem protege é a regra do
  // vite.config.ts, que desliga o inline para .woff2 em qualquer tamanho. Isto
  // aqui é o aviso de que a rede foi armada: se um dia a fonte cair abaixo de
  // 4096 B, é a regra do Vite que passa a ser a única coisa entre a tipografia
  // e um `data:` URI barrado pela CSP em produção.
  const config = readFileSync(fileURLToPath(new URL("../vite.config.ts", import.meta.url)), "utf8");
  const regra = /assetsInlineLimit[\s\S]{0,400}?\/([^/]+)\/i\.test\(filePath\) \? false/.exec(config);
  assert.ok(regra !== null, "não achei a regra de assetsInlineLimit no vite.config.ts");
  assert.match(
    "arquivo.woff2",
    new RegExp(regra[1]!, "i"),
    `a regra do vite.config.ts não cobre .woff2 — a fonte (${bytes} B) viraria data: URI se encolhesse`,
  );
});

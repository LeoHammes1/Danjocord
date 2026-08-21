/**
 * Vetorizador do brasão do Danjomar (M13) — PNG → path SVG.
 *
 * POR QUE ESTE ARQUIVO EXISTE, e não um `.svg` largado em assets/:
 *
 * 1. O `ui/icons.ts` do M7 decidiu que ícone é SVGElement construído em JS,
 *    nunca `innerHTML` e nunca arquivo solto — a CSP é apertada e o renderer do
 *    desktop guarda os tokens decifrados. O brasão entra pelo MESMO caminho, e
 *    para isso ele precisa ser um `d=` em TypeScript, não um arquivo.
 * 2. Um `d=` de 700 bytes colado à mão é dado órfão: ninguém sabe de onde veio
 *    nem como refazer quando o time trocar a logo. Este script é a receita de
 *    volta, como o `gen-sounds.mjs` é a dos sons.
 *
 * O QUE ELE DESCOBRIU sobre o arquivo de origem, e que não é óbvio: a logo tem
 * UMA cor só (`rgb(181,23,23)`, 53% dos pixels) — o "branco" do desenho é
 * TRANSPARÊNCIA, não tinta. Por isso a máscara sai do canal alfa e o resultado
 * é um path único com `fill-rule="evenodd"`: o contorno externo e os recortes
 * internos se resolvem pela orientação dos laços, sem precisar de duas cores
 * nem de dois elementos. É o que deixa o brasão herdar `currentColor` como
 * qualquer outro ícone do projeto.
 *
 * O PNG de origem (`assets/brand/`) NÃO entra no bundle: nada em `src/` o
 * importa, então o Vite nunca o vê. Ele existe para este script e para o teste.
 *
 * Uso:  node scripts/trace-logo.mjs [--eps 1.6] [--check]
 *       --check  não escreve; sai 1 se o arquivo gerado estiver desatualizado
 *                (é o que o test/brand-asset.test.ts usa)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../assets/brand/danjomar-logo-fonte.png");
const OUT = resolve(HERE, "../src/ui/brasao-path.ts");
/* O ícone do desktop cruza a fronteira do pacote de propósito — ver o bloco
   "O ícone do app desktop" mais abaixo. */
const OUT_ICONE = resolve(HERE, "../../desktop/assets/icon.png");

/** A cor da marca. É a MESMA do --brand do tokens.css; o ícone é a única
    superfície do projeto fora do alcance de uma variável CSS. */
const COR_MARCA = "#d41824";

/**
 * Tolerância do Douglas-Peucker, em pixels do PNG de origem (1048 × 944).
 *
 * Foi MEDIDA, não escolhida no olho: o script rasteriza o path de volta e
 * compara com a máscara original, pixel a pixel. De 1.6 para 1.0 o path engorda
 * 8× (726 B → 5,8 kB) e o erro cai só de 0,63% para 0,48% da área — e essa
 * sobra é a borda de antialiasing do PNG, que polígono nenhum reproduz. Numa
 * sobreposição em modo diferença com ganho 8× o que aparece é uma linha de
 * 1 px no contorno, nada estrutural. No maior tamanho de uso (140 px no login)
 * cada segmento mede menos de 0,25 px na tela.
 */
const EPS_PADRAO = 1.6;

// ---------------------------------------------------------------------------
// PNG → máscara
// ---------------------------------------------------------------------------

/** Decodificador mínimo: só o que este PNG é (RGBA, 8 bits, sem entrelaçamento). */
function decodePng(buf) {
  let o = 8;
  let ihdr = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString("latin1");
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  if (ihdr === null) throw new Error("PNG sem IHDR");
  if (ihdr.depth !== 8 || ihdr.color !== 6 || ihdr.interlace !== 0) {
    // não é limitação a corrigir: é um alarme. Se a logo voltar noutro formato,
    // o desenho mudou, e re-medir a tolerância é parte do trabalho.
    throw new Error(`PNG fora do formato esperado (RGBA/8/sem entrelaçamento): ${JSON.stringify(ihdr)}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr;
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filtro = raw[p++];
    const linha = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = linha[x];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, data: out };
}

// ---------------------------------------------------------------------------
// Máscara → contornos
// ---------------------------------------------------------------------------

function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Arestas da fronteira, orientadas com o "dentro" à esquerda. É essa orientação
 * que faz o contorno externo sair horário e os recortes anti-horários — e é o
 * que o `evenodd` do SVG usa depois para saber o que é buraco. Sem isso seriam
 * precisos dois paths e uma segunda cor.
 */
function contornos(inside, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : inside[y * w + x]);
  const arestas = new Map();
  const push = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    let l = arestas.get(k);
    if (l === undefined) arestas.set(k, (l = []));
    l.push([x2, y2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) push(x, y, x + 1, y);
      if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) push(x, y + 1, x, y);
    }
  }

  const lacos = [];
  let restantes = 0;
  for (const l of arestas.values()) restantes += l.length;
  while (restantes > 0) {
    let inicioK = null;
    for (const [k, l] of arestas) {
      if (l.length) {
        inicioK = k;
        break;
      }
    }
    if (inicioK === null) break;
    const inicio = inicioK.split(",").map(Number);
    const laco = [inicio];
    let cur = inicio;
    let dirAnterior = null;
    for (;;) {
      const l = arestas.get(`${cur[0]},${cur[1]}`);
      if (l === undefined || l.length === 0) break;
      let idx = 0;
      if (l.length > 1 && dirAnterior !== null) {
        // vértice ambíguo (dois cantos se tocando na diagonal): virar o mais à
        // direita possível é o que mantém os dois contornos separados em vez de
        // fundi-los num laço só que se auto-intersecta
        let melhor = -Infinity;
        l.forEach((n, i) => {
          const d = [n[0] - cur[0], n[1] - cur[1]];
          const cross = dirAnterior[0] * d[1] - dirAnterior[1] * d[0];
          const dot = dirAnterior[0] * d[0] + dirAnterior[1] * d[1];
          const nota = cross !== 0 ? cross * 10 : dot;
          if (nota > melhor) {
            melhor = nota;
            idx = i;
          }
        });
      }
      const prox = l.splice(idx, 1)[0];
      restantes--;
      dirAnterior = [prox[0] - cur[0], prox[1] - cur[1]];
      cur = prox;
      if (cur[0] === inicio[0] && cur[1] === inicio[1]) break;
      laco.push(cur);
    }
    if (laco.length >= 4) lacos.push(laco);
  }
  // área com sinal descarta ruído de 1–2 px e ordena do maior para o menor
  return lacos.filter((l) => Math.abs(area(l)) > 40).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
}

/** Douglas-Peucker num laço fechado. */
function simplificar(pts, eps) {
  if (pts.length < 3) return pts;
  const dist2 = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    if (L === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
    return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
  };
  const rec = (s, e) => {
    let max = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = dist2(pts[i], pts[s], pts[e]);
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (max > eps * eps) return [...rec(s, idx), ...rec(idx, e).slice(1)];
    return [pts[s], pts[e]];
  };
  // corta o laço no ponto mais distante do primeiro: cortar num lugar qualquer
  // criaria um vértice artificial no meio de uma reta
  let longe = 0;
  let melhor = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > melhor) {
      melhor = d;
      longe = i;
    }
  }
  return [...rec(0, longe).slice(0, -1), ...rec(longe, pts.length - 1).slice(0, -1)];
}

// ---------------------------------------------------------------------------
// Aferição: rasteriza o resultado de volta e compara com a origem
// ---------------------------------------------------------------------------

function rasterizar(lacos, w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    const xs = [];
    for (const l of lacos) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        if (a[1] > py !== b[1] > py) xs.push(a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    // par-ímpar: o mesmo critério do fill-rule="evenodd" que o SVG vai usar
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i] - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// O ícone do app desktop
// ---------------------------------------------------------------------------

/*
 * POR QUE O ÍCONE SAI DAQUI, e não é um arquivo que alguém exporta de um
 * editor. O `apps/desktop/assets/icon.png` alimenta QUATRO coisas ao mesmo
 * tempo (a janela, a barra de tarefas, a bandeja e o instalador NSIS), e até o
 * M13 ele era um quadrado azul com barras de equalizador que não tinha relação
 * com o Danjocord nem com o Danjomar. Gerá-lo do MESMO PNG que gera o path do
 * cliente é o que garante que os dois nunca divirjam — é o mesmo motivo pelo
 * qual o `measure-sounds` e o `catalog.ts` são amarrados por sha256.
 *
 * O electron-builder converte PNG para .ico sozinho, mas REPROVA abaixo de
 * 256×256; e o `Danjomar.ico` do site não serve (uma entrada só, 32×29, nem
 * quadrada). Então o que ele quer é PNG quadrado grande — daí os 512.
 */

const TAB_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TAB_CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunkPng(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** Codificador mínimo: RGBA 8 bits, filtro 0 em toda linha. */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkPng("IHDR", ihdr),
    chunkPng("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunkPng("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Rasteriza os laços numa tela quadrada com supersampling.
 *
 * O antialiasing NÃO é enfeite aqui: o Electron reduz este mesmo arquivo a
 * 16×16 para a bandeja, e uma borda dura vira serrilha visível nesse tamanho.
 * Amostrar SS× em cada eixo e tirar a média dá a cobertura por pixel, que vira
 * o alfa — o mesmo que o PNG de origem tem e que a máscara binária jogou fora.
 */
function rasterizarIcone(lacos, larguraFonte, alturaFonte, tamanho, corHex, margemPct = 0.1) {
  const SS = 4;
  const N = tamanho * SS;
  const cobertura = new Uint16Array(tamanho * tamanho);

  // encaixa o desenho no quadrado preservando a proporção, com margem
  const util = tamanho * (1 - 2 * margemPct);
  const escala = Math.min(util / larguraFonte, util / alturaFonte);
  const offX = (tamanho - larguraFonte * escala) / 2;
  const offY = (tamanho - alturaFonte * escala) / 2;

  for (let sy = 0; sy < N; sy++) {
    // volta da tela para as coordenadas do desenho
    const py = ((sy + 0.5) / SS - offY) / escala;
    const xs = [];
    for (const l of lacos) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        if (a[1] > py !== b[1] > py) xs.push(a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    if (xs.length === 0) continue;
    xs.sort((p, q) => p - q);
    const linha = Math.floor(sy / SS) * tamanho;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil((xs[i] * escala + offX) * SS - 0.5));
      const x1 = Math.min(N - 1, Math.floor((xs[i + 1] * escala + offX) * SS - 0.5));
      for (let sx = x0; sx <= x1; sx++) cobertura[linha + Math.floor(sx / SS)]++;
    }
  }

  const r = parseInt(corHex.slice(1, 3), 16);
  const g = parseInt(corHex.slice(3, 5), 16);
  const b = parseInt(corHex.slice(5, 7), 16);
  const px = Buffer.alloc(tamanho * tamanho * 4);
  const max = SS * SS;
  for (let i = 0; i < tamanho * tamanho; i++) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    // fundo TRANSPARENTE, e não uma placa escura: na bandeja do Windows o que
    // aparece atrás é a barra de tarefas, que muda de cor com o tema
    px[i * 4 + 3] = Math.round((Math.min(cobertura[i], max) / max) * 255);
  }
  return encodePng(tamanho, tamanho, px);
}

// ---------------------------------------------------------------------------

export function tracar(pngBuf, eps = EPS_PADRAO) {
  const { w, h, data } = decodePng(pngBuf);
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = data[i * 4 + 3] >= 128 ? 1 : 0;

  const lacos = contornos(inside, w, h).map((l) => simplificar(l, eps));
  const n = (v) => (Math.round(v * 10) / 10).toString();
  const d = lacos.map((l) => `M${l.map((p) => `${n(p[0])} ${n(p[1])}`).join("L")}Z`).join("");

  const refeito = rasterizar(lacos, w, h);
  let divergentes = 0;
  let acesos = 0;
  for (let i = 0; i < w * h; i++) {
    if (inside[i]) acesos++;
    if (refeito[i] !== inside[i]) divergentes++;
  }

  return {
    d,
    lacos,
    largura: w,
    altura: h,
    pontos: lacos.reduce((s, l) => s + l.length, 0),
    erroPct: (100 * divergentes) / acesos,
  };
}

export function gerarFonte(pngBuf, eps = EPS_PADRAO) {
  const r = tracar(pngBuf, eps);
  const sha = createHash("sha256").update(pngBuf).digest("hex");
  return `/**
 * GERADO por scripts/trace-logo.mjs — não editar à mão.
 * Refazer:  node scripts/trace-logo.mjs
 *
 * Brasão do Danjomar vetorizado de assets/brand/danjomar-logo-fonte.png.
 * O desenho tem uma cor só (o "branco" é transparência), então é UM path com
 * fill-rule="evenodd": ${r.lacos.length} laços, ${r.pontos} pontos.
 *
 * Fidelidade aferida rasterizando o path de volta: ${r.erroPct.toFixed(2)}% da área diverge,
 * e é a borda de antialiasing do PNG — nada estrutural (tolerância eps=${eps}).
 */

/** sha256 do PNG de origem — o teste reprova se o arquivo mudar sem regerar. */
export const BRASAO_ORIGEM_SHA256 = "${sha}";

/** viewBox do path: a resolução do PNG de origem, sem reescala (sem perda). */
export const BRASAO_VIEWBOX = "0 0 ${r.largura} ${r.altura}";

/**
 * A proporção, já em número. Sai daqui em vez de ser reparseada do viewBox
 * porque com \`noUncheckedIndexedAccess\` cada índice de um split vira
 * \`number | undefined\` — e enfeitar o chamador com guardas para reaver um
 * dado que o gerador já tinha na mão é ruído, não segurança.
 */
export const BRASAO_LARGURA = ${r.largura};
export const BRASAO_ALTURA = ${r.altura};

export const BRASAO_PATH =
  "${r.d}";
`;
}

// ---------------------------------------------------------------------------

const ehPrincipal = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (ehPrincipal) {
  const args = process.argv.slice(2);
  const iEps = args.indexOf("--eps");
  const eps = iEps >= 0 ? Number(args[iEps + 1]) : EPS_PADRAO;
  const png = readFileSync(SRC);
  const fonte = gerarFonte(png, eps);

  if (args.includes("--check")) {
    let atual = "";
    try {
      atual = readFileSync(OUT, "utf8");
    } catch {
      /* ainda não existe */
    }
    if (atual !== fonte) {
      console.error("brasao-path.ts está desatualizado — rode: node scripts/trace-logo.mjs");
      process.exit(1);
    }
    console.log("brasao-path.ts em dia.");
  } else {
    const r = tracar(png, eps);
    writeFileSync(OUT, fonte);
    console.log(
      `brasão: ${r.lacos.length} laços, ${r.pontos} pontos, ${r.d.length} B de path, ` +
        `erro ${r.erroPct.toFixed(2)}% (eps ${eps}) → src/ui/brasao-path.ts`,
    );

    const icone = rasterizarIcone(r.lacos, r.largura, r.altura, 512, COR_MARCA);
    writeFileSync(OUT_ICONE, icone);
    console.log(`ícone: 512×512 RGBA, ${(icone.length / 1024).toFixed(1)} kB → ../desktop/assets/icon.png`);
  }
}

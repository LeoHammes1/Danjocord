import { defineConfig } from "vite";

/**
 * Config do cliente (M8). Até aqui o Vite rodava só no default — o que bastava.
 * O que criou a necessidade deste arquivo foram os .ogg de `assets/sounds/`.
 *
 * POR QUE o assetsInlineLimit customizado
 * --------------------------------------
 * No default, asset importado com menos de 4 KB o Vite embute como `data:` URI
 * em vez de emitir um arquivo. E `data:` NÃO passa nas CSPs deste projeto:
 *
 *   - `apps/client/index.html`: `media-src 'self' app: blob: mediastream:` e
 *     `connect-src 'self' app: http: https: ws: wss:` — nenhum dos dois tem
 *     `data:`. O player busca os clipes com `fetch()` (para o
 *     `decodeAudioData`), então quem barraria seria o connect-src; o media-src
 *     barraria o mesmo arquivo num `<audio>`. Fecha dos dois lados.
 *   - o header de produção (`apps/server/src/index.ts`): `default-src 'self'`
 *     sem media-src, e `connect-src 'self'`. Idem.
 *
 * Nenhum clipe atual cai no limite (o menor, ptt-on.ogg, tem 4686 B), mas a
 * margem é de centenas de bytes: um dia alguém troca um som por um mais curto,
 * o build inlina, e o áudio some SÓ em produção — com um erro de CSP no
 * console que ninguém liga ao arquivo de som. O limite explícito troca essa
 * falha silenciosa e distante por uma garantia no build.
 *
 * A forma de FUNÇÃO (em vez de zerar o número) é de propósito: `undefined`
 * devolve a decisão ao default do Vite, então SVG e PNG pequenos continuam
 * inlinando — o que é bom, é uma requisição a menos. Só o áudio fica de fora.
 */
export default defineConfig({
  build: {
    assetsInlineLimit: (filePath) => (/\.(ogg|oga|opus|mp3|wav|m4a|flac)$/i.test(filePath) ? false : undefined),
  },
});

import { defineConfig } from "vite";

/**
 * Config do cliente (M8). Até aqui o Vite rodava só no default — o que bastava.
 * O que criou a necessidade deste arquivo foram os clipes de `assets/sounds/`.
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
 * Isto DEIXOU DE SER HIPÓTESE no M12: `ptt-on.mp3` e `ptt-off.mp3` (do Discord)
 * têm ~1,6 KB, menos da metade do limite de 4096 B. Sem esta config eles
 * viravam `data:` URI e sumiam SÓ em produção — com um erro de CSP no console
 * que ninguém liga a arquivo de som. Antes disso a margem era de centenas de
 * bytes e o comentário aqui falava no futuro; hoje fala no presente, e o
 * `test/sound-assets.test.ts` confere que a regra abaixo cobre a extensão de
 * todo clipe pequeno.
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

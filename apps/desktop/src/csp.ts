/**
 * CSP do renderer do desktop (auditoria de segurança do M12).
 *
 * POR QUE ESTE ARQUIVO EXISTE: o cliente web recebe uma CSP no header, posta
 * pelo hook `onSend` do Fastify (`apps/server/src/index.ts`). O desktop NÃO
 * passa por lá — o renderer é servido pelo scheme `app://` do processo Electron,
 * então aquele header nunca chega nele. O resultado era um renderer rodando
 * SEM CSP nenhuma, enquanto a mesma UI, no navegador, roda com.
 *
 * O caso concreto que revelou isso foi o `avatar_override`: no web o
 * `img-src 'self' https://cdn.discordapp.com data: blob:` já barra host
 * arbitrário, então a URL escolhida por um membro simplesmente não carrega. No
 * desktop carregaria — e o IP de cada amigo iria para o servidor de quem
 * escolheu. Mas a falta da CSP é maior que esse caso: ela é a rede embaixo de
 * todo o resto (o cliente não usa `innerHTML`, o markdown produz nós, os hrefs
 * são filtrados — a CSP é o que segura se qualquer um desses ceder).
 *
 * É função PURA e mora em arquivo próprio para poder ser testada sem subir o
 * Electron: o teste do desktop roda em Node puro.
 *
 * A diferença para a CSP do servidor é o `connect-src`. No web o cliente é
 * servido pela MESMA origem da API, então `'self'` basta; aqui a origem é
 * `app://bundle` e a API está noutro host, que precisa ser nomeado — junto do
 * WebSocket do gateway, que o `connect-src` também governa.
 */

/** `https://x` → `wss://x` (o gateway sobe pela mesma origem da API). */
function wsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/i, "ws");
}

/**
 * @param serverUrl origem da API, como o main resolve (`resolveServerUrl`).
 *   Em dev é `http://localhost:8080`; em produção, o valor carimbado no bundle.
 */
export function rendererCsp(serverUrl: string): string {
  // sem barra no fim: origem com barra é inválida em CSP e o navegador
  // descarta a diretiva inteira, em silêncio
  const api = serverUrl.replace(/\/+$/, "");
  return [
    "default-src 'self'",
    // 'unsafe-inline' no style: o mesmo do servidor. O cliente escreve
    // `style.setProperty` em vários lugares (a razão de aspecto do anexo, por
    // exemplo), e o Electron não tem nonce por request num scheme estático.
    "style-src 'self' 'unsafe-inline'",
    // `blob:` por causa dos anexos: `GET /api/attachments/:id` exige
    // Authorization, e `<img src>` não manda header — o cliente busca com
    // fetch, envolve num Blob e usa createObjectURL (M11b, item 89).
    "img-src 'self' https://cdn.discordapp.com data: blob:",
    // os sons vêm do próprio bundle; `blob:` fica para mídia de anexo futura
    "media-src 'self' blob:",
    // REST + gateway. WebRTC (ICE/DTLS/SRTP) não passa por aqui — é governado
    // por outra diretiva e o mediasoup continua falando direto com o nó.
    `connect-src 'self' ${api} ${wsOrigin(api)}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    // o app não tem formulário que POSTe para lugar nenhum: o login é OAuth no
    // navegador externo e o resto é fetch
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

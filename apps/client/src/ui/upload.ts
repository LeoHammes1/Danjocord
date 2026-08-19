/**
 * Upload de anexo (M11b, item 89) — a metade que fala com a rede.
 *
 * Está separada de `ui/attachments.ts` porque aquele arquivo é PURO e precisa
 * ser importável pelo `node --test`; este aqui importa `../auth.js`, que lê
 * `import.meta.env` na carga (coisa que só o Vite entende). Mesma divisão do
 * M8 entre `sound/catalog.ts` e `sound/assets.ts`.
 *
 * Por que não usar o `api()` do main.ts: (a) ele é privado do main; (b) ele
 * põe `content-type: application/json` sempre que há corpo — e aqui o corpo é
 * o ARQUIVO CRU, que o Fastify só entrega ao provador se o content-type estiver
 * na lista do `raw-body.ts`. O molde do fetch com renovação é o mesmo de
 * `ui/user-controls.ts`, `ui/invites.ts` e `sound/soundboard.ts`: renova UMA
 * vez no 401 (o `refresh()` é single-flight) e falha com uma FRASE — quem
 * desloga de verdade é o próximo `api()` do main.
 */
import { Attachment } from "@danjocord/protocol";
import { API, getAccessToken, refresh } from "../auth.js";
import { formatBytes, MAX_ATTACHMENT_BYTES } from "./attachments.js";

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * O content-type do POST é SEMPRE `application/octet-stream`, e não o
 * `file.type` que o navegador adivinhou pela extensão: o `raw-body.ts` do
 * servidor só roteia para o provador binário os tipos de uma lista, e um
 * arquivo `.jfif` (ou sem extensão) chegaria com `type` vazio ou exótico e
 * levaria 415 antes de qualquer sniff. O tipo real sai dos magic bytes, no
 * servidor — o cabeçalho aqui é só o roteamento.
 */
const CONTENT_TYPE = "application/octet-stream";

/**
 * Sobe UM arquivo e devolve o anexo já criado (etapa 1 de 2 — a etapa 2 é o
 * `attachment_ids` do POST da mensagem).
 *
 * `signal` existe porque remover a imagem da bandeja antes de o upload acabar
 * é o caso normal (a pessoa colou a print errada): sem aborto, o byte continua
 * subindo e o anexo vira órfão à toa.
 */
export async function uploadAttachment(file: File, signal: AbortSignal): Promise<Attachment> {
  const path = `/api/attachments?filename=${encodeURIComponent(nomeSeguro(file.name))}`;
  const send = (): Promise<Response> =>
    fetch(API + path, {
      method: "POST",
      body: file,
      signal,
      headers: {
        authorization: `Bearer ${getAccessToken() ?? ""}`,
        "content-type": CONTENT_TYPE,
      },
    });

  let res: Response;
  try {
    res = await send();
  } catch (err) {
    // AbortError sobe como está: quem abortou foi o próprio composer, e ele
    // não quer uma frase de erro na tela por causa disso
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new UploadError("sem conexão com o servidor");
  }

  if (res.status === 401) {
    if ((await refresh()) !== "ok") throw new UploadError("sua sessão expirou — recarregue a página", 401);
    res = await send();
  }
  if (!res.ok) throw await erroDe(res);

  // regra do projeto: nada que entra vira objeto confiável sem passar pelo Zod
  const parsed = Attachment.safeParse(await res.json());
  if (!parsed.success) throw new UploadError("o servidor respondeu um anexo que não entendi");
  return parsed.data;
}

/**
 * O `filename` é só para o download: quem decide o tipo são os magic bytes. O
 * servidor recusa caminho e caractere de controle (`CreateAttachmentQuery`), e
 * um 400 por causa do NOME de um arquivo que a pessoa nem escolheu (a print do
 * clipboard chega como `image.png`, mas um arquivo arrastado pode ter
 * qualquer coisa) seria uma recusa incompreensível. Então saneamos antes.
 */
function nomeSeguro(raw: string): string {
  const limpo = [...raw]
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x20 && cp !== 0x7f && ch !== "/" && ch !== "\\";
    })
    .join("")
    .trim()
    .slice(0, 120);
  return limpo === "" ? "imagem" : limpo;
}

/**
 * Status → frase em pt-BR. O `{error}` do servidor entra no 400 e no 507
 * porque ali ele diz a única coisa que a UI não sabia (qual regra o arquivo
 * quebrou; quantos MB a guild já gastou). No 413 e no 429 as frases são nossas:
 * o número do teto o cliente já conhece, e "retry_after" vira segundos.
 */
async function erroDe(res: Response): Promise<UploadError> {
  const corpo = await corpoJson(res);
  const detalhe = typeof corpo["error"] === "string" ? corpo["error"] : null;
  switch (res.status) {
    case 413:
      return new UploadError(`imagem acima de ${formatBytes(MAX_ATTACHMENT_BYTES)}`, 413);
    case 429: {
      const s = typeof corpo["retry_after"] === "number" ? Math.ceil(corpo["retry_after"]) : null;
      return new UploadError(
        s === null ? "muitos envios seguidos — espere um pouco" : `muitos envios seguidos — tente em ${s} s`,
        429,
      );
    }
    case 507:
      return new UploadError(detalhe ?? "o servidor está sem espaço para imagens", 507);
    case 400:
      return new UploadError(detalhe ?? "imagem inválida", 400);
    default:
      return new UploadError(`falha ao enviar (${res.status})`, res.status);
  }
}

async function corpoJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // corpo não-JSON (502 do proxy num deploy): fica só o status
  }
  return {};
}

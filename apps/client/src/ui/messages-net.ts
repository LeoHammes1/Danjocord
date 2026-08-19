/**
 * A metade das mensagens ricas que fala com a REDE (M11b): bytes de anexo,
 * cartão de link e reações.
 *
 * Está fora do `ui/messages.ts` pela mesma razão que o `ui/upload.ts` está fora
 * do `ui/attachments.ts`: aqui se importa `../auth.js`, que lê
 * `import.meta.env` na carga (coisa que só o Vite entende). Lá ficam os nós.
 *
 * Por que não passar isto pelo `api()` do main.ts, como editar e apagar fazem:
 * o `api()` é privado dele, e o molde de "renova UMA vez no 401 e falha com uma
 * frase" já é o de `ui/user-controls.ts`, `ui/invites.ts`, `sound/soundboard.ts`
 * e `ui/upload.ts`. Cada gancho a mais no `MessageActions` é um passo a mais que
 * o integrador pode esquecer — e um recurso que some sem erro nenhum.
 */
import { LinkPreview, type Attachment } from "@danjocord/protocol";
import { API, getAccessToken, refresh } from "../auth.js";

/**
 * Fetch com renovação: 401 → refresh (single-flight) → repete UMA vez. Quem
 * desloga de verdade é o próximo `api()` do main.ts; aqui uma falha é uma
 * falha de recurso — a mensagem continua na tela sem a imagem, sem o cartão.
 */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(API + path, {
      ...init,
      headers: { authorization: `Bearer ${getAccessToken() ?? ""}`, ...(init?.headers as Record<string, string>) },
    });
  const res = await send();
  if (res.status !== 401) return res;
  if ((await refresh()) !== "ok") return res;
  return send();
}

// ---------------------------------------------------------------------------
// Bytes do anexo (item 89)
// ---------------------------------------------------------------------------

/**
 * `GET /api/attachments/:id` EXIGE `Authorization`, e um `<img src>` não manda
 * header nenhum. Então o cliente busca, vira `Blob` e usa `URL.createObjectURL`
 * — pôr o token na URL da imagem contrariaria o M1 e vazaria em qualquer log,
 * histórico ou "copiar endereço da imagem".
 *
 * O cache é por id (o conteúdo é imutável: o id é snowflake e os bytes nunca
 * mudam), e tem TETO — a mesma lição do cache de sons do M9. Uma aba que fica
 * semanas na bandeja rolando um canal com muita print acumularia todas elas na
 * memória; aqui, passando do teto, a URL mais antiga é revogada e o blob é
 * liberado. Se a imagem revogada voltar à tela, ela é buscada de novo.
 */
const MAX_BLOBS = 48;
const blobs = new Map<string, Promise<string>>();

export function attachmentObjectUrl(att: Attachment): Promise<string> {
  const pronto = blobs.get(att.id);
  if (pronto !== undefined) {
    // Map preserva a ordem de inserção: reinserir é o "usado recentemente" do
    // LRU sem estrutura nenhuma além do próprio Map
    blobs.delete(att.id);
    blobs.set(att.id, pronto);
    return pronto;
  }
  const busca = baixar(att.id);
  blobs.set(att.id, busca);
  // falha não fica no cache: um 502 momentâneo não pode condenar a imagem a
  // nunca mais aparecer nesta sessão
  void busca.catch(() => blobs.delete(att.id));
  podar();
  return busca;
}

async function baixar(id: string): Promise<string> {
  const res = await authFetch(`/api/attachments/${id}`);
  if (!res.ok) throw new Error(`anexo ${id}: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

function podar(): void {
  while (blobs.size > MAX_BLOBS) {
    const velho = blobs.keys().next();
    if (velho.done === true) return;
    const p = blobs.get(velho.value);
    blobs.delete(velho.value);
    // revoga só quando a promessa resolveu: revogar antes disso não libera
    // nada e ainda deixaria uma rejeição solta
    void p?.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Cartão de link (item 90)
// ---------------------------------------------------------------------------

/**
 * `GET /api/link-preview?url=`. O servidor responde 200 mesmo quando não deu
 * (`ok: false` com o motivo) — "não deu" é o caso comum e o cliente trata tudo
 * igual: sem cartão. Devolve null também quando a resposta não passa pelo Zod:
 * regra do projeto, nada que entra vira objeto confiável sem schema.
 */
export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const res = await authFetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
  if (!res.ok) return null;
  const parsed = LinkPreview.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Reações (item 87)
// ---------------------------------------------------------------------------

/**
 * `PUT` / `DELETE .../reactions/:emoji/@me`. O emoji vai percent-encodado — ele
 * é um cluster Unicode inteiro no caminho da URL.
 *
 * Nada é pintado aqui: quem pinta é o eco do gateway (`REACTION_ADD` /
 * `REACTION_REMOVE`), inclusive para quem clicou. Mesma decisão do soundboard
 * do M9 — um caminho só para todo mundo.
 */
export async function sendReactionRequest(
  channelId: string,
  messageId: string,
  emoji: string,
  add: boolean,
): Promise<void> {
  const path = `/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
  const res = await authFetch(path, { method: add ? "PUT" : "DELETE" });
  if (!res.ok) throw new Error(`reação: ${res.status}`);
}

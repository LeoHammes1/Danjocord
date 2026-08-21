import { randomBytes } from "node:crypto";

/**
 * Tíquete de download (M14): a credencial que vai na QUERY, e não num header.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELE EXISTE (duas vezes, por dois motivos diferentes)
 * ---------------------------------------------------------------------------
 *
 * 1. **O navegador.** A sessão deste cliente vive no `localStorage`, não em
 *    cookie — de propósito, desde o M1. Então um `<a href>` para o instalador
 *    não leva credencial nenhuma, e a alternativa (buscar 100 MB com `fetch`,
 *    montar um Blob e um `createObjectURL`) põe o arquivo inteiro na memória da
 *    aba e tira do navegador a barra de download, o "retomar" e o disco.
 *
 * 2. **O `electron-updater`.** Ele até aceita `requestHeaders`, mas o executor
 *    HTTP dele REPASSA os headers ao seguir um redirect — e o nosso feed
 *    responde 302 para o CDN do GitHub. Um `Authorization: Bearer <JWT desta
 *    instância>` chegaria a `objects.githubusercontent.com`. Com o tíquete na
 *    query o problema não existe: o `Location` é a URL pré-assinada, e ela não
 *    carrega nada nosso.
 *
 *    E ele funciona porque o `newUrlFromBase` do electron-updater PROPAGA a
 *    query da URL base para cada arquivo que resolve (`latest.yml`, o `.exe`, o
 *    `.blockmap`) — é o mecanismo documentado para feed privado. Por isso o
 *    tíquete é de MÚLTIPLOS USOS: uma atualização são três requisições ao longo
 *    de minutos, não uma.
 *
 * ---------------------------------------------------------------------------
 * O QUE UM TÍQUETE VAZADO DÁ, E O QUE NÃO DÁ
 * ---------------------------------------------------------------------------
 *
 * Ele vai na URL, então entra no log do Fastify e no `access log` de qualquer
 * proxy no caminho. Isso é aceito, e a mitigação é o ESCOPO: um tíquete só abre
 * os arquivos do release — não lê mensagem, não posta, não vira sessão, não
 * rotaciona refresh. Quem o roubar pode baixar o instalador por 30 minutos, que
 * é exatamente o que ele existe para permitir.
 *
 * Vive em MEMÓRIA, como todo estado efêmero do projeto: um deploy invalida os
 * tíquetes em voo. O `electron-updater` tenta de novo na próxima checagem e o
 * navegador já recebeu o 302 dele antes de o pod cair.
 */

/** 30 min: cobre um download de ~100 MB numa conexão doméstica ruim, com folga. */
export const TICKET_TTL_MS = 30 * 60_000;

/**
 * Teto de tíquetes vivos. Dez amigos com um app cada não passam de algumas
 * dezenas; o número existe para que um laço de `POST /api/updates/ticket` não
 * vire crescimento sem fim num processo que fica semanas no ar — a mesma
 * preocupação do `MAX_KEYS` do `SlidingWindow`.
 */
const MAX_TICKETS = 5_000;

interface Registro {
  userId: string;
  expiraEm: number;
}

export class TicketStore {
  private readonly vivos = new Map<string, Registro>();

  /** Emite um tíquete para `userId`. O valor é opaco — 32 bytes de aleatório. */
  issue(userId: string, agora: number = Date.now()): { ticket: string; expiresIn: number } {
    this.sweep(agora);
    if (this.vivos.size >= MAX_TICKETS) {
      // cheio mesmo depois da faxina: descarta o mais antigo em vez de recusar.
      // Recusar deixaria um laço barato transformar "ninguém baixa o app" numa
      // negação de serviço; o descarte mantém o teto e o pior caso é alguém
      // clicar em "Baixar" de novo.
      const maisAntigo = this.vivos.keys().next();
      if (!maisAntigo.done) this.vivos.delete(maisAntigo.value);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.vivos.set(ticket, { userId, expiraEm: agora + TICKET_TTL_MS });
    return { ticket, expiresIn: Math.floor(TICKET_TTL_MS / 1000) };
  }

  /** O dono do tíquete, ou null se ele não existe ou venceu. */
  resolve(ticket: string | undefined, agora: number = Date.now()): string | null {
    if (typeof ticket !== "string" || ticket === "") return null;
    const reg = this.vivos.get(ticket);
    if (reg === undefined) return null;
    if (reg.expiraEm <= agora) {
      this.vivos.delete(ticket);
      return null;
    }
    return reg.userId;
  }

  /** Só para o teste. */
  get size(): number {
    return this.vivos.size;
  }

  private sweep(agora: number): void {
    for (const [ticket, reg] of this.vivos) if (reg.expiraEm <= agora) this.vivos.delete(ticket);
  }
}

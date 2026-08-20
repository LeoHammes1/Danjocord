import type { FastifyReply } from "fastify";

/**
 * Janela deslizante por chave: no máximo `limit` eventos em `windowMs`.
 *
 * Nasceu em `sounds/limits.ts` no M9 (primeiro rate limit do projeto, roadmap
 * 117) e subiu para cá no M10, quando o segundo apareceu: o `GET` PÚBLICO de
 * convite é a única rota sem autenticação do servidor, e uma rota pública que
 * consulta o banco por um código secreto precisa de freio. `sounds/limits.ts`
 * reexporta esta classe — os call sites e os testes do M9 não mudaram.
 *
 * `retryAfterMs` e `record` são separados DE PROPÓSITO: tocar um som passa por
 * duas janelas (usuário e canal) e, se a segunda barrar, a primeira não pode
 * ter consumido cota — senão um 429 do canal comeria o cooldown pessoal de quem
 * nem chegou a tocar.
 *
 * Relógio injetável (`now`) porque a alternativa em teste seria dormir 2 s.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  /**
   * Teto de chaves rastreadas (auditoria M12).
   *
   * O `prune` só apaga uma chave quando ela é TOCADA de novo — e as duas rotas
   * anônimas do servidor (`GET /api/invites/:code` e `/auth/discord/start`) são
   * chaveadas por IP. Numa enxurrada distribuída, cada IP aparece uma vez e
   * nunca mais: medido, 70 000 IPs únicos deixam 70 000 chaves vivas para
   * sempre (~17 MB). Não derruba o pod de 1 GiB sozinho, mas é crescimento sem
   * fim num processo que fica semanas no ar.
   *
   * 20 000 é folgadíssimo para dez amigos e ainda barato em memória.
   */
  private static readonly MAX_KEYS = 20_000;

  /** Quando a última faxina rodou — segura a varredura para não virar por-request. */
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Faxina das chaves sem nenhum evento vivo. Roda só quando o mapa passa do
   * teto, então o custo O(n) é amortizado por n inserções — na operação normal
   * (dez pessoas) ela nunca acontece.
   */
  private sweep(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || (times[times.length - 1] ?? 0) <= now - this.windowMs) {
        this.hits.delete(key);
      }
    }
  }

  /** 0 = liberado; > 0 = quantos ms faltam para a vaga mais antiga expirar. */
  retryAfterMs(key: string, now: number = Date.now()): number {
    const recent = this.prune(key, now);
    if (recent.length < this.limit) return 0;
    // a vaga que libera é a mais antiga da janela (o array está em ordem)
    const oldest = recent[recent.length - this.limit] ?? now;
    return Math.max(1, oldest + this.windowMs - now);
  }

  /** Consome uma vaga. Chame só depois de TODAS as janelas liberarem. */
  record(key: string, now: number = Date.now()): void {
    // faxina ANTES de crescer: é aqui que o mapa ganha chave nova
    if (!this.hits.has(key) && this.hits.size >= SlidingWindow.MAX_KEYS) {
      // Só varre se faz tempo — e isto NÃO é micro-otimização. Numa enxurrada
      // as 20 000 chaves estão todas vivas, então a varredura não libera nada e
      // rodaria a CADA requisição: 20 000 operações por request, que é
      // exatamente a amplificação de CPU que este arquivo existe para evitar.
      // (Medido: 60 mil inserções levavam 11 s antes desta guarda.)
      if (now - this.lastSweep >= this.windowMs / 2) {
        this.lastSweep = now;
        this.sweep(now);
      }
      // ainda cheio depois da faxina = enxurrada de verdade, com todas as
      // chaves vivas. Não rastrear a nova seria FALHAR ABERTO justo no momento
      // do ataque; recusar é o contrário do que se quer num limitador.
      // Descartar a mais antiga mantém o teto e continua freando quem insiste.
      if (this.hits.size >= SlidingWindow.MAX_KEYS) {
        const maisAntiga = this.hits.keys().next();
        if (!maisAntiga.done) this.hits.delete(maisAntiga.value);
      }
    }
    const recent = this.prune(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  private prune(key: string, now: number): number[] {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    // chave sem evento vivo sai do mapa: com ≤10 usuários é irrelevante, mas
    // deixar o mapa crescer para sempre é o tipo de vazamento que ninguém vê
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
    return recent;
  }
}

/**
 * O 429, num lugar só (M12). Havia CINCO cópias desta função — anexos, sons,
 * reações, preview de link e uma inline no convite — idênticas byte a byte, e
 * agora existe uma sexta origem de 429 (o limite geral do REST). Seis cópias da
 * mesma resposta é como as respostas começam a divergir.
 *
 * A forma é a que o cliente JÁ entende, e não se mexe nela: `retry_after` em
 * SEGUNDOS no CORPO (como o Discord). Os quatro lugares do cliente que tratam
 * 429 leem só isso — nenhum lê o header `Retry-After`, então o header fica por
 * correção de protocolo, não porque alguém o consuma.
 *
 * `Math.ceil` com piso 1 no header porque `Retry-After` é inteiro em segundos e
 * "0" significaria "pode tentar já", que é o contrário do que acabou de ser
 * dito.
 */
export function tooManyRequests(reply: FastifyReply, waitMs: number, message: string): FastifyReply {
  const seconds = waitMs / 1000;
  reply.header("retry-after", String(Math.max(1, Math.ceil(seconds))));
  return reply.code(429).send({ error: message, retry_after: Number(seconds.toFixed(3)) });
}

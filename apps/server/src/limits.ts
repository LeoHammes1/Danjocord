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

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

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

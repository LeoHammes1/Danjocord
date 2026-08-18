/**
 * Cache com teto em BYTES e descarte do menos recentemente usado (M9).
 *
 * Existe separado — e puro — pelo mesmo motivo que o `policy.ts` do M8: é
 * aritmética de invariante (o total tem que andar em par com o conteúdo), o tipo
 * de coisa que desanda em silêncio depois de duas refatorações e só aparece como
 * "o app ficou pesado". Aqui dá para testar sem WebAudio e sem DOM.
 *
 * Por que LRU e não um simples "esvazia quando estourar": o pad tem um som da
 * moda. Descartar tudo faria justamente ele voltar a baixar toda hora.
 *
 * O `Map` do JS preserva a ordem de inserção, então o primeiro é o mais antigo,
 * e reinserir no `touch` converte ordem de inserção em ordem de USO — LRU sem
 * estrutura auxiliar nenhuma.
 */
export class ByteLru<T> {
  private readonly entries = new Map<string, T>();
  private total = 0;

  private readonly maxBytes: number;
  private readonly sizeOf: (value: T) => number;

  /**
   * Campos declarados e atribuídos no corpo, e NÃO por parameter property
   * (`constructor(private readonly x: number)`): o type stripping do Node — que
   * é como a suíte do cliente roda .ts sem tsx — recusa parameter property,
   * porque ela GERA código em vez de só remover tipos.
   *
   * @param maxBytes teto do total; 0 ou negativo mantém só o último item posto
   * @param sizeOf tamanho de um item em bytes — chamado a cada put/descarte, e
   *   por isso tem que ser puro e barato (para AudioBuffer é uma multiplicação)
   */
  constructor(maxBytes: number, sizeOf: (value: T) => number) {
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Devolve o item e o marca como recém-usado. */
  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // reinsere: vira o mais recente da ordem do Map
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Consulta SEM marcar uso — para quem só quer saber se está lá. */
  peek(key: string): T | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Guarda (substituindo, se já existia) e descarta os mais antigos até caber.
   * O item que acabou de entrar NUNCA é descartado, mesmo que ele sozinho passe
   * do teto: cortar o som que a pessoa pediu agora seria o pior dos mundos.
   */
  put(key: string, value: T): void {
    this.delete(key);
    this.entries.set(key, value);
    this.total += this.sizeOf(value);
    for (const [oldest, old] of this.entries) {
      if (this.total <= this.maxBytes) break;
      if (oldest === key) break;
      this.entries.delete(oldest);
      this.total -= this.sizeOf(old);
    }
  }

  delete(key: string): boolean {
    const existing = this.entries.get(key);
    if (existing === undefined) return false;
    this.entries.delete(key);
    this.total -= this.sizeOf(existing);
    return true;
  }

  /** Descarta tudo que o predicado NÃO aprovar (usado quando o catálogo muda). */
  retain(keep: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (!keep(key)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

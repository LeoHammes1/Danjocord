/**
 * O erro de uma chamada REST, com o que o servidor disse dentro (M12).
 *
 * Até aqui o `api()` fazia `throw new Error(\`${res.status} em ${path}\`)` — o
 * status virava string e o CORPO NUNCA ERA LIDO. Dava para viver com isso
 * enquanto os erros eram 403 e 404, que o usuário provoca sabendo o que fez.
 * O rate limit geral do REST (roadmap 117) muda a conta: agora existe um erro
 * que aparece SEM o usuário ter feito nada de errado, e cuja resposta traz
 * exatamente a informação de que ele precisa — quanto tempo esperar.
 *
 * A separação aqui é a de sempre no projeto: `lerErro` é PURA (status + corpo
 * já desserializado → o que dizer), e quem toca em `Response` é o `api()`. É o
 * que permite testar as frases sem rede.
 *
 * O molde é o `errorFrom` do soundboard, que já faz isto certo desde o M9 — e
 * é por isso que o pad do soundboard é o único lugar do cliente que mostra um
 * cooldown de verdade em vez de um erro genérico.
 */

export class ApiError extends Error {
  readonly status: number;
  /** segundos até poder tentar de novo — só o 429 traz */
  readonly retryAfter: number | null;

  // Campos explícitos, e não parameter properties no construtor: o type
  // stripping do Node (que é quem roda os testes do cliente — não há tsx aqui)
  // RECUSA parameter property, e o erro sai como uma exceção assíncrona solta
  // que não aponta para este arquivo. Mesma armadilha do `gateway.ts`.
  constructor(status: number, message: string, retryAfter: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** `{error, retry_after?}` é a forma de TODA resposta de erro do servidor. */
export function lerErro(status: number, corpo: unknown, path: string): { mensagem: string; retryAfter: number | null } {
  let detalhe: string | null = null;
  let retryAfter: number | null = null;
  if (typeof corpo === "object" && corpo !== null) {
    const obj = corpo as Record<string, unknown>;
    if (typeof obj["error"] === "string") detalhe = obj["error"];
    if (typeof obj["retry_after"] === "number") retryAfter = obj["retry_after"];
  }
  if (status === 429) {
    // O servidor manda `retry_after` em SEGUNDOS (fracionários). Arredondar
    // para cima e para pelo menos 1: "espere 0 s" não é instrução nenhuma.
    const espera = retryAfter === null ? null : Math.max(1, Math.ceil(retryAfter));
    const quanto = espera === null ? "" : ` — tente de novo em ${espera}s`;
    return { mensagem: `${detalhe ?? "muitas ações seguidas"}${quanto}`, retryAfter };
  }
  // Fora do 429 o `error` do servidor é técnico demais para a tela em alguns
  // casos, mas é o único texto específico que existe; sem ele fica o status, que
  // ao menos distingue "não pode" de "caiu".
  return { mensagem: detalhe ?? `${status} em ${path}`, retryAfter: null };
}

/** Texto curto para pôr na tela a partir de qualquer coisa que caiu num catch. */
export function textoDoErro(err: unknown, fallback = "não deu certo"): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message !== "") return err.message;
  return fallback;
}

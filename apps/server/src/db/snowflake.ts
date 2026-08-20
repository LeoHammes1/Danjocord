/**
 * Snowflake simplificado (doc §6): 42 bits de timestamp (ms desde a época do
 * projeto) << 22 | contador. Monotônico e ordenável por tempo — o próprio id
 * é o cursor de paginação. No fio, ids trafegam como string (64 bits não
 * cabem com segurança em number).
 */
const EPOCH = 1_767_225_600_000n; // 2026-01-01T00:00:00Z

let lastMs = 0n;
let seq = 0n;
const SEQ_MASK = 0x3f_ffffn; // 22 bits

export function nextId(): bigint {
  let now = BigInt(Date.now());
  if (now === lastMs) {
    seq = (seq + 1n) & SEQ_MASK;
    if (seq === 0n) {
      // contador estourou dentro do mesmo ms (improvável com 10 usuários) — espera o próximo ms
      while (BigInt(Date.now()) <= now) {
        /* busy wait de no máximo 1 ms */
      }
      now = BigInt(Date.now());
    }
  } else {
    seq = 0n;
  }
  lastMs = now;
  return ((now - EPOCH) << 22n) | seq;
}

export function idToString(id: bigint): string {
  return id.toString();
}

export function idFromString(id: string): bigint {
  return BigInt(id);
}

/**
 * Valida E canoniza um id vindo de path/query: "01" vira "1". Sem isto, o id
 * cru do caminho ecoaria nos broadcasts e nenhum cliente casaria o data-id —
 * dessincronização silenciosa de todo mundo (achado de revisão do M2). null =
 * inválido, e a rota responde 404 (nada de BigInt() explodindo em 500).
 */
/** Maior INTEGER que o SQLite guarda (int64 com sinal). Acima disto o driver lança RangeError. */
const MAX_ID = 9_223_372_036_854_775_807n;

export function canonicalId(raw: string | undefined): string | null {
  if (raw === undefined || !/^\d{1,20}$/.test(raw)) return null;
  const id = BigInt(raw);
  // O regex sozinho não bastava: ele aceita 20 dígitos, e o int64 termina no
  // 19º. "9223372036854775808" e "99999999999999999999" passavam, chegavam ao
  // bind do better-sqlite3 e viravam RangeError NÃO tratado — 500 com mensagem
  // interna no corpo e stack trace no log, em qualquer rota com id, sem
  // autenticação especial nenhuma. É o contrário do que o comentário acima
  // promete; agora é 404, como o resto do inválido.
  if (id > MAX_ID) return null;
  return id.toString();
}

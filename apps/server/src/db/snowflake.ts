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

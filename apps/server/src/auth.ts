import type { User } from "@danjocord/protocol";
import { config } from "./config.js";
import type { Store } from "./store.js";

/**
 * Autenticação do M0: apenas o modo dev ("dev.<username>").
 * No M1 isto vira: OAuth do Discord → allowlist → sessão própria na tabela
 * `sessions` (JWT curto + refresh rotativo) — ver doc §5.
 */
export function authenticate(store: Store, token: string): User | null {
  if (config.devAuth && token.startsWith("dev.")) {
    const username = token.slice("dev.".length).trim();
    if (/^[a-z0-9_]{2,32}$/i.test(username)) {
      return store.findOrCreateDevUser(username.toLowerCase());
    }
  }
  return null;
}

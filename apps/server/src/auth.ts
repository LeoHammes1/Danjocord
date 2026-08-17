import jwt from "jsonwebtoken";
import type { User } from "@danjocord/protocol";
import { config } from "./config.js";
import { idFromString } from "./db/snowflake.js";
import type { Store } from "./store.js";

/**
 * Verificação de token — síncrona de propósito: gateway e REST chamam inline
 * no caminho quente, e o HS256 dispensa I/O. Dois caminhos:
 *   1. JWT de acesso emitido por Sessions (M1) — stateless, o banco não é
 *      consultado para validar, só para materializar o usuário;
 *   2. token dev "dev.<username>" (M0) — só com config.devAuth, some em prod.
 */
export function authenticate(store: Store, token: string): User | null {
  if (config.devAuth && token.startsWith("dev.")) {
    const username = token.slice("dev.".length).trim();
    if (/^[a-z0-9_]{2,32}$/i.test(username)) {
      return store.findOrCreateDevUser(username.toLowerCase());
    }
    return null;
  }
  try {
    // algoritmo fixado no verify: aceitar o que o header do token declara
    // abriria downgrade (ex.: "none"); iss/aud impedem confusão de emissor
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: "danjocord",
      audience: "danjocord",
    });
    if (typeof payload === "string" || typeof payload.sub !== "string") return null;
    return store.getUserById(idFromString(payload.sub));
  } catch {
    // expirado, assinatura errada, malformado ou sub que não é snowflake
    return null;
  }
}

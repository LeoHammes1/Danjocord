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
    const user = store.getUserById(idFromString(payload.sub));
    if (user === null) return null;
    // PERTENCIMENTO, e não só assinatura (auditoria de segurança do M12).
    //
    // O M10 dizia derrubar o acesso "pelos TRÊS caminhos que existem" — refresh
    // revogado, WebSocket fechado e voz — e o `evict()` faz os três. Faltava o
    // quarto: o JWT de acesso é STATELESS e vale até expirar (15 min), então
    // quem acabava de ser banido continuava usando o MESMO header para ler o
    // histórico inteiro, postar, subir anexos e — sendo staff — criar um
    // convite sem validade e sem limite de usos, voltando com OUTRA conta do
    // Discord (o ban é indexado por discord_id). O ban virava reversível pela
    // própria vítima.
    //
    // A query é a mesma que o heartbeat do gateway já roda a cada 41 s por
    // sessão; aqui ela roda por request, indexada, contra um banco local.
    // Barato perto de "o banido escreve por mais 15 minutos".
    return store.isMember(user.id) ? user : null;
  } catch {
    // expirado, assinatura errada, malformado ou sub que não é snowflake
    return null;
  }
}

/** Açúcar das rotas REST: "Authorization: Bearer <token>" → usuário (ou null). */
export function authFromHeader(header: string | undefined, store: Store): User | null {
  if (!header?.startsWith("Bearer ")) return null;
  return authenticate(store, header.slice("Bearer ".length));
}

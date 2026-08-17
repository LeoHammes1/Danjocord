import type { User } from "@danjocord/protocol";

/**
 * Sessão do cliente (M1, doc §5): access JWT curto + refresh opaco rotativo.
 * O access vai no Identify do gateway e no header Authorization do REST;
 * quando vence (401 no REST, close 4004 no gateway), refresh() rotaciona o
 * par e o chamador repete a operação.
 *
 * Persistência em localStorage — aceitável enquanto o cliente roda no
 * navegador de dev; no Electron (M6) isto migra para safeStorage do SO.
 * Atenção: localStorage é por origem, então abas compartilham a sessão —
 * o access/refresh são relidos do storage a cada uso de propósito, para que
 * uma rotação feita por outra aba não pareça reuso de token aqui.
 */

/** Par de tokens como vem do fio (snake_case) — espelho do TokenPair do servidor. */
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  /** vida do access em segundos — informativo; a renovação aqui é reativa */
  expires_in: number;
  user: User;
}

// Base da API: VITE_API_BASE="" significa produção same-origin (o backend
// serve o cliente estático). O gateway derivado disso vira wss:// sozinho,
// porque location.origin lá é https.
const rawBase = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";
export const API: string = rawBase === "" ? location.origin : rawBase;

const KEY_ACCESS = "danjocord_access";
const KEY_REFRESH = "danjocord_refresh";
const KEY_USER = "danjocord_user";

/** Erro de endpoint /auth/* — carrega o status para a UI diferenciar (404 = dev auth desligada). */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function save(pair: TokenPair): void {
  localStorage.setItem(KEY_ACCESS, pair.access_token);
  localStorage.setItem(KEY_REFRESH, pair.refresh_token);
  localStorage.setItem(KEY_USER, JSON.stringify(pair.user));
}

function clear(): void {
  localStorage.removeItem(KEY_ACCESS);
  localStorage.removeItem(KEY_REFRESH);
  localStorage.removeItem(KEY_USER);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(KEY_ACCESS);
}

/** Snapshot local do usuário (para pintar o header antes do READY chegar). */
export function getUser(): User | null {
  const raw = localStorage.getItem(KEY_USER);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

async function postAuth(path: string, body: unknown): Promise<TokenPair> {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // corpo não-JSON (404 de rota inexistente, proxy no meio) — fica o status
    }
    throw new AuthError(res.status, detail);
  }
  const pair = (await res.json()) as TokenPair;
  save(pair);
  return pair;
}

/** Troca o one-time code do redirect OAuth por uma sessão completa. */
export function exchangeOtc(otc: string): Promise<TokenPair> {
  return postAuth("/auth/session", { otc });
}

/** Login de desenvolvimento — em produção o endpoint responde 404. */
export function devLogin(username: string): Promise<TokenPair> {
  return postAuth("/auth/dev", { username });
}

/**
 * Resultado do refresh: "ok" segue; "invalid" é veredito definitivo do
 * servidor (sessão morta → login); "transient" é 5xx/rede (deploy no meio,
 * proxy fora) — NÃO limpa nada, o chamador tenta de novo mais tarde.
 */
export type RefreshResult = "ok" | "invalid" | "transient";

// Single-flight: chamadas concorrentes (dois 401 do REST + um 4004 do gateway
// no mesmo instante) compartilham a MESMA promise. Sem isso, a segunda rotação
// chegaria ao servidor com o refresh já rotacionado e seria tratada como reuso
// — derrubando a família inteira e deslogando o usuário.
let refreshing: Promise<RefreshResult> | null = null;

export function refresh(): Promise<RefreshResult> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<RefreshResult> {
  // Web Locks: mutex ENTRE ABAS. O single-flight acima só serializa dentro de
  // uma aba; duas abas com o access vencido no mesmo instante rotacionariam o
  // MESMO refresh e a segunda cairia na detecção de reuso do servidor,
  // revogando a família inteira (reproduzido em revisão). Dentro do lock, se o
  // refresh do storage mudou, outra aba acabou de rotacionar por nós.
  const before = localStorage.getItem(KEY_REFRESH);
  if (before === null) return "invalid";
  const run = async (): Promise<RefreshResult> => {
    const current = localStorage.getItem(KEY_REFRESH);
    if (current === null) return "invalid";
    if (current !== before) return "ok"; // outra aba rotacionou enquanto esperávamos o lock
    try {
      await postAuth("/auth/refresh", { refresh_token: current });
      return "ok";
    } catch (err) {
      // só resposta 4xx do servidor (expirado/revogado/reuso) mata a sessão
      // local; 5xx (deploy com strategy Recreate = janela de 502 do Traefik)
      // e falha de rede são transitórios e não podem deslogar ninguém
      if (err instanceof AuthError && err.status < 500) {
        clear();
        return "invalid";
      }
      return "transient";
    }
  };
  return "locks" in navigator ? navigator.locks.request("danjocord:refresh", run) : run();
}

/** Revoga a família de refresh no servidor (melhor esforço) e limpa o storage. */
export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem(KEY_REFRESH);
  clear();
  if (refreshToken === null) return;
  try {
    await fetch(API + "/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // servidor fora do ar: a família expira sozinha em refreshTokenTtlMs
  }
}

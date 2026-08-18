import type { User } from "@danjocord/protocol";
import { desktop } from "./bridge.js";

/**
 * Sessão do cliente (M1, doc §5): access JWT curto + refresh opaco rotativo.
 * O access vai no Identify do gateway e no header Authorization do REST;
 * quando vence (401 no REST, close 4004 no gateway), refresh() rotaciona o
 * par e o chamador repete a operação.
 *
 * Persistência (M6): no NAVEGADOR continua o localStorage de sempre — por
 * origem, então abas compartilham a sessão, e o access/refresh são relidos do
 * storage a cada uso de propósito, para que uma rotação feita por outra aba
 * não pareça reuso de token aqui. No DESKTOP os segredos vivem no safeStorage
 * do SO (via a ponte secretGet/Set), com um CACHE em memória como fonte
 * SÍNCRONA da verdade: getAccessToken() é chamado síncrono em vários pontos
 * (REST, Identify), então o boot AGUARDA hydrateAuth() antes de startApp, e
 * toda escrita atualiza o cache na hora e espelha no safeStorage SEM bloquear
 * o fluxo. No desktop só existe UMA janela — o cache nunca fica atrás de
 * "outra aba".
 */

/** Par de tokens como vem do fio (snake_case) — espelho do TokenPair do servidor. */
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  /** vida do access em segundos — informativo; a renovação aqui é reativa */
  expires_in: number;
  user: User;
}

// Base da API: no desktop (M6) a ponte manda — o main injetou o serverUrl
// (produção: baked no build; dev: http://localhost:8080) e ele SOBREPÕE o
// VITE_API_BASE, porque o bundle é o mesmo da web. No navegador,
// VITE_API_BASE="" significa produção same-origin (o backend serve o cliente
// estático); o gateway derivado disso vira wss:// sozinho.
const rawBase = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";
export const API: string = desktop !== undefined ? desktop.serverUrl : rawBase === "" ? location.origin : rawBase;

const KEY_ACCESS = "danjocord_access";
const KEY_REFRESH = "danjocord_refresh";
const KEY_USER = "danjocord_user";

// ---------------------------------------------------------------------------
// Camada de storage: web = localStorage; desktop = cache em memória espelhado
// no safeStorage (as MESMAS chaves viram chaves do secrets.json do main)
// ---------------------------------------------------------------------------

/** fonte síncrona da verdade no desktop; no web fica vazio e fora do caminho */
const memory = new Map<string, string>();

function storageGet(key: string): string | null {
  if (desktop !== undefined) return memory.get(key) ?? null;
  return localStorage.getItem(key);
}

function storageSet(key: string, value: string | null): void {
  if (desktop !== undefined) {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
    // espelho ASSÍNCRONO de propósito: uma falha de escrita no disco não pode
    // travar login/refresh — o pior caso é a sessão não sobreviver ao restart
    void desktop.secretSet(key, value).catch((err: unknown) => console.warn("desktop: secretSet falhou", err));
    return;
  }
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/**
 * Hidrata o cache em memória a partir do safeStorage (desktop). O boot AGUARDA
 * isto ANTES de startApp/refresh — sem a hidratação, o getAccessToken()
 * síncrono veria "deslogado" mesmo com a sessão salva no SO. No web é no-op.
 */
export async function hydrateAuth(): Promise<void> {
  if (desktop === undefined) return;
  for (const key of [KEY_ACCESS, KEY_REFRESH, KEY_USER]) {
    try {
      const value = await desktop.secretGet(key);
      if (value !== null) memory.set(key, value);
    } catch (err) {
      // segredo ilegível (perfil trocado, arquivo corrompido): segue deslogado
      console.warn("desktop: secretGet falhou — sessão não restaurada", err);
    }
  }
}

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

/**
 * O trio da sessão vai JUNTO (revisão M6 #4): no desktop, três escritas
 * independentes podiam falhar pela metade e deixar no disco um access novo
 * com refresh velho — no boot seguinte esse refresh obsoleto é lido como
 * REUSO pelo servidor e derruba a família inteira. secretSetMany é atômico.
 */
function storageSetTrio(entries: [string, string | null][]): void {
  if (desktop !== undefined) {
    for (const [key, value] of entries) {
      if (value === null) memory.delete(key);
      else memory.set(key, value);
    }
    void desktop.secretSetMany(entries).catch((err: unknown) => console.warn("desktop: secretSetMany falhou", err));
    return;
  }
  for (const [key, value] of entries) storageSet(key, value);
}

function save(pair: TokenPair): void {
  storageSetTrio([
    [KEY_ACCESS, pair.access_token],
    [KEY_REFRESH, pair.refresh_token],
    [KEY_USER, JSON.stringify(pair.user)],
  ]);
}

function clear(): void {
  storageSetTrio([
    [KEY_ACCESS, null],
    [KEY_REFRESH, null],
    [KEY_USER, null],
  ]);
}

export function getAccessToken(): string | null {
  return storageGet(KEY_ACCESS);
}

/** Snapshot local do usuário (para pintar o header antes do READY chegar). */
export function getUser(): User | null {
  const raw = storageGet(KEY_USER);
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
  // refresh do storage mudou, outra aba acabou de rotacionar por nós. Os locks
  // funcionam também no Electron (M6) — lá só há uma janela, então o lock é
  // formalidade barata, e o single-flight continua sendo quem trabalha.
  const before = storageGet(KEY_REFRESH);
  if (before === null) return "invalid";
  const run = async (): Promise<RefreshResult> => {
    const current = storageGet(KEY_REFRESH);
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
  const refreshToken = storageGet(KEY_REFRESH);
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

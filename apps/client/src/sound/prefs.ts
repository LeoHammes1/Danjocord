/**
 * Preferências de som (M8), persistidas em localStorage.
 *
 * localStorage e NÃO a ponte de segredos do desktop: isto não é segredo
 * nenhum, é ajuste de conforto — e no Electron o localStorage persiste
 * normalmente no perfil, então o mesmo código serve web e app (mesma
 * decisão do PTT, main.ts).
 *
 * A leitura é TOLERANTE: qualquer coisa fora do formato vira o default. Um
 * JSON estragado no storage não pode deixar o cliente sem som — muito menos
 * derrubar o boot.
 */
import type { SoundCategory } from "./catalog.js";
import type { SoundPrefs } from "./policy.js";

export type { SoundPrefs } from "./policy.js";

const KEY = "danjocord_sound_prefs";

/** Tudo ligado; 0.6 porque o ganho do catálogo já deixa os clipes em ~-20 dBFS. */
function defaults(): SoundPrefs {
  return {
    master: true,
    volume: 0.6,
    categories: { voice: true, notify: true, self: true, system: true },
  };
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return defaults().volume;
  return Math.min(1, Math.max(0, v));
}

function load(): SoundPrefs {
  const prefs = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return prefs;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return prefs;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["master"] === "boolean") prefs.master = obj["master"];
    if (typeof obj["volume"] === "number") prefs.volume = clampVolume(obj["volume"]);
    const cats = obj["categories"];
    if (typeof cats === "object" && cats !== null) {
      const map = cats as Record<string, unknown>;
      // percorre as chaves QUE EU CONHEÇO, não as do JSON: assim uma
      // categoria nova ganha o default e uma categoria extinta é ignorada
      for (const key of Object.keys(prefs.categories) as SoundCategory[]) {
        const value = map[key];
        if (typeof value === "boolean") prefs.categories[key] = value;
      }
    }
  } catch {
    // JSON corrompido / storage bloqueado: volta ao default (tudo ligado)
  }
  return prefs;
}

let current: SoundPrefs = load();
const listeners = new Set<(prefs: SoundPrefs) => void>();

/** Cópia: ninguém edita as prefs por referência — a mudança passa pelos setters. */
export function getPrefs(): SoundPrefs {
  return { ...current, categories: { ...current.categories } };
}

function commit(next: SoundPrefs): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage cheio ou bloqueado: a preferência vale nesta sessão e pronto
  }
  for (const cb of listeners) cb(getPrefs());
}

export function setMaster(on: boolean): void {
  commit({ ...getPrefs(), master: on });
}

export function setVolume(volume: number): void {
  commit({ ...getPrefs(), volume: clampVolume(volume) });
}

export function setCategory(category: SoundCategory, on: boolean): void {
  const next = getPrefs();
  next.categories[category] = on;
  commit(next);
}

export function resetPrefs(): void {
  commit(defaults());
}

/** Notifica o painel de configurações. Devolve o cancelamento da inscrição. */
export function subscribe(cb: (prefs: SoundPrefs) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

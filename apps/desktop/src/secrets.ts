import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Segredos do desktop (doc §5/§7): tokens de sessão saem do localStorage e vêm
 * para cá — cifrados pelo cofre do SO via safeStorage (DPAPI no Windows,
 * Keychain no macOS, kwallet/gnome-libsecret no Linux) e gravados num JSON em
 * userData. As CHAVES são texto puro (são nomes como "danjocord_access", não
 * segredos); só os VALORES são cifrados (base64 do ciphertext).
 *
 * FALLBACK documentado: quando safeStorage está indisponível (Linux sem
 * keyring, por exemplo), os valores ficam em texto plano no mesmo JSON, com
 * console.warn no boot — pior que cifrado, MUITO melhor que quebrar o login.
 * O flag `encrypted` por entrada permite migrar: um valor regravado com o
 * cofre disponível volta a ser cifrado.
 *
 * Restrição: este módulo só roda DEPOIS do app ready (os handlers IPC só
 * existem com a janela) — app.getPath("userData") e isEncryptionAvailable()
 * exigem isso.
 */

interface SecretEntry {
  /** true = value é base64 do ciphertext do safeStorage; false = texto plano */
  encrypted: boolean;
  value: string;
}

let cache: Map<string, SecretEntry> | null = null;
let warnedPlaintext = false;

function secretsPath(): string {
  return path.join(app.getPath("userData"), "secrets.json");
}

function load(): Map<string, SecretEntry> {
  if (cache !== null) return cache;
  cache = new Map();
  try {
    const raw = readFileSync(secretsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as SecretEntry).value === "string" &&
          typeof (entry as SecretEntry).encrypted === "boolean"
        ) {
          cache.set(key, { encrypted: (entry as SecretEntry).encrypted, value: (entry as SecretEntry).value });
        }
      }
    }
  } catch {
    // arquivo inexistente (primeiro boot) ou corrompido: começa vazio — o
    // usuário refaz o login; melhor que travar o boot inteiro
  }
  return cache;
}

function persist(map: Map<string, SecretEntry>): void {
  const obj: Record<string, SecretEntry> = {};
  for (const [k, v] of map) obj[k] = v;
  const file = secretsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  // escrita via tmp + rename: um crash no meio não deixa JSON pela metade.
  // mode 0600 (revisão M6 #1): no fallback texto-plano (Linux sem keyring) o
  // default do umask deixaria os tokens legíveis por outros usuários locais;
  // o rename preserva o modo do tmp. No Windows o mode é ignorado (a ACL do
  // perfil já protege) — custa nada e fecha o caso do fallback.
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

export function secretGet(key: string): string | null {
  const entry = load().get(key);
  if (entry === undefined) return null;
  if (!entry.encrypted) return entry.value;
  if (!safeStorage.isEncryptionAvailable()) {
    // cifrado num boot anterior, cofre indisponível agora (perfil migrado?):
    // não há como decifrar — null força re-login em vez de token-lixo
    console.warn("[secrets] valor cifrado mas safeStorage indisponível — devolvendo null para", key);
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(entry.value, "base64"));
  } catch (err) {
    console.warn("[secrets] falha ao decifrar", key, err);
    return null;
  }
}

export function secretSet(key: string, value: string | null): void {
  secretSetMany([[key, value]]);
}

/**
 * Grava VÁRIOS segredos numa transação só (revisão M6 #4): o trio de sessão
 * (access/refresh/user) precisa ir junto — meio par no disco significa, no
 * próximo boot, um refresh obsoleto que o servidor trata como REUSO e revoga
 * a família inteira. Um único persist() no fim: ou tudo, ou nada.
 */
export function secretSetMany(entries: [string, string | null][]): void {
  const map = load();
  for (const [key, value] of entries) {
    if (value === null) {
      map.delete(key);
      continue;
    }
    if (safeStorage.isEncryptionAvailable()) {
      map.set(key, { encrypted: true, value: safeStorage.encryptString(value).toString("base64") });
    } else {
      if (!warnedPlaintext) {
        warnedPlaintext = true;
        console.warn(
          "[secrets] safeStorage indisponível neste SO — segredos gravados em TEXTO PLANO em secrets.json (fallback documentado)",
        );
      }
      map.set(key, { encrypted: false, value });
    }
  }
  persist(map);
}

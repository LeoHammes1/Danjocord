/**
 * CLI de administração da flag is_admin (M2, doc §5): admin pode apagar
 * mensagem de qualquer autor. Sem UI de admin de propósito — 10 amigos não
 * justificam uma; o dono promove/rebaixa por aqui.
 *
 *   node scripts/admin.ts grant <user_id>
 *   node scripts/admin.ts revoke <user_id>
 *   node scripts/admin.ts list
 *
 * user_id é o NOSSO snowflake (coluna users.id), não o id do Discord — use
 * `list` para descobrir. Rodar de apps/server (o DB_PATH default é relativo
 * ao cwd); em produção, via `kubectl -n production exec deploy/danjocord --
 * node scripts/...`. Abre o MESMO banco do servidor via openDb() — WAL +
 * busy_timeout aguentam um segundo processo escrevendo sem drama.
 */

// Importa do build (dist), não de src: scripts rodam com node puro (type
// stripping), que não remapeia os specifiers ".js" dos imports internos de
// src/ para os .ts reais. Em dev, `pnpm --filter @danjocord/server build`
// antes de usar (a imagem de produção já vem com o dist).
import { openDb } from "../dist/db/index.js";

const USAGE = `uso:
  node scripts/admin.ts grant <user_id>
  node scripts/admin.ts revoke <user_id>
  node scripts/admin.ts list`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Snowflakes nossos são decimais em string no fio; no banco viram BigInt. */
function parseUserId(value: string | undefined): bigint {
  if (!value || !/^\d{1,20}$/.test(value)) {
    fail(`user_id inválido ("${value ?? ""}"): esperado o id numérico do usuário (users.id)\n\n${USAGE}`);
  }
  return BigInt(value);
}

interface UserListRow {
  id: bigint; // defaultSafeIntegers: INTEGER volta como BigInt
  username: string;
  is_admin: bigint;
}

const [cmd, ...args] = process.argv.slice(2);
const db = openDb();

switch (cmd) {
  case "grant": {
    const id = parseUserId(args[0]);
    const res = db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(id);
    console.log(res.changes === 0 ? `usuário ${id} não existe` : `usuário ${id} agora é admin`);
    break;
  }

  case "revoke": {
    const id = parseUserId(args[0]);
    const res = db.prepare("UPDATE users SET is_admin = 0 WHERE id = ?").run(id);
    // sem revogar sessão: admin não é credencial — a flag é lida a cada DELETE
    console.log(res.changes === 0 ? `usuário ${id} não existe` : `usuário ${id} não é mais admin`);
    break;
  }

  case "list": {
    const rows = db.prepare("SELECT id, username, is_admin FROM users ORDER BY username").all() as UserListRow[];
    if (rows.length === 0) {
      console.log("nenhum usuário no banco");
      break;
    }
    const wId = Math.max("id".length, ...rows.map((r) => r.id.toString().length));
    const wName = Math.max("username".length, ...rows.map((r) => r.username.length));
    console.log(`${"id".padEnd(wId)}  ${"username".padEnd(wName)}  is_admin`);
    for (const r of rows) {
      console.log(`${r.id.toString().padEnd(wId)}  ${r.username.padEnd(wName)}  ${r.is_admin !== 0n ? "sim" : "-"}`);
    }
    break;
  }

  default:
    db.close();
    fail(USAGE);
}

db.close();

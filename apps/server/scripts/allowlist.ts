/**
 * CLI de administração da allowlist (doc §5): quem não está aqui não passa do
 * OAuth do Discord — é assim que o dono controla quem entra na guild (não
 * existe UI de admin de propósito; 10 amigos não justificam uma).
 *
 *   node scripts/allowlist.ts add <discord_id> [--by <discord_id>]
 *   node scripts/allowlist.ts remove <discord_id>
 *   node scripts/allowlist.ts list
 *
 * Rodar de apps/server (o DB_PATH default é relativo ao cwd); em produção,
 * via `kubectl -n production exec deploy/danjocord -- node scripts/...`.
 * Abre o MESMO banco do servidor via openDb() — WAL + busy_timeout aguentam
 * um segundo processo escrevendo sem drama.
 */

// Importa do build (dist), não de src: scripts rodam com node puro (type
// stripping), que não remapeia os specifiers ".js" dos imports internos de
// src/ para os .ts reais. Em dev, `pnpm --filter @danjocord/server build`
// antes de usar (a imagem de produção já vem com o dist).
import { openDb } from "../dist/db/index.js";

const USAGE = `uso:
  node scripts/allowlist.ts add <discord_id> [--by <discord_id>]
  node scripts/allowlist.ts remove <discord_id>
  node scripts/allowlist.ts list`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Ids do Discord são snowflakes decimais em string — nunca outra coisa. */
function parseDiscordId(value: string | undefined, label: string): string {
  if (!value || !/^\d{1,20}$/.test(value)) {
    fail(`${label} inválido ("${value ?? ""}"): esperado o id numérico do Discord\n\n${USAGE}`);
  }
  return value;
}

interface AllowlistRow {
  discord_id: string;
  invited_by: string | null;
  created_at: bigint; // defaultSafeIntegers: INTEGER volta como BigInt
}

const [cmd, ...args] = process.argv.slice(2);
const db = openDb();

switch (cmd) {
  case "add": {
    let invitedBy: string | null = null;
    const byIdx = args.indexOf("--by");
    if (byIdx !== -1) {
      invitedBy = parseDiscordId(args[byIdx + 1], "--by");
      args.splice(byIdx, 2);
    }
    const id = parseDiscordId(args[0], "discord_id");
    const res = db
      .prepare("INSERT INTO allowlist (discord_id, invited_by, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(id, invitedBy, Date.now());
    console.log(res.changes === 0 ? `${id} já estava na allowlist` : `${id} adicionado à allowlist`);
    break;
  }

  case "remove": {
    const id = parseDiscordId(args[0], "discord_id");
    const res = db.prepare("DELETE FROM allowlist WHERE discord_id = ?").run(id);
    // remover = expulsar (doc §5): sem revogar as sessões junto, o refresh
    // rotativo manteria o acesso para sempre — a allowlist só é lida no login
    const revoked = db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL " +
          "AND user_id = (SELECT id FROM users WHERE discord_id = ?)",
      )
      .run(Date.now(), id);
    console.log(res.changes === 0 ? `${id} não estava na allowlist` : `${id} removido da allowlist`);
    if (revoked.changes > 0) console.log(`${revoked.changes} sessão(ões) revogada(s) — acesso morre com o access token atual (≤15 min)`);
    break;
  }

  case "list": {
    const rows = db.prepare("SELECT * FROM allowlist ORDER BY created_at").all() as AllowlistRow[];
    if (rows.length === 0) {
      console.log("allowlist vazia");
      break;
    }
    const wId = Math.max("discord_id".length, ...rows.map((r) => r.discord_id.length));
    const wBy = Math.max("invited_by".length, ...rows.map((r) => (r.invited_by ?? "-").length));
    console.log(`${"discord_id".padEnd(wId)}  ${"invited_by".padEnd(wBy)}  desde`);
    for (const r of rows) {
      const since = new Date(Number(r.created_at)).toISOString().slice(0, 16).replace("T", " ");
      console.log(`${r.discord_id.padEnd(wId)}  ${(r.invited_by ?? "-").padEnd(wBy)}  ${since}`);
    }
    break;
  }

  default:
    db.close();
    fail(USAGE);
}

db.close();

/**
 * CLI de cargos (M10, doc §5). Até o M9 isto mexia no booleano `is_admin`; a
 * migration 004 o trocou por `users.role` (owner > admin > member), e o CLI
 * acompanhou — inclusive com o `owner`, que a UI de propósito NÃO tem.
 *
 *   node scripts/admin.ts grant <user_id>    → admin
 *   node scripts/admin.ts revoke <user_id>   → member
 *   node scripts/admin.ts owner <user_id>    → transfere o cargo de dono
 *   node scripts/admin.ts list
 *
 * Por que `owner` só existe aqui: transferir a guild mexe em duas linhas (o
 * dono antigo vira admin, o novo vira dono) e não pode falhar pela metade —
 * pela UI seria um botão que, se errado uma vez, deixa a guild sem dono e sem
 * conserto. Pela CLI é uma transação com quem operou o deploy na frente.
 *
 * ATENÇÃO (o motivo pelo qual isto não é a UI): este script roda em OUTRO
 * PROCESSO, direto no banco. Ele não fala com o servidor, então:
 *   - não sai MEMBER_UPDATE nenhum: quem está com o app aberto continua vendo
 *     o cargo antigo na lista até reconectar (F5);
 *   - não derruba sessão de gateway na hora. Quem cobre isso é a REVALIDAÇÃO
 *     no heartbeat (roadmap 114): a cada ~41 s o servidor repergunta ao banco
 *     se aquele usuário ainda pertence à guild e fecha o socket se não.
 * A permissão em si, porém, vale JÁ: o cargo é lido do banco a cada request —
 * um rebaixado perde o poder de moderar no request seguinte.
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
  node scripts/admin.ts grant <user_id>    (cargo admin)
  node scripts/admin.ts revoke <user_id>   (cargo member)
  node scripts/admin.ts owner <user_id>    (transfere o cargo de dono)
  node scripts/admin.ts list

Este script roda em outro processo, direto no banco: NÃO emite MEMBER_UPDATE
(quem está com o app aberto vê o cargo antigo até dar F5) e NÃO derruba sessão
de gateway na hora — quem cobre isso é a revalidação no heartbeat (~41 s). A
permissão em si vale já: o cargo é lido do banco a cada request.`;

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
  nickname: string | null;
  role: string;
}

const [cmd, ...args] = process.argv.slice(2);
const db = openDb();

/** Cargo atual, ou null se o usuário não existe. */
function roleOf(id: bigint): string | null {
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: string } | undefined;
  return row?.role ?? null;
}

switch (cmd) {
  case "grant": {
    const id = parseUserId(args[0]);
    const role = roleOf(id);
    if (role === null) fail(`usuário ${id} não existe`);
    // promover o dono a admin seria um REBAIXAMENTO disfarçado de promoção
    if (role === "owner") fail(`usuário ${id} é o dono da guild — use "owner <outro_id>" para transferir`);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
    console.log(`usuário ${id} agora é admin`);
    break;
  }

  case "revoke": {
    const id = parseUserId(args[0]);
    const role = roleOf(id);
    if (role === null) fail(`usuário ${id} não existe`);
    // a guild nunca fica sem dono: é a invariante que as rotas REST também
    // guardam, e ela não pode ter uma porta dos fundos no CLI
    if (role === "owner") fail(`usuário ${id} é o dono da guild e não pode ser rebaixado`);
    db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(id);
    // sem revogar sessão: cargo não é credencial — é lido a cada request
    console.log(`usuário ${id} agora é member`);
    break;
  }

  case "owner": {
    const id = parseUserId(args[0]);
    if (roleOf(id) === null) fail(`usuário ${id} não existe`);
    // transação: o instante entre "tirar o dono antigo" e "pôr o novo" é o
    // único em que a guild ficaria sem dono, e ele não pode existir nem se o
    // processo morrer no meio
    db.transaction(() => {
      db.prepare("UPDATE users SET role = 'admin' WHERE role = 'owner'").run();
      db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(id);
    })();
    console.log(`usuário ${id} agora é o dono da guild (o dono anterior, se havia, virou admin)`);
    break;
  }

  case "list": {
    const rows = db
      .prepare("SELECT id, username, nickname, role FROM users ORDER BY username")
      .all() as UserListRow[];
    if (rows.length === 0) {
      console.log("nenhum usuário no banco");
      break;
    }
    const name = (r: UserListRow): string => (r.nickname === null ? r.username : `${r.nickname} (${r.username})`);
    const wId = Math.max("id".length, ...rows.map((r) => r.id.toString().length));
    const wName = Math.max("usuário".length, ...rows.map((r) => name(r).length));
    console.log(`${"id".padEnd(wId)}  ${"usuário".padEnd(wName)}  cargo`);
    for (const r of rows) {
      console.log(`${r.id.toString().padEnd(wId)}  ${name(r).padEnd(wName)}  ${r.role}`);
    }
    break;
  }

  default:
    db.close();
    fail(USAGE);
}

db.close();

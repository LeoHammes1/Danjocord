-- M10: convites por link e moderação (roadmap §5 + 114/116).
--
-- Quatro mudanças estruturais, todas com o mesmo motivo de fundo: até aqui a
-- única forma de entrar era o dono rodar um CLI, e a única forma de sair era
-- ele rodar outro. Com convite por link a porta passa a abrir sozinha, e aí
-- "quem manda", "quem não entra nunca mais" e "quem fez o que" deixam de ser
-- opcionais.

-- 1) Cargo no lugar do booleano ------------------------------------------------
-- is_admin (migration 002) não distingue o DONO do resto: qualquer admin podia
-- rebaixar quem o promoveu. Com três cargos, "owner" é intocável e as regras de
-- quem-mexe-em-quem cabem numa comparação. A coluna antiga SAI no mesmo passo,
-- de propósito: duas fontes da verdade para a mesma pergunta é como nasce o bug
-- em que a UI mostra uma coisa e o servidor decide outra.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('owner', 'admin', 'member'));
UPDATE users SET role = 'admin' WHERE is_admin = 1;
ALTER TABLE users DROP COLUMN is_admin;

-- 2) Identidade própria da guild -----------------------------------------------
-- O upsert do OAuth roda "UPDATE users SET username = ?, avatar_url = ?" a CADA
-- login: qualquer apelido gravado nessas colunas evaporaria na próxima entrada
-- do dono. Por isso a identidade da guild mora em colunas SEPARADAS, que o
-- upsert nunca toca (ver o comentário em store.upsertDiscordUser).
ALTER TABLE users ADD COLUMN nickname TEXT;
ALTER TABLE users ADD COLUMN avatar_override TEXT;

-- 3) Timeout de chat -----------------------------------------------------------
-- Vai ao BANCO, e não à memória como os flags de voz: um timeout de 24 h que
-- evapora no primeiro deploy não é timeout, é sugestão. NULL = livre.
ALTER TABLE users ADD COLUMN muted_until INTEGER;

-- 4) Convites ------------------------------------------------------------------
-- O código é a credencial: vem de crypto.randomBytes (nunca Math.random) num
-- alfabeto sem caracteres ambíguos, porque ele é lido em voz alta e digitado.
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,            -- NULL = não expira
  max_uses INTEGER,              -- NULL = ilimitado
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX idx_invites_created_at ON invites (created_at DESC);

-- 5) Bans ----------------------------------------------------------------------
-- Antes do M10, sair da allowlist era definitivo (só o dono readicionava). Com
-- convite por link deixou de ser: QUALQUER link válido reabre a porta. Daí a
-- separação — kick tira da allowlist (volta com convite), ban entra aqui
-- (nenhum convite serve). A chave é o discord_id e não users.id de propósito:
-- banir tem que funcionar para quem nunca criou linha em `users`.
CREATE TABLE bans (
  discord_id TEXT PRIMARY KEY,
  banned_by INTEGER REFERENCES users(id),
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- 6) Log de moderação ----------------------------------------------------------
-- Entre amigos, "quem foi que me expulsou?" sem resposta vira briga. Guarda os
-- DOIS ids do alvo porque nem toda ação tem os dois: ban de quem nunca logou só
-- tem discord_id; mudança de cargo só tem o nosso id.
CREATE TABLE mod_log (
  id INTEGER PRIMARY KEY,        -- snowflake: ordenável por tempo, é o próprio cursor
  actor_id INTEGER REFERENCES users(id),   -- NULL = o sistema (bootstrap do dono)
  action TEXT NOT NULL,
  target_user_id INTEGER,
  target_discord_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mod_log_created_at ON mod_log (created_at DESC, id DESC);

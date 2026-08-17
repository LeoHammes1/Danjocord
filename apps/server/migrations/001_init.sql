-- Esquema inicial (doc §6). Ids são snowflakes de 64 bits (INTEGER do SQLite).
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  discord_id TEXT UNIQUE,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  family_id TEXT NOT NULL,      -- encadeia refresh tokens rotacionados (doc §5)
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE allowlist (
  discord_id TEXT PRIMARY KEY,
  invited_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER            -- soft delete
);
CREATE INDEX idx_messages_channel_id_id ON messages (channel_id, id DESC);

-- voice_states não existe de propósito: estado efêmero vive só em memória.

-- Seed: os dois canais iniciais da guild.
INSERT INTO channels (id, type, name, position) VALUES
  (1, 'text', 'geral', 0),
  (2, 'voice', 'Voz', 1);

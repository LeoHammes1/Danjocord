-- M9: soundboard. Os bytes moram AQUI, em BLOB, e não em disco solto: o pod
-- tem UM PVC (/data) e o banco já vive nele — com BLOB, backup e restore
-- continuam sendo UM arquivo (o roadmap item 118 registra que backup ainda não
-- existe; espalhar estado agora só pioraria o problema). Com 10 amigos, teto de
-- 100 sons e 512 KB por som, o pior caso do banco é ~50 MB: trivial.
CREATE TABLE sounds (
  id INTEGER PRIMARY KEY,                          -- snowflake; é também o cache key do GET de áudio
  name TEXT NOT NULL,                              -- 1..32 (validado no protocolo, aparado antes de gravar)
  uploader_id INTEGER REFERENCES users(id),        -- NULL = som embutido (seed do boot), sem dono
  mime TEXT NOT NULL CHECK (mime IN ('audio/ogg', 'audio/wav', 'audio/mpeg')),
  bytes BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,                     -- redundante com length(bytes), mas evita ler o BLOB para listar
  duration_ms INTEGER NOT NULL,                    -- MEDIDO pelo servidor abrindo o container (não é o que o cliente diz)
  gain REAL NOT NULL DEFAULT 1.0,                  -- normalização do M8 vira dado; o asset fica intacto
  created_at INTEGER NOT NULL
);

-- a listagem é ORDER BY created_at, id (embutidos primeiro, uploads na ordem
-- em que chegaram) — o índice serve a ela e ao teto de 100 sons
CREATE INDEX idx_sounds_created_at ON sounds (created_at, id);

-- Sem seed em SQL de propósito: os 9 embutidos entram no boot (sounds/seed.ts),
-- que lê os .ogg de assets/soundboard e MEDE a duração com o mesmo provador do
-- upload — um caminho só, e a migration não carrega 93 KB de literal binário.

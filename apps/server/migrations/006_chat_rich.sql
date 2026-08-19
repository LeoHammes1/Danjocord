-- M11b: o resto do chat — reply, reações, anexos, preview de link e busca
-- (roadmap 86, 87, 89, 90, 91).
--
-- As cinco coisas entram na mesma migration porque são a mesma virada: até o
-- M11a uma mensagem era texto e nada mais. A partir daqui ela tem ARESTAS —
-- aponta para outra mensagem, carrega bytes, acumula reações de terceiros e
-- vira linha de índice invertido. Cada aresta abaixo traz junto a regra que a
-- impede de virar lixo órfão no PVC.

-- 1) Reply (item 86) -----------------------------------------------------------
-- Uma coluna, não uma tabela: a citação é 1:1 e mora na própria mensagem. A FK
-- aponta para `messages` e NÃO tem ON DELETE nada de propósito — mensagem
-- apagada aqui é soft delete (`deleted_at`), a linha continua existindo, e é
-- isso que permite a citação virar "mensagem apagada" em vez de sumir.
--
-- O canal NÃO é replicado aqui: quem garante que a citada é do MESMO canal é a
-- rota do POST (senão a citação vazaria conteúdo entre canais). Guardar o
-- channel_id junto criaria uma segunda fonte da verdade para a mesma pergunta.
ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id);

-- 2) Reações (item 87) ---------------------------------------------------------
-- A PK composta É a regra de "uma pessoa não reage duas vezes com o mesmo
-- emoji": o INSERT OR IGNORE vira idempotência sem um SELECT antes. Os tetos
-- (20 emojis distintos por mensagem, 6 por pessoa por mensagem) são de
-- aplicação — o SQLite não expressa "conte o grupo antes de inserir".
--
-- `emoji` é texto Unicode (não há emoji custom neste projeto) e é validado no
-- protocolo antes de chegar aqui: um único grapheme cluster pictográfico, no
-- máximo 8 bytes UTF-8. Sem essa validação "reação" viraria um segundo canal
-- de mensagens, sem timeout, sem moderação e sem paginação.
CREATE TABLE reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
-- a PK já cobre "as reações desta mensagem" (prefixo message_id); este índice
-- serve ao caminho contrário, que é o do teto por pessoa
CREATE INDEX idx_reactions_user ON reactions (user_id, message_id);

-- 3) Anexos (item 89) — SÓ IMAGEM ---------------------------------------------
-- BLOB pelo mesmo motivo dos sons (migration 003): o pod tem UM PVC e o banco
-- já mora nele — com os bytes dentro, backup e restore continuam sendo UM
-- arquivo. Espalhar estado por diretórios agora só pioraria o item 118.
--
-- `message_id` é NULÁVEL porque o upload tem DUAS etapas: o POST de
-- /api/attachments devolve o id, e só o POST da mensagem amarra os dois. A
-- janela entre as duas é onde nasce o anexo ÓRFÃO — quem abandona o composer
-- depois de escolher a imagem. A limpeza é por idade (attachments/limits.ts) e
-- roda no boot e periodicamente; sem ela, um PVC de 2Gi enche de imagens que
-- ninguém nunca viu.
--
-- O CHECK do mime é a mesma defesa do `sounds`: o GET devolve o mime GUARDADO,
-- e o banco só aceita os quatro que o provador reconhece pelos MAGIC BYTES.
-- Servir um content-type escolhido por quem sobe, na mesma origem do app,
-- seria XSS de graça — o CHECK é a rede embaixo do provador.
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,                          -- snowflake; é o cache key do GET (conteúdo imutável)
  message_id INTEGER REFERENCES messages(id),      -- NULL = ainda não amarrado a uma mensagem (órfão em potencial)
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,                          -- só para o download; NUNCA decide o tipo
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  bytes BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,                     -- redundante com length(bytes), evita ler o BLOB para listar
  width INTEGER,                                   -- LIDAS do cabeçalho pelo servidor; NULL = formato válido sem
  height INTEGER,                                  -- dimensão legível (não acontece hoje, mas o esquema não mente)
  created_at INTEGER NOT NULL
);
-- os dois caminhos de leitura: "anexos desta mensagem" (render) e "órfãos
-- velhos" (faxina). O segundo é um scan pequeno, mas roda em timer — índice.
CREATE INDEX idx_attachments_message ON attachments (message_id);
CREATE INDEX idx_attachments_orphan ON attachments (created_at) WHERE message_id IS NULL;

-- 4) Cache de preview de link (item 90) ----------------------------------------
-- O cache é parte da SEGURANÇA, não uma otimização: sem ele, cada render de
-- cada cliente viraria uma ida do servidor à internet, e uma URL que falha
-- seria retentada para sempre. Por isso o cache é NEGATIVO também — `ok = 0`
-- guarda o motivo do fracasso e o TTL curto que o segura.
--
-- A chave é a URL normalizada (esquema + host minúsculos, fragmento fora): a
-- mesma página pedida por dois amigos é uma busca só.
--
-- NÃO existe coluna de imagem de propósito. Um `image_url` remoto faria o
-- navegador de cada amigo buscar o arquivo no site — que é exatamente o IP que
-- o unfurl server-side existe para não vazar (item 90), e ainda esbarraria na
-- CSP (`img-src 'self'`). Título, descrição e nome do site bastam.
CREATE TABLE link_previews (
  url TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,           -- 0 = falhou (cache negativo), 1 = deu certo
  title TEXT,
  description TEXT,
  site_name TEXT,
  error TEXT,                    -- frase curta em pt-BR quando ok = 0
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_link_previews_expires ON link_previews (expires_at);

-- 5) Busca (item 91) -----------------------------------------------------------
-- FTS5 com CONTEÚDO EXTERNO (`content='messages'`), não contentless: numa
-- tabela contentless o `snippet()` não funciona (o índice não guarda o texto
-- para recortar), e sem trecho a busca devolve uma lista de ids que o cliente
-- teria que ir buscar uma a uma. `content_rowid='id'` amarra o rowid do índice
-- ao snowflake INTEGER da mensagem — é o que faz o JOIN abaixo ser direto.
--
-- `remove_diacritics 2` porque a guild é brasileira: procurar "voce" tem que
-- achar "você", e "acao" tem que achar "ação".
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Os triggers de sincronia. Três armadilhas que valem estar escritas:
--
--   1. Mensagem de SISTEMA e mensagem APAGADA nunca entram no índice. Não é só
--      filtro de leitura: com conteúdo externo, mandar 'delete' de uma linha
--      que nunca foi inserida CORROMPE o índice — daí o WHEN em cada trigger
--      espelhar exatamente a condição do INSERT.
--   2. Apagar mensagem aqui é UPDATE (`deleted_at`), não DELETE. Um trigger
--      AFTER DELETE sozinho deixaria toda mensagem apagada buscável para
--      sempre — que é o vazamento mais bobo possível de um índice.
--   3. Editar é delete+insert: em FTS5 externo não existe UPDATE, e mandar só
--      o INSERT deixaria o texto ANTIGO buscável ao lado do novo.

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
WHEN new.type = 'user' AND new.deleted_at IS NULL
BEGIN
  INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_fts_au_content AFTER UPDATE OF content ON messages
WHEN old.type = 'user' AND old.deleted_at IS NULL AND new.deleted_at IS NULL
BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_fts_au_deleted AFTER UPDATE OF deleted_at ON messages
WHEN old.type = 'user' AND old.deleted_at IS NULL AND new.deleted_at IS NOT NULL
BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages
WHEN old.type = 'user' AND old.deleted_at IS NULL
BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- Backfill do histórico que já existe (a migration roda em banco com conversa
-- dentro). Mesma condição dos triggers, palavra por palavra.
INSERT INTO messages_fts (rowid, content)
  SELECT id, content FROM messages WHERE type = 'user' AND deleted_at IS NULL;

-- M11a: a base do chat — estado de leitura, menções e mensagens de sistema
-- (roadmap 79, 81, 92).
--
-- As três coisas entram na mesma migration porque respondem à mesma pergunta
-- por três ângulos: "o que ainda não vi?". Sem estado de leitura não existe
-- badge, nem separador de "novas mensagens", nem notificação que saiba o que
-- já foi lido — por isso ele vem primeiro no marco.

-- 1) Estado de leitura (item 81) ----------------------------------------------
-- Uma linha por (pessoa, canal), e nada mais: a marca é UM id, não uma lista de
-- mensagens vistas. A ausência de linha é um estado legítimo ("nunca abri este
-- canal") e é lida como "nada foi lido" — ver o comentário de `readStates` no
-- store, onde essa escolha é defendida.
CREATE TABLE read_state (
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  last_read_message_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

-- 2) Menções (item 79) ---------------------------------------------------------
-- TABELA, e não um JSON numa coluna de `messages`: a pergunta que importa é
-- "quantas mensagens me mencionam desde X", que aqui é uma query com índice —
-- e com JSON viraria `LIKE '%"id"%'`, que é o tipo de coisa que funciona até o
-- dia em que um id é prefixo de outro.
--
-- O conteúdo gravado na mensagem continua sendo o texto que a pessoa digitou
-- (nada de `<@id>`): quem resolve o nome na tela é o cliente, porque apelido
-- muda; o servidor guarda só o RESULTADO, que é o que dá para contar.
CREATE TABLE message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (message_id, user_id)
);
-- o índice que a contagem usa: "as minhas menções, da mais nova para a mais
-- velha". A PK acima serve ao caminho contrário (as menções DE uma mensagem).
CREATE INDEX idx_message_mentions_user ON message_mentions (user_id, message_id DESC);

-- `@todos` não é uma lista de ids: seria uma linha por membro por mensagem,
-- reescrita a cada entrada e saída da guild. É um flag na própria mensagem.
ALTER TABLE messages ADD COLUMN mentions_everyone INTEGER NOT NULL DEFAULT 0;

-- 3) Mensagens de sistema (item 92) --------------------------------------------
-- Entram na tabela `messages` como qualquer outra — é isso que as faz aparecer
-- na paginação, no histórico e no replay do Resume sem nenhum código especial.
-- O autor é o SUJEITO do evento (quem entrou, quem saiu) e o conteúdo fica
-- vazio: a frase é montada na tela, porque o nome exibido muda com o apelido e
-- uma frase gravada envelheceria dentro do histórico.
ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'user'
  CHECK (type IN ('user', 'member_join', 'member_leave'));

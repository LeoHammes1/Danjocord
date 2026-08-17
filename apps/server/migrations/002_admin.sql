-- M2: flag de admin (doc §5). Admin pode apagar mensagem de qualquer autor;
-- edição continua sendo só do autor. A promoção é feita pelo CLI
-- (scripts/admin.ts) — não existe UI de admin de propósito.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

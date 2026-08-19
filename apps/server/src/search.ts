import type { FastifyInstance } from "fastify";
import { authFromHeader } from "./auth.js";
import { canonicalId } from "./db/snowflake.js";
import type { Store } from "./store.js";

/**
 * Busca no histórico (M11b, item 91). O índice é FTS5 com conteúdo externo
 * sobre `messages` (migration 006); aqui mora a parte que a revisão cobra: o
 * que fazer com o TEXTO que a pessoa digitou.
 *
 * O problema: `MATCH` não recebe uma string de busca, recebe uma EXPRESSÃO com
 * sintaxe própria. `"` abre frase, `*` é prefixo, `AND`/`OR`/`NOT`/`NEAR` são
 * operadores, `(` agrupa, `-` e `^` e `:` têm significado. Mandar o texto cru
 * significa que procurar por `AND` devolve erro de SQL, procurar por `"` devolve
 * erro de SQL, e procurar por `f(x)` devolve erro de SQL — todos na cara do
 * usuário, com a mensagem do SQLite em inglês.
 *
 * A solução aqui é a mais chata e a mais robusta: NADA do que o usuário digita
 * é interpretado como sintaxe. Cada palavra vira uma frase entre aspas, e as
 * frases são exigidas todas (AND implícito do FTS5). Quem quiser operadores
 * usa outro programa; quem quiser achar a conversa de terça acha.
 */

/**
 * Texto do usuário → expressão FTS5 segura. String vazia = "não há o que
 * buscar" (a rota devolve lista vazia, não erro: campo de busca em branco não
 * é engano de ninguém).
 *
 * Como funciona: parte em palavras, joga fora tudo que não tem letra ou
 * dígito, e envolve cada palavra em aspas duplas. Dentro de aspas, o FTS5 lê o
 * conteúdo como uma FRASE — `*`, `AND`, `(`, `^`, `-` viram texto comum, e o
 * tokenizador cuida do resto. As próprias aspas do usuário são removidas antes
 * (aspas dentro de aspas é o único jeito de escapar do quoting).
 */
export function sanitizeFtsQuery(raw: string): string {
  const words = raw
    // as aspas do usuário saem ANTES de qualquer coisa: são o único caractere
    // que consegue fechar o quoting que estamos construindo
    .replace(/"/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    // palavra sem letra nem dígito não gera token nenhum no FTS5; deixá-la
    // vira `""`, que é erro de sintaxe — o caso do `q=*` e do `q=(`
    .filter((word) => word !== "" && /[\p{L}\p{N}]/u.test(word))
    // teto de palavras: uma consulta de 500 termos é um scan caro por engano
    // (ou de propósito), e ninguém procura por 500 palavras
    .slice(0, 12);

  return words.map((word) => `"${word}"`).join(" ");
}

/** Teto padrão e máximo de resultados por busca. */
const DEFAULT_LIMIT = 25;

export function registerSearchRoutes(app: FastifyInstance, store: Store): void {
  /**
   * `GET /api/search?q=&channel_id=&limit=`
   *
   * Devolve as mensagens com o trecho já recortado pelo FTS5. Mensagens
   * APAGADAS e de SISTEMA ficam de fora — as apagadas porque um índice que
   * lembra do que foi apagado é o vazamento mais bobo possível, e as de sistema
   * porque o conteúdo delas é vazio (a frase é montada na tela, M11a) e elas
   * só poluiriam o resultado.
   */
  app.get("/api/search", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const q = req.query as { q?: string; channel_id?: string; limit?: string };
    const query = sanitizeFtsQuery(typeof q.q === "string" ? q.q.slice(0, 200) : "");
    // consulta vazia não é erro: é o estado do campo de busca antes de digitar
    if (query === "") return { query, hits: [] };

    let channelId: string | undefined;
    if (q.channel_id !== undefined) {
      const parsed = canonicalId(q.channel_id);
      if (parsed === null || !store.channelExists(parsed, "text")) {
        return reply.code(404).send({ error: "canal de texto não encontrado" });
      }
      channelId = parsed;
    }

    // mesmo cuidado do `limit` da paginação (M2): só dígitos, porque
    // Number("2.5") sobreviveria ao clamp e viraria REAL no LIMIT do SQLite
    const limit = q.limit !== undefined && /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : DEFAULT_LIMIT;

    const hits = store.searchMessages(query, channelId === undefined ? { limit } : { channelId, limit });
    return { query, hits };
  });
}

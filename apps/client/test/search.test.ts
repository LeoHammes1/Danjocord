/**
 * Busca — a parte pura do painel (M11b, item 91).
 *
 * O que se testa aqui é o par de funções que decide o que aparece na tela a
 * partir do que o servidor mandou. As duas são pequenas e nenhuma toca DOM, e
 * as duas quebram de um jeito que ninguém percebe olhando uma busca que deu
 * certo:
 *
 *   - o trecho do FTS5 vem com U+0001/U+0002 no lugar de `<b>` (porque o
 *     cliente não usa innerHTML). Um marcador SEM PAR — que aparece quando o
 *     `snippet()` corta o texto no meio de um acerto — não pode derrubar o
 *     render do resultado inteiro;
 *   - se a mensagem contiver literalmente um U+0001, o parse não pode entrar
 *     em estado inválido (risco anotado no relatório do servidor);
 *   - o agrupamento por canal tem que PRESERVAR a ordem do servidor: o FTS5
 *     devolve por relevância/recência, e reordenar por id de canal faria o
 *     acerto mais óbvio descer para o fim da lista.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH_HIT_CLOSE, SEARCH_HIT_OPEN, type Message, type SearchHit } from "@danjocord/protocol";
import { groupByChannel, snippetParts } from "../src/ui/search.js";

const A = SEARCH_HIT_OPEN;
const F = SEARCH_HIT_CLOSE;

test("snippetParts separa o realce do resto", () => {
  assert.deepEqual(snippetParts(`olha o ${A}gato${F} ali`), [
    { text: "olha o ", hit: false },
    { text: "gato", hit: true },
    { text: " ali", hit: false },
  ]);
});

test("snippetParts aceita vários acertos e realce no começo e no fim", () => {
  assert.deepEqual(snippetParts(`${A}gato${F} e ${A}cão${F}`), [
    { text: "gato", hit: true },
    { text: " e ", hit: false },
    { text: "cão", hit: true },
  ]);
});

test("snippetParts sobrevive a marcador sem par", () => {
  // abre e nunca fecha: o resto do trecho fica realçado, e nada se perde
  assert.deepEqual(snippetParts(`fim do ${A}texto`), [
    { text: "fim do ", hit: false },
    { text: "texto", hit: true },
  ]);
  // fecha sem ter aberto: é só texto
  assert.deepEqual(snippetParts(`texto${F} solto`), [{ text: "texto", hit: false }, { text: " solto", hit: false }]);
});

test("snippetParts não cria pedaços vazios", () => {
  assert.deepEqual(snippetParts(`${A}${F}`), []);
  assert.deepEqual(snippetParts(""), []);
  assert.deepEqual(snippetParts(`${A}${A}oi${F}${F}`), [{ text: "oi", hit: true }]);
});

test("snippetParts trata caractere de controle solto sem quebrar", () => {
  // alguém colou um U+0001 na mensagem: o pior desfecho é um realce esquisito,
  // nunca uma exceção no meio do render da lista
  const partes = snippetParts(`a${A}b`);
  assert.equal(partes.map((p) => p.text).join(""), "ab");
});

function hit(id: string, channelId: string): SearchHit {
  const message: Message = {
    id,
    channel_id: channelId,
    author_id: "1",
    content: "x",
    created_at: 0,
    type: "user",
    mentions: [],
    mentions_everyone: false,
    attachments: [],
    reactions: [],
  };
  return { message, snippet: "x" };
}

test("groupByChannel preserva a ordem em que o servidor mandou", () => {
  const grupos = groupByChannel([hit("1", "b"), hit("2", "a"), hit("3", "b"), hit("4", "c")]);
  assert.deepEqual(
    grupos.map((g) => g.channelId),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    grupos[0]?.hits.map((h) => h.message.id),
    ["1", "3"],
  );
});

test("groupByChannel com lista vazia devolve lista vazia", () => {
  assert.deepEqual(groupByChannel([]), []);
});

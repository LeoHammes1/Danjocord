/**
 * Não lidas e navegação do histórico (M11a — itens 80, 81 e 83).
 *
 * O que se testa aqui é o NÚCLEO do ui/unread.ts: as decisões que, quando
 * erram, erram calado — a badge que some sozinha, o ack que marca como lido o
 * que ninguém leu, a linha de "novas mensagens" no lugar errado. O DOM não
 * entra: `mountUnread` e companhia só existem no navegador, e o Node importa o
 * módulo justamente porque nenhuma dessas funções toca em `document`.
 *
 * (Se este arquivo parar de CARREGAR, o suspeito é um import novo no
 * ui/unread.ts: o *type stripping* do Node recusa parameter property em
 * construtor — é o que já impede o módulo de importar o ui/messages.ts.)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "@danjocord/protocol";

import {
  decideAck,
  ehParaMim,
  fraseDetached,
  idMaior,
  isSnowflake,
  primeiraNaoLida,
  proximaMarca,
  rotuloBadge,
  type LinhaLida,
} from "../src/ui/unread.js";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

test("só snowflake vira ack — o nonce do render otimista não", () => {
  assert.equal(isSnowflake("123456789012345678"), true);
  assert.equal(isSnowflake("0"), true);
  // o data-id de uma mensagem pendente é um uuid: mandá-lo ao servidor seria
  // pedir para marcar como lida uma mensagem que ele nem conhece
  assert.equal(isSnowflake("6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8"), false);
  assert.equal(isSnowflake(""), false);
  assert.equal(isSnowflake("12a"), false);
});

test("a comparação de id é numérica de 64 bits, não de string", () => {
  // o caso que quebra a comparação lexicográfica: "9" > "10" como texto
  assert.equal(idMaior("10", "9"), true);
  assert.equal(idMaior("9", "10"), false);
  // e o que quebra o Number: os dois passam de MAX_SAFE_INTEGER e seriam iguais
  assert.equal(idMaior("9007199254740993", "9007199254740992"), true);
  assert.equal(idMaior("100", "100"), false);
});

// ---------------------------------------------------------------------------
// A marca de leitura
// ---------------------------------------------------------------------------

test("a marca só anda para frente", () => {
  assert.equal(proximaMarca(null, "100"), "100");
  assert.equal(proximaMarca("100", "101"), "101");
  assert.equal(proximaMarca("100", "99"), null);
  assert.equal(proximaMarca("100", "100"), null); // repetir o mesmo POST é ruído
  assert.equal(proximaMarca(null, "nonce-abc"), null);
});

test("marcar como lido exige foco — mas fora dele a proposta não se perde", () => {
  assert.equal(decideAck(true, null, "100"), "envia");
  // janela no tray: o app vive assim (ele tem ícone na bandeja). Marcar como
  // lido aqui é o erro que faz a pessoa voltar ao computador sem badge nenhuma
  assert.equal(decideAck(false, null, "100"), "espera-foco");
  // já lido: nem com foco vira POST
  assert.equal(decideAck(true, "100", "100"), "ignora");
  assert.equal(decideAck(false, "100", "50"), "ignora");
});

// ---------------------------------------------------------------------------
// Onde entra a linha de "novas mensagens"
// ---------------------------------------------------------------------------

const janela = (...pares: [id: string, autor: string][]): LinhaLida[] =>
  pares.map(([id, authorId]) => ({ id, authorId }));

test("a linha de novas mensagens conta de baixo para cima", () => {
  const lista = janela(["1", "ana"], ["2", "bia"], ["3", "ana"], ["4", "bia"]);
  assert.equal(primeiraNaoLida(lista, 1, "eu"), "4");
  assert.equal(primeiraNaoLida(lista, 2, "eu"), "3");
  assert.equal(primeiraNaoLida(lista, 4, "eu"), "1");
});

test("as minhas mensagens não entram na conta", () => {
  // o unread_count do servidor já exclui as minhas; contá-las aqui jogaria a
  // linha para cima de mensagens que eu já tinha lido
  const lista = janela(["1", "ana"], ["2", "eu"], ["3", "eu"], ["4", "bia"]);
  assert.equal(primeiraNaoLida(lista, 1, "eu"), "4");
  assert.equal(primeiraNaoLida(lista, 2, "eu"), "1");
});

test("não lidas além do que está carregado põem a linha no topo da janela", () => {
  // voltar depois de uma semana: tudo o que está na tela é não lido, e o resto
  // aparece ao rolar para cima
  const lista = janela(["7", "ana"], ["8", "bia"]);
  assert.equal(primeiraNaoLida(lista, 50, "eu"), "7");
});

test("sem não lidas (ou sem janela) não existe linha", () => {
  assert.equal(primeiraNaoLida(janela(["1", "ana"]), 0, "eu"), null);
  assert.equal(primeiraNaoLida([], 3, "eu"), null);
});

// ---------------------------------------------------------------------------
// O que a badge diz
// ---------------------------------------------------------------------------

test("a badge de menção ganha da de não lidas", () => {
  const so = rotuloBadge(5, 0);
  assert.equal(so?.texto, "5");
  assert.equal(so?.mencao, false);
  // 12 não lidas das quais 2 são para mim: a badge mostra 2 e fica vermelha —
  // o número que importa é "quantas são comigo"
  const com = rotuloBadge(12, 2);
  assert.equal(com?.texto, "2");
  assert.equal(com?.mencao, true);
  assert.equal(com?.leitura, "2 menções");
});

test("canal sem não lida não tem badge nenhuma", () => {
  assert.equal(rotuloBadge(0, 0), null);
  // mention_count sem unread_count não existe no servidor (menção É não lida),
  // mas se existisse a badge continuaria fora: zero é zero
  assert.equal(rotuloBadge(0, 3), null);
});

test("a badge encurta o número, o leitor de tela recebe o de verdade", () => {
  const muitas = rotuloBadge(1200, 0);
  assert.equal(muitas?.texto, "99+");
  assert.equal(muitas?.leitura, "1200 mensagens não lidas");
  assert.equal(rotuloBadge(1, 0)?.leitura, "1 mensagem não lida");
  assert.equal(rotuloBadge(3, 1)?.leitura, "1 menção");
});

// ---------------------------------------------------------------------------
// A barra de "pular para o presente"
// ---------------------------------------------------------------------------

test("a barra diz quantas mensagens ficaram para trás", () => {
  // zero é legítimo: o fundo se solta no trim de um prepend, sem mensagem nova
  assert.equal(fraseDetached(0), "Você está lendo mensagens antigas");
  assert.equal(fraseDetached(1), "1 mensagem nova desde que você parou");
  assert.equal(fraseDetached(9), "9 mensagens novas desde que você parou");
});

// ---------------------------------------------------------------------------
// "Esta mensagem é para mim?"
// ---------------------------------------------------------------------------

/** Message mínima: só os campos que a regra de menção lê. */
const msg = (autor: string, mentions: string[], everyone = false): Message =>
  ({
    id: "1",
    channel_id: "c",
    author_id: autor,
    content: "",
    created_at: 0,
    type: "user",
    mentions,
    mentions_everyone: everyone,
  }) satisfies Message;

test("a menção vem RESOLVIDA do servidor — aqui não se lê texto", () => {
  assert.equal(ehParaMim(msg("ana", ["eu"]), "eu"), true);
  assert.equal(ehParaMim(msg("ana", ["bia"]), "eu"), false);
  assert.equal(ehParaMim(msg("ana", [], true), "eu"), true); // @todos
  // a minha própria mensagem nunca me menciona, nem com @todos
  assert.equal(ehParaMim(msg("eu", ["eu"], true), "eu"), false);
  assert.equal(ehParaMim(msg("ana", [], true), null), false);
});

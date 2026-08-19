/**
 * Testes do parser de menções (M11a, item 79).
 *
 * A suíte vive no PROTOCOLO, e não no servidor, pelo mesmo motivo que a função
 * vive: cliente e servidor dependem da mesma resposta, e um teste só é o que
 * garante que eles não vão divergir. O módulo é puro — nada de banco, Fastify
 * ou relógio.
 *
 * Importa `../src/mentions.ts` direto (type stripping do Node), e não o `dist`:
 * teste que depende de build passa a falhar por motivo errado.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMentions, type MentionCandidate } from "../src/mentions.ts";

const leo: MentionCandidate = { id: "1", username: "leo", nickname: null };
const leonardo: MentionCandidate = { id: "2", username: "leonardo", nickname: null };
const comPonto: MentionCandidate = { id: "3", username: "ana.paula", nickname: null };
const comApelido: MentionCandidate = { id: "4", username: "jrsilva", nickname: "Zé Júnior" };
const TODOS = [leo, leonardo, comPonto, comApelido];

test("menção simples casa e devolve o id", () => {
  assert.deepEqual(parseMentions("oi @leo, tudo bem?", TODOS), { userIds: ["1"], everyone: false });
});

test("@leo NÃO casa dentro de @leonardo (casamento mais longo primeiro)", () => {
  // o caso que dá nome à regra: sem ordenar por tamanho, o dono do nome curto
  // levaria todas as notificações do dono do nome longo
  assert.deepEqual(parseMentions("fala @leonardo", TODOS), { userIds: ["2"], everyone: false });
  // e o inverso continua valendo: @leo sozinho é do leo
  assert.deepEqual(parseMentions("fala @leo", TODOS), { userIds: ["1"], everyone: false });
});

test("@leo não casa dentro de @leonardo NEM quando leonardo não é membro", () => {
  // aqui a ordenação não salva — quem salva é a borda depois do nome
  assert.deepEqual(parseMentions("fala @leonardo", [leo]), { userIds: [], everyone: false });
});

test("nome com ponto: o \\b do regex não serviria de borda", () => {
  assert.deepEqual(parseMentions("bom dia @ana.paula", TODOS), { userIds: ["3"], everyone: false });
  // e o prefixo curto não pode casar dentro do nome com ponto
  assert.deepEqual(parseMentions("bom dia @ana.paula", [{ id: "9", username: "ana", nickname: null }]), {
    userIds: [],
    everyone: false,
  });
});

test("pontuação final não quebra a menção", () => {
  assert.deepEqual(parseMentions("valeu @leo.", TODOS), { userIds: ["1"], everyone: false });
  assert.deepEqual(parseMentions("valeu @leo!", TODOS), { userIds: ["1"], everyone: false });
  assert.deepEqual(parseMentions("@leo: olha isso", TODOS), { userIds: ["1"], everyone: false });
  assert.deepEqual(parseMentions("(@leo)", TODOS), { userIds: ["1"], everyone: false });
});

test("apelido também menciona, e sem distinção de maiúsculas (item 55)", () => {
  assert.deepEqual(parseMentions("@zé júnior manda ver", TODOS), { userIds: ["4"], everyone: false });
  assert.deepEqual(parseMentions("@JRSILVA manda ver", TODOS), { userIds: ["4"], everyone: false });
});

test("nome inexistente não menciona ninguém", () => {
  assert.deepEqual(parseMentions("@fulano você existe?", TODOS), { userIds: [], everyone: false });
});

test("e-mail não menciona: o @ precisa de borda antes", () => {
  assert.deepEqual(parseMentions("manda para contato@leo.com", TODOS), { userIds: [], everyone: false });
});

test("@todos liga everyone sem mencionar ninguém em particular", () => {
  assert.deepEqual(parseMentions("reunião agora @todos", TODOS), { userIds: [], everyone: true });
});

test("membro chamado 'todos' vence a palavra-chave no empate", () => {
  const time: MentionCandidate = { id: "7", username: "todos", nickname: null };
  assert.deepEqual(parseMentions("@todos", [...TODOS, time]), { userIds: ["7"], everyone: false });
});

test("bloco e trecho de código não mencionam", () => {
  assert.deepEqual(parseMentions("olha o comando: `ping @todos`", TODOS), { userIds: [], everyone: false });
  assert.deepEqual(parseMentions("```\nchown @leo /tmp\n```", TODOS), { userIds: [], everyone: false });
  // fora do bloco continua contando
  assert.deepEqual(parseMentions("```\n@leo\n``` mas @leonardo sim", TODOS), { userIds: ["2"], everyone: false });
});

test("crase não fechada é texto literal, não código até o fim", () => {
  // engolir o resto da mensagem por causa de uma crase solta silenciaria
  // menções de verdade — e crase solta é erro de digitação comum
  assert.deepEqual(parseMentions("aspas ` soltas e @leo", TODOS), { userIds: ["1"], everyone: false });
  assert.deepEqual(parseMentions("```\nfence aberta e @leo", TODOS), { userIds: ["1"], everyone: false });
});

test("repetição não duplica, e a ordem é a da primeira aparição", () => {
  assert.deepEqual(parseMentions("@leonardo @leo @leonardo @todos", TODOS), {
    userIds: ["2", "1"],
    everyone: true,
  });
});

test("texto sem @ nenhum e lista de membros vazia não explodem", () => {
  assert.deepEqual(parseMentions("mensagem comum", TODOS), { userIds: [], everyone: false });
  assert.deepEqual(parseMentions("@leo", []), { userIds: [], everyone: false });
  assert.deepEqual(parseMentions("", TODOS), { userIds: [], everyone: false });
  assert.deepEqual(parseMentions("@", TODOS), { userIds: [], everyone: false });
});

test("apelido vazio não vira candidato (senão todo @ casaria)", () => {
  const vazio: MentionCandidate = { id: "8", username: "vazio", nickname: "   " };
  assert.deepEqual(parseMentions("@ qualquer coisa", [vazio]), { userIds: [], everyone: false });
});

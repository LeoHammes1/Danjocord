/**
 * O cache de sons do soundboard (M9). O que se testa aqui é o INVARIANTE: o
 * total em bytes tem que andar em par com o conteúdo. Um cache que erra a conta
 * não falha — ele só deixa o app pesado, meses depois, sem pista nenhuma.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ByteLru } from "../src/sound/lru.js";

/** item de tamanho declarado, para a conta ser conferível na mão */
const kb = (n: number): { bytes: number } => ({ bytes: n * 1024 });
const lru = (maxKb: number) => new ByteLru<{ bytes: number }>(maxKb * 1024, (v) => v.bytes);

test("o total acompanha put e delete", () => {
  const c = lru(100);
  c.put("a", kb(10));
  c.put("b", kb(20));
  assert.equal(c.bytes, 30 * 1024);
  assert.equal(c.size, 2);
  c.delete("a");
  assert.equal(c.bytes, 20 * 1024);
  assert.equal(c.delete("a"), false, "delete do que não existe não mexe no total");
  assert.equal(c.bytes, 20 * 1024);
});

test("substituir a mesma chave não soma duas vezes", () => {
  const c = lru(100);
  c.put("a", kb(10));
  c.put("a", kb(30));
  assert.equal(c.bytes, 30 * 1024, "o antigo saiu da conta");
  assert.equal(c.size, 1);
});

test("estourar o teto descarta o MAIS ANTIGO primeiro", () => {
  const c = lru(50);
  c.put("a", kb(20));
  c.put("b", kb(20));
  c.put("c", kb(20)); // 60 > 50: "a" sai
  assert.deepEqual(c.keys(), ["b", "c"]);
  assert.equal(c.bytes, 40 * 1024);
});

test("get marca uso: quem foi usado sobrevive à próxima limpeza", () => {
  const c = lru(50);
  c.put("a", kb(20));
  c.put("b", kb(20));
  c.get("a"); // "a" passa a ser o mais recente
  c.put("c", kb(20)); // agora o mais antigo é "b"
  assert.deepEqual(c.keys(), ["a", "c"]);
});

test("peek NÃO marca uso — é consulta, não acesso", () => {
  const c = lru(50);
  c.put("a", kb(20));
  c.put("b", kb(20));
  c.peek("a");
  c.put("c", kb(20));
  assert.deepEqual(c.keys(), ["b", "c"], "peek não salvou o 'a'");
});

test("o recém-chegado nunca é descartado, mesmo maior que o teto", () => {
  const c = lru(50);
  c.put("a", kb(20));
  c.put("gigante", kb(200));
  assert.deepEqual(c.keys(), ["gigante"], "o antigo saiu; o novo ficou");
  assert.equal(c.bytes, 200 * 1024, "o total conta a verdade, mesmo acima do teto");
});

test("teto zero não guarda nada — mas ainda devolve o que acabou de entrar", () => {
  const c = lru(0);
  c.put("a", kb(1));
  assert.equal(c.size, 1, "o recém-chegado é intocável por contrato");
  c.put("b", kb(1));
  assert.deepEqual(c.keys(), ["b"], "e o anterior sai na entrada do seguinte");
});

test("retain descarta o que saiu do catálogo e corrige o total", () => {
  const c = lru(100);
  c.put("a", kb(10));
  c.put("b", kb(10));
  c.put("c", kb(10));
  c.retain((id) => id !== "b");
  assert.deepEqual(c.keys(), ["a", "c"]);
  assert.equal(c.bytes, 20 * 1024);
});

test("clear zera conteúdo E total", () => {
  const c = lru(100);
  c.put("a", kb(10));
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.bytes, 0);
});

test("o caso que motivou o teto: 100 sons de 1,9 MB não passam de 24 MB", () => {
  // é o cenário real — tocar todo o catálogo ao longo de uma sessão
  const cache = new ByteLru<{ bytes: number }>(24 * 1024 * 1024, (v) => v.bytes);
  for (let i = 0; i < 100; i++) cache.put(`som${i}`, { bytes: 1.9 * 1024 * 1024 });
  assert.ok(cache.bytes <= 24 * 1024 * 1024, `ficou em ${Math.round(cache.bytes / 1024 / 1024)} MB`);
  assert.ok(cache.size < 100, "não guardou os 100");
  assert.ok(cache.keys().includes("som99"), "e o último tocado continua em cache");
});

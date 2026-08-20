import test from "node:test";
import assert from "node:assert/strict";
import { deveRearmarPaginacao, type EstadoRearme } from "../src/pagination.js";

/**
 * O rearme da paginação (`maybeLoadOlder` chamando a si mesmo). Ele existe para
 * o caso legítimo — viewport mais alto que a página, sem rolagem para gerar o
 * próximo evento — e era um laço infinito em dois caminhos. Ver pagination.ts.
 */

const base: EstadoRearme = {
  mesmaView: true,
  reachedStart: false,
  scrollTop: 0,
  topThreshold: 200,
  avancou: true,
};

test("rearma quando a página entrou e o topo continua à vista", () => {
  assert.equal(deveRearmarPaginacao(base), true);
  assert.equal(deveRearmarPaginacao({ ...base, scrollTop: 199 }), true);
});

test("NÃO rearma quando a tentativa não pôs nada na tela", () => {
  // este é o caso que fazia uma requisição por RTT para sempre: o fetch falha
  // (429/5xx/rede), nada é prependado, scrollTop não se mexe e reachedStart
  // continua false — as três condições antigas seguiam verdadeiras
  assert.equal(deveRearmarPaginacao({ ...base, avancou: false }), false);
});

test("NÃO rearma com a página inteira filtrada — o cursor não avançou", () => {
  // 50 mensagens de gente bloqueada: nenhum erro acontece, `older.length` é 50,
  // mas o DOM não muda e `before` sai do DOM. Pedir de novo é pedir a MESMA
  // página. Mesmo laço, sem erro nenhum.
  assert.equal(deveRearmarPaginacao({ ...base, avancou: false, scrollTop: 0 }), false);
});

test("para nas condições que já paravam antes", () => {
  assert.equal(deveRearmarPaginacao({ ...base, mesmaView: false }), false, "trocou de canal");
  assert.equal(deveRearmarPaginacao({ ...base, reachedStart: true }), false, "acabou o histórico");
  assert.equal(deveRearmarPaginacao({ ...base, scrollTop: 201 }), false, "longe do topo");
});

test("falha e depois sucesso volta a rearmar", () => {
  assert.equal(deveRearmarPaginacao({ ...base, avancou: false }), false);
  assert.equal(deveRearmarPaginacao({ ...base, avancou: true }), true);
});

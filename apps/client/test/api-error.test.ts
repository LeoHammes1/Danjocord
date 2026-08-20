import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, lerErro, textoDoErro } from "../src/api-error.js";

/**
 * O que o usuário lê quando uma chamada falha. Antes do M12 o `api()` jogava o
 * corpo fora e dizia "429 em /api/channels/1/messages" — o rate limit geral
 * (roadmap 117) tornou isso inaceitável, porque o corpo do 429 traz a única
 * informação acionável que existe: quanto tempo esperar.
 */

test("429 vira uma frase com o tempo de espera", () => {
  const r = lerErro(429, { error: "muitas mensagens seguidas", retry_after: 2.4 }, "/api/x");
  assert.equal(r.retryAfter, 2.4);
  assert.match(r.mensagem, /muitas mensagens seguidas/);
  assert.match(r.mensagem, /3s/, "arredonda PARA CIMA — dizer 2 s quando faltam 2,4 manda tentar cedo demais");
});

test("429 com espera curtíssima não manda esperar zero", () => {
  // "tente de novo em 0s" não é instrução nenhuma
  assert.match(lerErro(429, { error: "calma", retry_after: 0.2 }, "/api/x").mensagem, /1s/);
});

test("429 sem corpo utilizável ainda diz alguma coisa", () => {
  const r = lerErro(429, null, "/api/x");
  assert.equal(r.retryAfter, null);
  assert.equal(r.mensagem, "muitas ações seguidas");
});

test("erro comum usa a frase do servidor, que é mais específica que o status", () => {
  assert.equal(lerErro(403, { error: "você está silenciado neste servidor" }, "/api/x").mensagem, "você está silenciado neste servidor");
  assert.equal(lerErro(403, { error: "x" }, "/api/x").retryAfter, null, "só o 429 tem retryAfter");
});

test("sem corpo nenhum sobra o status, que ao menos distingue não-pode de caiu", () => {
  assert.equal(lerErro(502, "<html>bad gateway</html>", "/api/x").mensagem, "502 em /api/x");
});

test("textoDoErro atravessa qualquer coisa que caia num catch", () => {
  assert.equal(textoDoErro(new ApiError(429, "espere 3s", 3)), "espere 3s");
  assert.equal(textoDoErro(new Error("rede caiu")), "rede caiu");
  assert.equal(textoDoErro(null, "não deu certo"), "não deu certo");
  assert.equal(textoDoErro(new Error(""), "não deu certo"), "não deu certo", "Error vazio não pode virar frase vazia na tela");
});

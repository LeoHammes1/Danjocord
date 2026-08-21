/**
 * O roteamento de `/download` (M14).
 *
 * Uma regex e uma comparação, e ainda assim vale teste: o boot decide entre
 * TRÊS telas (convite, download, app) olhando só o `pathname`, e um casamento
 * frouxo aqui sequestra caminhos que pertencem a outra coisa — `/downloads`
 * (se um dia existir) ou qualquer coisa abaixo de `/download/`. O modo de
 * falha é a tela errada aparecer, sem erro nenhum no console.
 *
 * O módulo é PURO de propósito (nenhum import de navegador) — é o que permite
 * o Node carregá-lo. Ver o comentário no topo dele.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { consumirVoltaParaDownload, isDownloadRoute, lembrarVoltaParaDownload } from "../src/download-route.js";

test("só /download é a página de download", () => {
  assert.equal(isDownloadRoute("/download"), true);
  assert.equal(isDownloadRoute("/download/"), true, "barra final é o mesmo caminho");

  assert.equal(isDownloadRoute("/"), false);
  assert.equal(isDownloadRoute("/downloads"), false, "prefixo não basta");
  assert.equal(isDownloadRoute("/download/app.exe"), false, "nada abaixo de /download é esta tela");
  assert.equal(isDownloadRoute("/invite/ABCD"), false);
  assert.equal(isDownloadRoute("/api/updates/latest"), false);
  // maiúscula não: o caminho que a gente publica é minúsculo, e aceitar
  // variações faria a barra de endereço mostrar uma coisa e o histórico outra
  assert.equal(isDownloadRoute("/Download"), false);
});

test("a query e o fragment não fazem parte do pathname (e não devem quebrar)", () => {
  // `location.pathname` nunca traz `?` nem `#`, mas quem chama pode errar — e o
  // erro seria a página não abrir depois de um redirect com `?erro=`
  assert.equal(isDownloadRoute("/download"), true);
  assert.equal(isDownloadRoute("/download?erro=ticket"), false, "quem separa a query é o navegador, não esta regex");
});

test("sem sessionStorage (Node), o caminho de volta some em silêncio", () => {
  // é o comportamento em modo privativo e com storage cheio: perder o caminho
  // de volta é chato, não é erro — o que não pode é lançar no meio do boot
  assert.doesNotThrow(() => lembrarVoltaParaDownload());
  assert.equal(consumirVoltaParaDownload(), false);
});

test("com sessionStorage, a volta serve UMA vez", () => {
  const guardado = new Map<string, string>();
  const fake = {
    getItem: (k: string) => guardado.get(k) ?? null,
    setItem: (k: string, v: string) => void guardado.set(k, v),
    removeItem: (k: string) => void guardado.delete(k),
  };
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = fake;
  try {
    lembrarVoltaParaDownload();
    assert.equal(consumirVoltaParaDownload(), true);
    // segunda leitura é falsa: senão um F5 depois de já ter voltado jogaria a
    // pessoa na página de download de novo, para sempre
    assert.equal(consumirVoltaParaDownload(), false);
    assert.equal(guardado.size, 0, "consumir também APAGA");
  } finally {
    delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  }
});

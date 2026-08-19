/**
 * O miolo puro das mensagens (M11b) — agrupamento, caixa reservada do anexo,
 * delta de reação, rótulo de quem reagiu e o link que vira cartão.
 *
 * O que NÃO é testado aqui é o que só existe com DOM (o `apps/client` não tem
 * jsdom, e o marco não instala dependência): por isso o `ui/messages.ts`
 * delega a REGRA para cá e fica só com os nós. O relatório lista o que foi
 * verificado à mão na tela.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACHMENT_FALLBACK,
  applyReactionDelta,
  displayDomain,
  excerptText,
  firstLink,
  fitBox,
  groupDecision,
  GROUP_WINDOW_MS,
  messageLink,
  reactionLabel,
  sameDay,
  type GroupFacts,
} from "../src/ui/messages-core.ts";

// meio-dia, para nenhum caso encostar na virada do dia por fuso
const T0 = new Date(2026, 4, 10, 12, 0, 0).getTime();
const DIA = 86_400_000;

function facts(over: Partial<GroupFacts> = {}): GroupFacts {
  return { ts: T0, author: "1", system: false, reply: false, ...over };
}

describe("groupDecision", () => {
  it("primeira mensagem da janela sempre abre o dia e nunca é continuação", () => {
    const d = groupDecision(null, facts());
    assert.equal(d.newDay, true);
    assert.equal(d.cont, false);
  });

  it("mesmo autor, dentro da janela: continuação", () => {
    const d = groupDecision(facts(), facts({ ts: T0 + 60_000 }));
    assert.equal(d.newDay, false);
    assert.equal(d.cont, true);
  });

  it("autor diferente quebra o bloco", () => {
    const d = groupDecision(facts(), facts({ ts: T0 + 1000, author: "2" }));
    assert.equal(d.cont, false);
  });

  it("a janela de 7 min é exclusiva na borda", () => {
    assert.equal(groupDecision(facts(), facts({ ts: T0 + GROUP_WINDOW_MS - 1 })).cont, true);
    assert.equal(groupDecision(facts(), facts({ ts: T0 + GROUP_WINDOW_MS })).cont, false);
  });

  it("dia novo abre separador e impede continuação", () => {
    const d = groupDecision(facts(), facts({ ts: T0 + DIA }));
    assert.equal(d.newDay, true);
    assert.equal(d.cont, false);
  });

  it("mensagem de sistema quebra o bloco pelos DOIS lados", () => {
    // ela nunca é continuação…
    assert.equal(groupDecision(facts(), facts({ ts: T0 + 1000, system: true })).cont, false);
    // …e quem vem depois dela também não (o caso real: "fulano entrou" seguido
    // do próprio fulano falando — o autor casa e o avatar sumiria)
    assert.equal(groupDecision(facts({ system: true }), facts({ ts: T0 + 1000 })).cont, false);
  });

  it("M11b: reply NUNCA é continuação, mesmo do mesmo autor e no mesmo minuto", () => {
    const d = groupDecision(facts(), facts({ ts: T0 + 1000, reply: true }));
    assert.equal(d.newDay, false);
    assert.equal(d.cont, false);
  });

  it("M11b: a mensagem DEPOIS de um reply continua podendo agrupar", () => {
    // o reply quebra o bloco só para si — quem vem embaixo dele, do mesmo
    // autor e na janela, continua sendo continuação DELE
    const d = groupDecision(facts({ ts: T0 + 1000, reply: true }), facts({ ts: T0 + 2000 }));
    assert.equal(d.cont, true);
  });

  it("anexo e reação não entram na decisão (não há campo para eles)", () => {
    // trava de contrato: se um dia alguém acrescentar "tem anexo" ao
    // agrupamento, este teste é o lugar de justificar a mudança
    assert.deepEqual(Object.keys(facts()).sort(), ["author", "reply", "system", "ts"]);
  });
});

describe("sameDay", () => {
  it("é por calendário local, não por 24 h", () => {
    const noite = new Date(2026, 4, 10, 23, 30).getTime();
    const madrugada = new Date(2026, 4, 11, 0, 30).getTime();
    assert.equal(sameDay(noite, madrugada), false);
    assert.equal(sameDay(noite, noite + 1000), true);
  });
});

describe("fitBox", () => {
  it("cabe no teto preservando a proporção", () => {
    const b = fitBox(4000, 3000);
    assert.equal(b.w, 400);
    assert.equal(b.h, 300);
  });

  it("imagem alta e estreita é limitada pela ALTURA", () => {
    const b = fitBox(600, 3000);
    assert.equal(b.h, 300);
    assert.equal(b.w, 60);
  });

  it("imagem menor que o teto NÃO é ampliada", () => {
    const b = fitBox(64, 64);
    assert.deepEqual(b, { w: 64, h: 64 });
  });

  it("dimensão ausente cai no quadro padrão (o servidor admite null)", () => {
    assert.deepEqual(fitBox(null, null), ATTACHMENT_FALLBACK);
    assert.deepEqual(fitBox(300, null), ATTACHMENT_FALLBACK);
  });

  it("dimensão absurda não vira NaN nem caixa invertida", () => {
    assert.deepEqual(fitBox(0, 100), ATTACHMENT_FALLBACK);
    assert.deepEqual(fitBox(-10, 10), ATTACHMENT_FALLBACK);
    assert.deepEqual(fitBox(Number.NaN, 10), ATTACHMENT_FALLBACK);
  });
});

describe("applyReactionDelta", () => {
  const base = [{ emoji: "👍", user_ids: ["1", "2"] }];

  it("acrescenta quem ainda não estava", () => {
    assert.deepEqual(applyReactionDelta(base, "👍", "3", true), [{ emoji: "👍", user_ids: ["1", "2", "3"] }]);
  });

  it("é IDEMPOTENTE: o mesmo evento duas vezes não duplica", () => {
    const uma = applyReactionDelta(base, "👍", "3", true);
    assert.deepEqual(applyReactionDelta(uma, "👍", "3", true), uma);
  });

  it("emoji novo entra no FIM (a barra não se reordena embaixo do cursor)", () => {
    const out = applyReactionDelta(base, "🎉", "1", true);
    assert.deepEqual(out.map((r) => r.emoji), ["👍", "🎉"]);
  });

  it("remover o último de um emoji tira a pílula inteira", () => {
    const out = applyReactionDelta([{ emoji: "🎉", user_ids: ["9"] }], "🎉", "9", false);
    assert.deepEqual(out, []);
  });

  it("remover quem não reagiu não muda nada", () => {
    assert.deepEqual(applyReactionDelta(base, "👍", "77", false), base);
    assert.deepEqual(applyReactionDelta(base, "🎉", "1", false), base);
  });

  it("não muta a lista recebida", () => {
    const original = [{ emoji: "👍", user_ids: ["1"] }];
    const copia = structuredClone(original);
    applyReactionDelta(original, "👍", "2", true);
    applyReactionDelta(original, "👍", "1", false);
    assert.deepEqual(original, copia);
  });
});

describe("reactionLabel", () => {
  it("uma pessoa, verbo no singular", () => {
    assert.equal(reactionLabel("👍", ["Ana"]), "Ana reagiu com 👍");
  });

  it("duas pessoas, com 'e'", () => {
    assert.equal(reactionLabel("👍", ["Você", "Ana"]), "Você e Ana reagiram com 👍");
  });

  it("três ou mais: vírgula e 'e' no último", () => {
    assert.equal(reactionLabel("👍", ["Ana", "Bruno", "Caio"]), "Ana, Bruno e Caio reagiram com 👍");
  });

  it("muita gente vira 'e mais N'", () => {
    const nomes = ["a", "b", "c", "d", "e", "f", "g", "h"];
    assert.equal(reactionLabel("👍", nomes), "a, b, c, d, e, f e mais 2 reagiram com 👍");
  });

  it("sem ninguém vira o rótulo do botão de pôr", () => {
    assert.equal(reactionLabel("👍", []), "Reagir com 👍");
  });
});

describe("firstLink", () => {
  it("acha o primeiro http/https", () => {
    assert.equal(firstLink("olha isto https://exemplo.com/a e isto http://outro.com"), "https://exemplo.com/a");
  });

  it("sem link nenhum devolve null", () => {
    assert.equal(firstLink("nenhuma url aqui, só texto"), null);
  });

  it("link dentro de bloco de código NÃO vira cartão", () => {
    // é o mesmo parser que desenha o <a>: para ele isto não é link
    assert.equal(firstLink("```\nhttps://exemplo.com\n```"), null);
    assert.equal(firstLink("`https://exemplo.com`"), null);
  });

  it("acha link dentro de negrito e de citação", () => {
    assert.equal(firstLink("**https://exemplo.com**"), "https://exemplo.com");
    assert.equal(firstLink("> https://exemplo.com"), "https://exemplo.com");
  });

  it("pontuação de fim de frase fica fora (regra do scanner do markdown)", () => {
    assert.equal(firstLink("veja https://exemplo.com."), "https://exemplo.com");
  });
});

describe("displayDomain", () => {
  it("tira o www", () => {
    assert.equal(displayDomain("https://www.exemplo.com/a/b?c=1"), "exemplo.com");
  });
  it("mantém subdomínio que não é www", () => {
    assert.equal(displayDomain("https://docs.exemplo.com/"), "docs.exemplo.com");
  });
  it("URL impossível devolve null em vez de lançar", () => {
    assert.equal(displayDomain("nada disso"), null);
  });
});

describe("excerptText", () => {
  it("achata quebras de linha (a citação é UMA linha)", () => {
    assert.equal(excerptText("linha um\n\nlinha  dois"), "linha um linha dois");
  });
  it("corta com reticências quando passa do teto", () => {
    const longo = "x".repeat(300);
    const out = excerptText(longo);
    assert.equal(out.length, 140);
    assert.ok(out.endsWith("…"));
  });
  it("texto vazio continua vazio (quem decide o rótulo é a tela)", () => {
    assert.equal(excerptText("   \n "), "");
  });
});

describe("messageLink", () => {
  it("põe o caminho no FRAGMENTO (o cliente é uma página só)", () => {
    assert.equal(messageLink("https://danjocord.leohammes.dev", "/", "7", "42"), "https://danjocord.leohammes.dev/#/channels/7/42");
  });
});

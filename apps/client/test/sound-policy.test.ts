/**
 * Política de som (M8). A razão de `policy.ts` ser puro é exatamente esta
 * suíte: as regras de "toca ou não toca" estavam implícitas e duplicadas no
 * main.ts, onde nenhuma delas era testável sem subir um navegador.
 *
 * Nada aqui importa `assets.ts` — ele importa .ogg e o Node não sabe carregar
 * .ogg. É por isso que o catálogo (dados) e os assets (URLs) são módulos
 * separados.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CATALOG } from "../src/sound/catalog.js";
import { decide, type SoundEvent, type SoundPrefs, type SoundWorld } from "../src/sound/policy.js";

const ME = "111";
const OTHER = "222";
const MY_VOICE = "voice-a";
const OTHER_VOICE = "voice-b";
const OPEN_TEXT = "text-a";
const OTHER_TEXT = "text-b";

function prefs(patch: Partial<SoundPrefs> = {}): SoundPrefs {
  return {
    master: true,
    volume: 1,
    categories: { voice: true, notify: true, self: true, system: true },
    ...patch,
  };
}

/** Mundo padrão: logado, em voz no MY_VOICE, vendo OPEN_TEXT, janela em foco. */
function world(patch: Partial<SoundWorld> = {}): SoundWorld {
  return {
    meId: ME,
    deafened: false,
    voiceChannelId: MY_VOICE,
    viewingChannelId: OPEN_TEXT,
    windowFocused: true,
    muted: false,
    prefs: prefs(),
    ...patch,
  };
}

function plays(ev: SoundEvent, w: SoundWorld): boolean {
  return decide(ev, w) !== null;
}

test("voz: join de outro no MEU canal toca", () => {
  assert.ok(plays({ name: "voice-join", actorId: OTHER, channelId: MY_VOICE }, world()));
});

test("voz: join em canal alheio não toca", () => {
  assert.ok(!plays({ name: "voice-join", actorId: OTHER, channelId: OTHER_VOICE }, world()));
});

test("voz: o MEU próprio join toca (o Discord faz assim, e é o feedback da ação)", () => {
  assert.ok(plays({ name: "voice-join", actorId: ME, channelId: MY_VOICE }, world()));
});

test("voz: leave não toca quando eu nem estou em voz (null não casa com null)", () => {
  const w = world({ voiceChannelId: null });
  assert.ok(!plays({ name: "voice-leave", actorId: OTHER, channelId: null }, w));
});

test("voz: o MEU leave toca mesmo com o canal já zerado (o evento diz de onde saí)", () => {
  const w = world({ voiceChannelId: null });
  assert.ok(plays({ name: "voice-leave", actorId: ME, channelId: MY_VOICE }, w));
  // sem canal nenhum no evento não há contexto — e aí não toca
  assert.ok(!plays({ name: "voice-leave", actorId: ME, channelId: null }, w));
});

test("go live: stream de OUTRO no meu canal toca; o meu não se anuncia para mim", () => {
  assert.ok(plays({ name: "stream-start", actorId: OTHER, channelId: MY_VOICE }, world()));
  assert.ok(!plays({ name: "stream-start", actorId: ME, channelId: MY_VOICE }, world()));
});

test("mensagem: a minha própria nunca toca", () => {
  assert.ok(!plays({ name: "message", actorId: ME, channelId: OTHER_TEXT }, world()));
});

test("mensagem: no canal que estou vendo com a janela em foco, não toca", () => {
  assert.ok(!plays({ name: "message", actorId: OTHER, channelId: OPEN_TEXT }, world()));
});

test("mensagem: a MESMA, com a janela sem foco, toca", () => {
  const w = world({ windowFocused: false });
  assert.ok(plays({ name: "message", actorId: OTHER, channelId: OPEN_TEXT }, w));
});

test("mensagem: em canal que não estou vendo, toca mesmo com a janela em foco", () => {
  assert.ok(plays({ name: "message", actorId: OTHER, channelId: OTHER_TEXT }, world()));
});

test("menção: toca no canal aberto (menciona-se para ser ouvido), nunca a minha", () => {
  assert.ok(plays({ name: "mention", actorId: OTHER, channelId: OPEN_TEXT }, world()));
  assert.ok(!plays({ name: "mention", actorId: ME, channelId: OPEN_TEXT }, world()));
});

test("deafen silencia notify: menção não toca", () => {
  const w = world({ deafened: true });
  assert.ok(!plays({ name: "mention", actorId: OTHER, channelId: OPEN_TEXT }, w));
});

test("deafen silencia voice: join de outro não toca", () => {
  const w = world({ deafened: true });
  assert.ok(!plays({ name: "voice-join", actorId: OTHER, channelId: MY_VOICE }, w));
});

test("deafen NÃO silencia self: o som de voltar a ouvir toca", () => {
  const w = world({ deafened: true });
  assert.ok(plays({ name: "self-undeafen" }, w));
});

test("deafen NÃO silencia system: a queda de conexão toca", () => {
  const w = world({ deafened: true });
  assert.ok(plays({ name: "disconnected" }, w));
});

test("categoria desligada cala aquela categoria e só ela", () => {
  const w = world({ prefs: prefs({ categories: { voice: false, notify: true, self: true, system: true } }) });
  assert.ok(!plays({ name: "voice-join", actorId: OTHER, channelId: MY_VOICE }, w));
  assert.ok(plays({ name: "mention", actorId: OTHER, channelId: OPEN_TEXT }, w));
});

test("master desligado cala tudo, inclusive system", () => {
  const w = world({ prefs: prefs({ master: false }) });
  assert.ok(!plays({ name: "voice-join", actorId: OTHER, channelId: MY_VOICE }, w));
  assert.ok(!plays({ name: "self-undeafen" }, w));
  assert.ok(!plays({ name: "disconnected" }, w));
});

test("ganho final = ganho do catálogo x volume", () => {
  const w = world({ prefs: prefs({ volume: 0.5 }) });
  const decision = decide({ name: "voice-join", actorId: OTHER, channelId: MY_VOICE }, w);
  assert.deepEqual(decision, { gain: CATALOG["voice-join"].gain * 0.5 });

  const mute = decide({ name: "self-mute" }, world({ prefs: prefs({ volume: 0.25 }) }));
  assert.deepEqual(mute, { gain: CATALOG["self-mute"].gain * 0.25 });
});

test("volume 0 ainda 'toca' — com ganho 0 (quem clampa a preferência é o prefs.ts)", () => {
  const w = world({ prefs: prefs({ volume: 0 }) });
  assert.deepEqual(decide({ name: "self-mute" }, w), { gain: 0 });
});

// O hook de push-to-talk é GLOBAL no desktop e fica instalado enquanto o modo
// estiver ligado — inclusive fora de qualquer chamada e com a janela na
// bandeja. Sem estas três regras, apertar a tecla vira bipe vindo de um app
// escondido que não transmite para ninguém (revisão M8 #1).

test("ptt em chamada, com o mic aberto, toca", () => {
  const w = world();
  assert.ok(plays({ name: "ptt-on" }, w));
  assert.ok(plays({ name: "ptt-off" }, w));
});

test("ptt FORA de qualquer chamada não toca", () => {
  const w = world({ voiceChannelId: null });
  assert.equal(plays({ name: "ptt-on" }, w), false);
  assert.equal(plays({ name: "ptt-off" }, w), false);
});

test("ptt com mute manual não toca — o track nem abre, anunciar mic aberto mentiria", () => {
  const w = world({ muted: true });
  assert.equal(plays({ name: "ptt-on" }, w), false);
  assert.equal(plays({ name: "ptt-off" }, w), false);
});

test("mute manual não afeta os outros sons de self (o próprio unmute tem de tocar)", () => {
  const w = world({ muted: true });
  assert.ok(plays({ name: "self-unmute" }, w));
  assert.ok(plays({ name: "self-deafen" }, w));
});

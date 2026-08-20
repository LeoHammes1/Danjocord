/**
 * Tetos e freios do gateway (auditoria M12, rodada 2).
 *
 * POR QUE ESTE ARQUIVO EXISTE: até aqui o gateway não tinha teste unitário
 * NENHUM — só o `pnpm smoke`, que precisa de um servidor de pé e por isso não
 * roda no CI. É o componente mais sensível do projeto (é a porta aberta na
 * internet, com estado em memória por conexão), e os três achados desta rodada
 * moravam justamente nele.
 *
 * Aqui sobe um `http.Server` de verdade com `gateway.attach()` e clientes `ws`
 * de verdade: os tetos só se manifestam no comportamento do socket, então
 * testá-los por dentro provaria menos.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { register } from "tsx/esm/api";
import { WebSocket } from "ws";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const http: Server = createServer();
gateway.attach(http);
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const PORTA = (http.address() as AddressInfo).port;

after(() => {
  gateway.close();
  http.close();
});

// --- helpers -----------------------------------------------------------------

interface Cliente {
  ws: WebSocket;
  recebidos: { op: number; t?: string; d?: unknown }[];
  esperar: (fn: (m: { op: number; t?: string }) => boolean, ms?: number) => Promise<{ op: number; t?: string; d?: unknown }>;
  fechou: Promise<{ code: number }>;
}

function abrir(): Promise<Cliente> {
  return new Promise((pronto) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORTA}/gateway`);
    const recebidos: Cliente["recebidos"] = [];
    let resolveFechou: (v: { code: number }) => void;
    const fechou = new Promise<{ code: number }>((r) => (resolveFechou = r));
    ws.on("message", (raw) => recebidos.push(JSON.parse(String(raw))));
    ws.on("close", (code) => resolveFechou({ code }));
    ws.on("error", () => undefined); // terminate() do servidor vira ECONNRESET
    const esperar: Cliente["esperar"] = (fn, ms = 3000) =>
      new Promise((res, rej) => {
        const achado = recebidos.find(fn);
        if (achado) return res(achado);
        const prazo = setTimeout(() => rej(new Error("timeout esperando frame")), ms);
        const h = (raw: unknown): void => {
          const m = JSON.parse(String(raw));
          if (fn(m)) {
            clearTimeout(prazo);
            ws.off("message", h);
            res(m);
          }
        };
        ws.on("message", h);
      });
    ws.on("open", () => pronto({ ws, recebidos, esperar, fechou }));
  });
}

/** Hello → Identify → READY. Devolve o session_id. */
async function identificar(c: Cliente, username: string): Promise<string> {
  await c.esperar((m) => m.op === 10);
  c.ws.send(JSON.stringify({ op: 2, d: { token: `dev.${username}` } }));
  const ready = (await c.esperar((m) => m.t === "READY")) as { d: { session_id: string } };
  return ready.d.session_id;
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- teto de sessões por usuário ---------------------------------------------

test("teto de 8 sessões por usuário: a 9ª derruba a MAIS ANTIGA, não a nova", async () => {
  const clientes: Cliente[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const c = await abrir();
      await identificar(c, "muitassessoes");
      clientes.push(c);
    }
    // a nona: quem cai é a primeira, e a nova entra normalmente
    const nona = await abrir();
    await identificar(nona, "muitassessoes");
    clientes.push(nona);

    const primeira = await Promise.race([clientes[0]!.fechou, dormir(3000).then(() => null)]);
    assert.ok(primeira, "a sessão mais antiga tinha de ser derrubada");
    assert.equal(nona.ws.readyState, WebSocket.OPEN, "quem acabou de logar não pode ser o punido");
  } finally {
    for (const c of clientes) c.ws.terminate();
  }
});

// --- sessão morta não é mais atendida ----------------------------------------

test("kickado que ignora o close frame para de ser atendido na hora", async () => {
  const c = await abrir();
  // um terceiro, de OUTRO usuário, para observar o efeito colateral de fora
  const vizinho = await abrir();
  await identificar(vizinho, "vizinho");
  try {
    const sessionId = await identificar(c, "kickado");
    assert.ok(sessionId);

    // o servidor derruba (kick/ban passam por aqui). O `close()` do ws é
    // gracioso e espera até 30 s pelo cliente — este teste é justamente sobre
    // o que acontece NESSA janela.
    const derrubadas = gateway.closeUserSessions(store.findOrCreateDevUser("kickado").id, "kickado");
    assert.equal(derrubadas, 1);

    // O cliente finge que não viu o close e continua mandando op 3.
    //
    // A asserção é sobre EFEITO COLATERAL, e não sobre a resposta: a primeira
    // versão deste teste esperava "nenhum op 21" e passava mesmo SEM o guard,
    // porque o `close()` já põe o socket em CLOSING e o `send` não escreve nele.
    // Ou seja, provava só que o servidor ficou calado — não que ele parou de
    // AGIR. O que importa é que os handlers não rodem: o kickado não pode mexer
    // na própria presença, entrar em voz nem nada.
    // A asserção é que o HANDLER NÃO RODA — direta, e não por efeito colateral.
    //
    // Duas versões anteriores deste teste falharam em discriminar, e vale
    // registrar porque as duas pareciam boas:
    //   1ª: "não pode chegar op 21" — passava sem o guard, porque o `close()`
    //       já põe o socket em CLOSING e o `send` não escreve nele. Provava só
    //       que o servidor ficou calado, não que parou de agir.
    //   2ª: "o vizinho não pode ver PRESENCE_UPDATE" — também passava, porque o
    //       `broadcastPresence` deriva o estado do MAPA de sessões, e a
    //       derrubada já saiu dele. O op 3 não tem efeito observável de fora.
    // O op 20 tem: ele chama `onVoiceRequest`, que é onde a voz de verdade
    // acontece. Espionar essa chamada é o que separa "calado" de "inerte".
    let chamouVoz = false;
    gateway.onVoiceRequest = async () => {
      chamouVoz = true;
      return {};
    };
    try {
      c.ws.send(JSON.stringify({ op: 20, d: { req: 99, m: "join", p: { channel_id: "2" } } }));
      await dormir(500);
      assert.equal(chamouVoz, false, "sessão derrubada não pode acionar a sinalização de voz");
    } finally {
      delete gateway.onVoiceRequest;
    }
  } finally {
    c.ws.terminate();
    vizinho.ws.terminate();
  }
});

// --- erro de socket não pode matar o processo --------------------------------

test("CRÍTICO: frame acima do maxPayload não derruba o processo", async () => {
  // Descoberto derrubando o pod de PRODUÇÃO com um curl de 300 KiB. No Node,
  // um evento 'error' sem ouvinte é `throw` — e o `onConnection` registrava
  // 'message' e 'close', nunca 'error'. Sem autenticação nenhuma: abrir o
  // socket e mandar um frame grande matava o servidor inteiro.
  //
  // O teste roda no MESMO processo dos outros, então se a regressão voltar ele
  // não "falha": ele mata o runner. É o formato certo — um crash não deve
  // conseguir se disfarçar de teste vermelho.
  const c = await abrir();
  const vivoAntes = gateway instanceof Object;
  assert.ok(vivoAntes);
  c.ws.send("x".repeat(300 * 1024));
  await dormir(400);

  // se o processo sobreviveu até aqui, o listener existe. Confirma-se que o
  // gateway segue atendendo: um cliente NOVO ainda consegue Hello + READY.
  const depois = await abrir();
  try {
    const sid = await identificar(depois, "depoisdocrash");
    assert.ok(sid, "o gateway tem de continuar atendendo depois do frame hostil");
  } finally {
    depois.ws.terminate();
    c.ws.terminate();
  }
});

// --- freio da sinalização de voz ---------------------------------------------

test("op 20 em laço leva freio em vez de virar trabalho no worker", async () => {
  const c = await abrir();
  try {
    await identificar(c, "inundador");
    // o `join` repetido é o op mais lucrativo: recria router + observer e faz
    // dois broadcasts para a guild inteira a cada volta
    for (let i = 0; i < 200; i++) {
      c.ws.send(JSON.stringify({ op: 20, d: { req: i, m: "join", p: { channel_id: "2" } } }));
    }
    const freado = await c.esperar(
      (m) => m.op === 21 && /muitas operações/.test(String((m as { d?: { error?: string } }).d?.error ?? "")),
      4000,
    );
    assert.ok(freado, "o freio tem de responder op 21 com erro, e não processar tudo");
  } finally {
    c.ws.terminate();
  }
});

// --- presença: sem eco e sem multiplicador -----------------------------------

test("op 3 repetido com o MESMO status não gera dispatch nenhum", async () => {
  // O handler era `status = ...; broadcastPresence(...)` incondicional, e o
  // broadcast percorre TODAS as sessões incrementando seq, serializando JSON e
  // empurrando no ring de cada uma. Medido pela auditoria com 121 sessões: um
  // frame de 30 bytes = 121 dispatches; 50 frames IDÊNTICOS = 6050.
  const c = await abrir();
  const vizinho = await abrir();
  try {
    await identificar(c, "presenca");
    await identificar(vizinho, "presencavizinho");
    await dormir(300);
    vizinho.recebidos.length = 0;

    // primeira mudança: deve anunciar UMA vez
    c.ws.send(JSON.stringify({ op: 3, d: { status: "idle" } }));
    await dormir(300);
    const apos1 = vizinho.recebidos.filter((m) => m.t === "PRESENCE_UPDATE").length;
    assert.equal(apos1, 1, "a mudança real tem de ser anunciada");

    // e agora 20 frames IGUAIS: nenhum evento novo
    for (let i = 0; i < 20; i++) c.ws.send(JSON.stringify({ op: 3, d: { status: "idle" } }));
    await dormir(500);
    const apos20 = vizinho.recebidos.filter((m) => m.t === "PRESENCE_UPDATE").length;
    assert.equal(apos20, 1, `status repetido gerou ${apos20 - 1} dispatches a mais`);
  } finally {
    c.ws.terminate();
    vizinho.ws.terminate();
  }
});

test("invisível no Identify não pisca verde para a guild", async () => {
  // O `IdentifyData` só levava `token`; a sessão nascia "online" e o servidor
  // anunciava isso ANTES de o op 3 poder chegar — o op 3 só existe depois do
  // READY. Quem estava invisível reaparecia verde a cada reconexão, e o
  // `syncPresence` do cliente corrigia um RTT tarde demais.
  const vizinho = await abrir();
  try {
    await identificar(vizinho, "olheiro");
    await dormir(300);
    vizinho.recebidos.length = 0;

    const invisivel = await abrir();
    await invisivel.esperar((m) => m.op === 10);
    invisivel.ws.send(JSON.stringify({ op: 2, d: { token: "dev.fantasma", status: "offline" } }));
    await invisivel.esperar((m) => m.t === "READY");
    await dormir(400);

    const vazou = vizinho.recebidos.filter(
      (m) => m.t === "PRESENCE_UPDATE" && (m.d as { status?: string })?.status === "online",
    );
    assert.equal(vazou.length, 0, "invisível não pode anunciar 'online' nem por um instante");
    invisivel.ws.terminate();
  } finally {
    vizinho.ws.terminate();
  }
});

// --- saída planejada avisa antes -----------------------------------------------

test("o servidor manda op 7 antes de sair — o deploy deixa de parecer queda de rede", async () => {
  // O op 7 existia no protocolo E no cliente desde o M2; o servidor é que nunca
  // o mandava (roadmap 120). Todo deploy chegava como uma queda qualquer, e o
  // cliente escalava o backoff até 30 s — mais que a própria janela do deploy.
  const c = await abrir();
  try {
    await identificar(c, "avisado");
    c.recebidos.length = 0;

    gateway.notifyReconnect();
    const aviso = await c.esperar((m) => m.op === 7, 2000);
    assert.ok(aviso, "a sessão tem de receber o op 7");
    // e é só isso: nada de `s`/`t`, que são de Dispatch
    assert.equal((aviso as { t?: string }).t, undefined);
  } finally {
    c.ws.terminate();
  }
});

// --- ring buffer com teto em bytes -------------------------------------------

test("ring buffer corta por BYTES, não só por contagem de entradas", async () => {
  const c = await abrir();
  try {
    await identificar(c, "ringgordo");
    // 200 eventos de ~8 KB = ~1,6 MB se nada cortar. O teto em entradas (512)
    // não seria alcançado; só o de bytes segura.
    const gordo = "x".repeat(8 * 1024);
    for (let i = 0; i < 200; i++) gateway.broadcast("TYPING_START", { channel_id: "1", user_id: gordo });

    const sessoes = (gateway as unknown as { sessions: Map<string, { ringBytes: number; ring: unknown[] }> }).sessions;
    const sessao = [...sessoes.values()].find((s) => s.ringBytes !== undefined);
    assert.ok(sessao, "sanidade: a sessão existe no mapa");
    assert.ok(
      sessao.ringBytes <= 256 * 1024,
      `ring com ${Math.round(sessao.ringBytes / 1024)} KB — o teto em bytes não segurou`,
    );
    assert.ok(sessao.ring.length < 200, "as entradas antigas tinham de ter saído");
  } finally {
    c.ws.terminate();
  }
});

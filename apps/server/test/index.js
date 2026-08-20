/**
 * Entry do diretório de testes. O script "test" é `node --test test/` e o
 * Node (24.x) executa o diretório como UM entry point via resolução de main
 * (test/index.js) — ele não expande o diretório em arquivos *.test.ts. Cada
 * suíte nova precisa ser importada aqui, com a extensão .ts explícita (o
 * type stripping não remapeia ".js" → ".ts").
 */
// oauth primeiro DE PROPÓSITO: o config congela process.env no primeiro
// import de src, e esta suíte precisa de DISCORD_CLIENT_ID definido antes
// disso (ela não mexe em relógio e usa banco :memory: próprio — inofensiva
// para as demais)
import "./oauth-loopback.test.ts";
import "./sessions.test.ts";
// depois de sessions de propósito: os testes de lá com relógio mockado deixam
// o gerador de snowflakes "no futuro", e esta suíte usa banco novo — sem risco
import "./messages.test.ts";
// M11a: estado de leitura, menções e mensagens de sistema. Banco :memory:
// próprio, canais próprios (a contagem é por canal) e nenhum relógio mockado
import "./read-state.test.ts";
// M9: o provador de duração é puro (nem banco nem Fastify), então entra em
// qualquer ordem; as rotas do soundboard usam banco :memory: próprio
import "./sound-probe.test.ts";
import "./sounds.test.ts";
// M10: convites, cargos, kick/ban e timeout. Banco :memory: próprio e nenhum
// relógio mockado — mas o bootstrap mexe no config.ownerDiscordId (e o
// restaura), então ele fica longe das suítes que dependem de env no import
import "./moderation.test.ts";
// M11b: o resto do chat. A SSRF vem na frente das outras do marco de
// propósito — é a suíte que protege a única coisa daqui que, feita errado, é
// furo de segurança de verdade. Todas usam banco :memory: próprio, nenhuma
// mexe em relógio nem em config, e as de link sobem servidores HTTP em
// 127.0.0.1 (fechados no teardown de cada suíte).
import "./ssrf.test.ts";
import "./link-preview.test.ts";
import "./attachment-probe.test.ts";
import "./attachments.test.ts";
import "./reactions.test.ts";
import "./reply.test.ts";
import "./search.test.ts";
// cliente estático: não mexe em relógio, env nem banco — o diretório do build
// falso mora no tmp, então pode entrar em qualquer ponto. Está aqui porque foi
// escrito como rede para a troca do @fastify/static (8.x → 10.x).
import "./static-client.test.ts";
// voz por último: sobe um worker REAL do mediasoup (porta RTC própria via
// env no topo do arquivo, para não colidir com um servidor de dev na 40000)
// e o fecha no teardown da suíte
import "./voice.test.ts";

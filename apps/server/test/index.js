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
// M9: o provador de duração é puro (nem banco nem Fastify), então entra em
// qualquer ordem; as rotas do soundboard usam banco :memory: próprio
import "./sound-probe.test.ts";
import "./sounds.test.ts";
// M10: convites, cargos, kick/ban e timeout. Banco :memory: próprio e nenhum
// relógio mockado — mas o bootstrap mexe no config.ownerDiscordId (e o
// restaura), então ele fica longe das suítes que dependem de env no import
import "./moderation.test.ts";
// voz por último: sobe um worker REAL do mediasoup (porta RTC própria via
// env no topo do arquivo, para não colidir com um servidor de dev na 40000)
// e o fecha no teardown da suíte
import "./voice.test.ts";

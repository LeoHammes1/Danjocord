#!/usr/bin/env node
/**
 * Certificado auto-assinado para TESTE EM REDE LOCAL (não é para produção).
 *
 * Por que ele existe: `getUserMedia` — microfone, câmera e Go Live — só roda em
 * CONTEXTO SEGURO, e `http://192.168.x.x` não é um. Sem HTTPS, abrir o
 * Danjocord no notebook dá chat funcionando e voz simplesmente AUSENTE:
 * `navigator.mediaDevices` vem `undefined` e nem erro aparece na tela.
 *
 * O IP entra no SAN (Subject Alternative Name), e não no CN: navegador moderno
 * ignora CN há anos. Sem `IP:<ip>` no SAN, o Chrome recusa a conexão mesmo
 * depois de a pessoa aceitar o aviso.
 *
 * Uso:  node scripts/lan-cert.mjs [ip]
 * Sem argumento, ele detecta o IP de LAN mais provável e mostra as alternativas.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const OUT = join(process.cwd(), "certs");

/** IPv4 externos, com um palpite de qual é a LAN de verdade. */
function candidatos() {
  const achados = [];
  for (const [nome, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // adaptadores de VM e VPN atrapalham mais do que ajudam: o notebook não
      // alcança nenhum deles, e escolher um por engano dá "voz que não conecta"
      const virtual = /vmware|virtualbox|vethernet|hyper-v|nordlynx|tailscale|zerotier|wsl|docker/i.test(nome);
      achados.push({ nome, ip: a.address, virtual });
    }
  }
  return achados;
}

function melhorPalpite(lista) {
  const reais = lista.filter((c) => !c.virtual);
  // 192.168/16 é a faixa doméstica típica; depois 10/8; depois qualquer uma
  return (
    reais.find((c) => c.ip.startsWith("192.168.")) ?? reais.find((c) => c.ip.startsWith("10.")) ?? reais[0] ?? lista[0]
  );
}

const lista = candidatos();
const escolhido = process.argv[2] ?? melhorPalpite(lista)?.ip;

if (!escolhido) {
  console.error("Nenhum IPv4 de rede encontrado. Passe o IP à mão: node scripts/lan-cert.mjs 192.168.0.10");
  process.exit(1);
}

console.log("Interfaces encontradas:");
for (const c of lista) {
  const marca = c.ip === escolhido ? " <- usando" : c.virtual ? " (virtual, ignorada no palpite)" : "";
  console.log(`  ${c.nome.padEnd(30)} ${c.ip}${marca}`);
}
if (process.argv[2] === undefined) {
  console.log("\nSe o notebook não alcançar este IP, rode de novo passando o certo:");
  console.log("  node scripts/lan-cert.mjs <ip>\n");
}

mkdirSync(OUT, { recursive: true });
const certPath = join(OUT, "danjocord.crt");
const keyPath = join(OUT, "danjocord.key");

// localhost e 127.0.0.1 entram junto para o MESMO certificado servir o teste na
// própria máquina, sem precisar de um segundo par de arquivos
const san = `subjectAltName=IP:${escolhido},IP:127.0.0.1,DNS:localhost`;

try {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "365",
      "-subj", "/CN=danjocord-lan",
      "-addext", san,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} catch (err) {
  console.error("openssl falhou. Ele vem com o Git para Windows (Git Bash) — confira se está no PATH.");
  console.error(String(err.stderr ?? err));
  process.exit(1);
}

if (!existsSync(certPath) || !existsSync(keyPath)) {
  console.error("openssl terminou mas os arquivos não apareceram em ./certs");
  process.exit(1);
}

// o compose lê o IP daqui: assim `docker compose` e o certificado nunca
// discordam sobre qual endereço o mediasoup deve anunciar
writeFileSync(join(process.cwd(), ".env.lan"), `LAN_IP=${escolhido}\n`, "utf8");

console.log(`Certificado gerado para ${escolhido} (válido por 365 dias):`);
console.log(`  ${certPath}`);
console.log(`  ${keyPath}`);
console.log(`  .env.lan  ->  LAN_IP=${escolhido}`);
console.log(`\nAgora:  docker compose -f docker-compose.lan.yml --env-file .env.lan up --build`);
console.log(`Depois: https://${escolhido}:8443  (o aviso de certificado é esperado — "Avançado" e prosseguir)`);

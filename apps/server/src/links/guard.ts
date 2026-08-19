/**
 * Política de SSRF do preview de link (M11b, item 90) — módulo PURO: string
 * entrando, motivo de recusa (ou null) saindo. Nenhum socket, nenhum DNS,
 * nenhum Fastify. É assim porque esta é a parte do M11b que, feita errado, é
 * furo de segurança de verdade — e o único jeito de ter certeza de que cada
 * faixa está fechada é poder testar cada faixa sem subir nada.
 *
 * O PERIGO, escrito por extenso: o preview faz o SERVIDOR buscar uma URL que um
 * usuário colou. O servidor está dentro do cluster; o usuário, não. Sem esta
 * política, colar `http://169.254.169.254/latest/meta-data/` no chat faz o
 * servidor buscar as credenciais do provedor de nuvem e devolvê-las como
 * "descrição do link". O mesmo vale para `http://10.0.0.5:6379` (Redis do
 * cluster), `http://127.0.0.1:8080/api/...` (o próprio Danjocord, autenticado
 * como ninguém mas alcançável) e `file:///etc/passwd`.
 *
 * As quatro regras, e por que cada uma existe:
 *
 *   1. SÓ http e https. `file:`, `gopher:`, `ftp:`, `data:` — cada um é um
 *      jeito diferente de ler o disco ou falar com um serviço de texto.
 *   2. SÓ as portas padrão (80/443). Um link legítimo de preview mora na web;
 *      `http://host-publico:6379/` é tentativa de falar protocolo com outra
 *      coisa através de um cliente HTTP.
 *   3. O ENDEREÇO RESOLVIDO é checado, não o nome. `localtest.me` resolve para
 *      127.0.0.1, e nenhuma lista de nomes proibidos cobre isso.
 *   4. A checagem se repete a CADA salto do redirect. O ataque clássico é um
 *      host público que responde 302 para `http://169.254.169.254/` — quem
 *      valida só a primeira URL entrega o metadata de bandeja.
 */

import { isIP } from "node:net";

/** Os únicos esquemas que o preview aceita. */
export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * As únicas portas. Não é paranoia gratuita: o preview existe para páginas
 * web, e web mora em 80/443. Deixar porta livre transformaria o servidor num
 * scanner de portas por procuração — cole `http://alvo:22`, veja pela mensagem
 * de erro se abriu.
 */
const ALLOWED_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Valida e NORMALIZA uma URL colada. Normalizar importa porque a URL vira
 * chave do cache: `HTTP://Exemplo.COM/a#topo` e `http://exemplo.com/a` são a
 * mesma página, e sem normalizar seriam duas buscas e duas linhas.
 *
 * Lança Error com frase curta em pt-BR (vira o `error` da resposta e do cache
 * negativo). Nunca devolve uma URL que não passou pelas regras 1 e 2.
 */
export interface NormalizeOptions {
  /**
   * SÓ TESTE. Todo servidor HTTP de teste sobe numa porta alta e aleatória, e
   * a regra 2 (com razão) recusa isso — sem esta abertura, os testes de
   * redirect, prazo, teto de bytes e content-type não teriam como existir. A
   * produção (`links/routes.ts`) nunca passa opções.
   */
  allowAnyPort?: boolean;
}

export function normalizeUrl(raw: string, options: NormalizeOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL inválida");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    // a mensagem diz o esquema porque `file:` e `javascript:` costumam vir de
    // engano honesto (alguém colou um caminho local), e não só de ataque
    throw new Error(`esquema "${url.protocol.replace(":", "")}" não é suportado — só http e https`);
  }
  // `url.port` é "" quando é a padrão do esquema (o WHATWG URL já a remove)
  if (options.allowAnyPort !== true && url.port !== "" && url.port !== ALLOWED_PORTS[url.protocol]) {
    throw new Error("porta não padrão — o preview só busca em 80 e 443");
  }
  if (url.username !== "" || url.password !== "") {
    // `http://usuario:senha@host/` é a forma clássica de disfarçar o host real
    // ("http://google.com@10.0.0.1/") e ainda mandaria credencial adiante
    throw new Error("URL com usuário e senha não é suportada");
  }
  if (url.hostname === "") throw new Error("URL sem host");

  // fragmento fora: ele nunca chega ao servidor de destino, então duas URLs
  // que só diferem nele são a MESMA busca
  url.hash = "";
  // o WHATWG URL já minusculiza esquema e host; explicitar não custa e deixa a
  // intenção de "isto é a chave do cache" no código
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  return url;
}

/**
 * O endereço IP resolvido pode ser buscado?
 *
 * Devolve null (liberado) ou uma frase curta com o MOTIVO — a frase entra no
 * cache negativo e é o que explica, seis meses depois, por que aquele link
 * nunca gerou preview.
 *
 * Aceita as duas famílias, inclusive as formas em que um IPv6 CARREGA um IPv4
 * dentro (mapeado, 6to4, NAT64): sem desembrulhar, `::ffff:127.0.0.1` passaria
 * por "um IPv6 qualquer" e chegaria ao loopback.
 */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return blockedIpv4Reason(address);
  if (family === 6) return blockedIpv6Reason(address);
  return "endereço não é um IP válido";
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // `Number("0x7f")` e `Number(" 1")` aceitariam formas que o resto do mundo
    // interpreta diferente — só dígito decimal entra
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Faixas IPv4 fechadas. A ordem é a da RFC 6890 mais o que dói na prática;
 * cada linha existe por um motivo concreto, não por completude.
 */
function blockedIpv4Reason(address: string): string | null {
  const octets = ipv4Octets(address);
  if (octets === null) return "endereço IPv4 malformado";
  const [a = 0, b = 0] = octets;

  if (a === 0) return "faixa 0.0.0.0/8 (este host)";
  if (a === 10) return "rede privada 10.0.0.0/8";
  if (a === 127) return "loopback 127.0.0.0/8";
  // 169.254.169.254 é o metadata de AWS, GCP, Azure, DigitalOcean e Hetzner —
  // é O alvo de SSRF, e por isso a faixa inteira sai
  if (a === 169 && b === 254) return "link-local 169.254.0.0/16 (metadata de nuvem)";
  if (a === 172 && b >= 16 && b <= 31) return "rede privada 172.16.0.0/12";
  if (a === 192 && b === 168) return "rede privada 192.168.0.0/16";
  // CGNAT: é onde mora o roteador do provedor de muita gente, e do pod ele
  // pode ser alcançável
  if (a === 100 && b >= 64 && b <= 127) return "faixa CGNAT 100.64.0.0/10";
  if (a === 192 && b === 0 && octets[2] === 0) return "faixa reservada 192.0.0.0/24";
  if (a === 198 && (b === 18 || b === 19)) return "faixa de benchmark 198.18.0.0/15";
  if (a === 192 && b === 0 && octets[2] === 2) return "faixa de documentação 192.0.2.0/24";
  if (a === 198 && b === 51 && octets[2] === 100) return "faixa de documentação 198.51.100.0/24";
  if (a === 203 && b === 0 && octets[2] === 113) return "faixa de documentação 203.0.113.0/24";
  if (a >= 224 && a <= 239) return "multicast 224.0.0.0/4";
  // 240/4 engloba o broadcast 255.255.255.255
  if (a >= 240) return "faixa reservada 240.0.0.0/4";
  return null;
}

/**
 * Expande um IPv6 (com `::`, com IPv4 no fim, com zone id) para 16 bytes.
 * null = não é um IPv6 que a gente saiba ler — e o que não se sabe ler não se
 * libera.
 */
function ipv6Bytes(address: string): number[] | null {
  // zone id (`fe80::1%eth0`) não muda o endereço, mas atrapalha o parser
  const bare = address.split("%")[0] ?? address;

  // forma com IPv4 no fim (`::ffff:127.0.0.1`): converte a cauda em dois grupos
  let text = bare;
  const lastColon = bare.lastIndexOf(":");
  const tail = bare.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = ipv4Octets(tail);
    if (octets === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text =
      bare.slice(0, lastColon + 1) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function embeddedIpv4(bytes: number[], offset: number): string {
  return `${bytes[offset] ?? 0}.${bytes[offset + 1] ?? 0}.${bytes[offset + 2] ?? 0}.${bytes[offset + 3] ?? 0}`;
}

function blockedIpv6Reason(address: string): string | null {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return "endereço IPv6 malformado";

  const allZeroUpTo = (n: number): boolean => bytes.slice(0, n).every((byte) => byte === 0);

  // ::/128 (não especificado) e ::1/128 (loopback)
  if (allZeroUpTo(15)) {
    if (bytes[15] === 0) return "endereço :: (não especificado)";
    if (bytes[15] === 1) return "loopback ::1";
  }
  // ::ffff:0:0/96 — IPv4 vestido de IPv6. Sem desembrulhar, o loopback entra
  // pela porta dos fundos.
  if (allZeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const inner = embeddedIpv4(bytes, 12);
    return blockedIpv4Reason(inner) ?? null;
  }
  // 64:ff9b::/96 (NAT64) — o mesmo truque, por outro prefixo: 64:ff9b nos
  // quatro primeiros bytes, zeros até o 12, e o IPv4 no fim
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    const inner = embeddedIpv4(bytes, 12);
    const reason = blockedIpv4Reason(inner);
    if (reason !== null) return `NAT64 para ${inner}: ${reason}`;
  }
  // 2002::/16 (6to4) — carrega o IPv4 nos bytes 2..5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const inner = embeddedIpv4(bytes, 2);
    const reason = blockedIpv4Reason(inner);
    if (reason !== null) return `6to4 para ${inner}: ${reason}`;
  }
  // fc00::/7 — únicas locais (o "192.168" do IPv6)
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return "rede privada fc00::/7";
  // fe80::/10 — link-local
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return "link-local fe80::/10";
  // ff00::/8 — multicast
  if ((bytes[0] ?? 0) === 0xff) return "multicast ff00::/8";
  // 100::/64 — descarte (RFC 6666)
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((byte) => byte === 0)) {
    return "faixa de descarte 100::/64";
  }
  // 2001:db8::/32 — documentação
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return "faixa de documentação 2001:db8::/32";
  }
  return null;
}

/**
 * O catálogo de releases do app desktop, lido da API do GitHub (M14).
 *
 * ---------------------------------------------------------------------------
 * POR QUE O POD NÃO GUARDA O INSTALADOR
 * ---------------------------------------------------------------------------
 *
 * O instalador tem ~100 MB e sai do `desktop-release.yml` num runner Windows —
 * ele já nasce num Release do GitHub. Havia três lugares para pôr esses bytes,
 * e o que decide não é gosto:
 *
 *   1. **No PVC**, com o CI subindo por uma rota de upload. Funciona, mas cria
 *      uma segunda credencial (o CI escrevendo no servidor), uma política de
 *      retenção e crescimento num PVC de 2 GiB.
 *   2. **Proxy**: o pod busca no GitHub e repassa os bytes. Também funciona, e é
 *      o que este arquivo QUASE faz.
 *   3. **Redirect** — o que ele faz.
 *
 * O que elimina (1) e (2) é o nó: o pod está pinado no `hostinger` porque é de
 * lá que sai a MÍDIA (mediasoup, hostPort 40000/UDP), e o pior caso documentado
 * de um Go Live 4K com os nove amigos assistindo já é ~108 Mbps de uplink desse
 * mesmo nó (ver `rtcMaxIncomingBitrate` no config.ts). Um release novo põe até
 * dez `electron-updater` baixando ~100 MB ao mesmo tempo — 1 GB saindo pela
 * mesma placa que carrega a voz. Servir o instalador do pod é competir com a
 * chamada, e a chamada é o produto.
 *
 * Então o pod é PORTEIRO, não servidor de arquivo: valida quem pediu e devolve
 * um 302 para a URL pré-assinada que a própria API do GitHub emite (~5 min de
 * validade, sem credencial nossa dentro). Zero byte de instalador atravessa o
 * nó da mídia.
 *
 * ---------------------------------------------------------------------------
 * O QUE É CACHE E O QUE NÃO PODE SER
 * ---------------------------------------------------------------------------
 *
 * A LISTA de releases é cacheada (5 min): ela muda quando o Leonardo publica um
 * release, e uma checagem de update por cliente por hora não pode virar uma ida
 * ao GitHub cada. A URL PRÉ-ASSINADA nunca é cacheada — ela expira, e servir uma
 * vencida daria um 403 do S3 no meio do download, que o electron-updater relata
 * como "falha de rede" e ninguém liga ao cache daqui.
 */
import { config } from "../config.js";

/** Um arquivo publicado no release (o `latest.yml`, o `.exe`, o `.blockmap`). */
export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

/** Um release publicado — draft e prerelease já foram filtrados. */
export interface Release {
  /** a tag sem o `v` (é o que o electron-updater compara) */
  version: string;
  tag: string;
  publishedAt: number;
  assets: ReleaseAsset[];
}

export interface Catalogo {
  /** o mais recente publicado, ou null se não há nenhum */
  latest: Release | null;
  /**
   * TODOS os assets das últimas páginas, por nome. É mais amplo que o `latest`
   * de propósito: o download DIFERENCIAL do electron-updater pede o `.blockmap`
   * da versão ANTIGA, que mora no release anterior. Sem ele, cada atualização
   * baixa o instalador inteiro em vez do delta — a diferença entre ~100 MB e
   * alguns megabytes na conexão de casa de cada amigo.
   */
  porNome: Map<string, ReleaseAsset>;
}

const API_BASE = "https://api.github.com";
/** quantos releases entram no mapa de assets (cobre o blockmap das anteriores) */
const PAGINA = 10;
const TIMEOUT_MS = 8_000;
const CACHE_OK_MS = 5 * 60_000;
/**
 * Curto de propósito. A falha aqui costuma ser "o release ainda não foi
 * publicado" ou "o token venceu" — os dois se resolvem em minutos, e um cache
 * negativo longo faria a correção parecer não ter funcionado.
 */
const CACHE_ERRO_MS = 30_000;

export class GithubReleasesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubReleasesError";
  }
}

/**
 * Hosts para os quais aceitamos redirecionar. NÃO é defesa de SSRF — nós nunca
 * buscamos esta URL, só a repassamos ao cliente. É defesa de REDIRECT ABERTO:
 * sem a checagem, um `Location` inesperado (API comprometida, proxy corporativo
 * no meio, mudança de infra do GitHub) faria `danjocord.leohammes.dev` mandar o
 * navegador de um amigo para qualquer lugar, com a nossa origem como referência.
 */
function entregaConfiavel(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "github.com" || host === "githubusercontent.com" || host.endsWith(".githubusercontent.com");
}

function cabecalhos(accept: string): Record<string, string> {
  const h: Record<string, string> = {
    accept,
    "x-github-api-version": "2022-11-28",
    // a API do GitHub recusa requisição sem User-Agent com 403 e uma mensagem
    // que não menciona o header — vale gastar a linha
    "user-agent": "danjocord-server",
  };
  // O token é OPCIONAL. Num repo público a API responde sem ele (60/h por IP, e
  // o cache abaixo mantém a gente muito abaixo disso); num repo PRIVADO — que é
  // o caso hoje, e é o que sustenta a advertência do ATTRIBUTIONS.md — sem
  // token a resposta é 404, não 401. Por isso o erro de 404 lá embaixo cita as
  // duas causas: não existe, ou não temos permissão para ver.
  if (config.releaseToken !== "") h["authorization"] = `Bearer ${config.releaseToken}`;
  return h;
}

/** Só o que usamos da resposta da API — o resto do JSON é ignorado. */
interface ReleaseCru {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function normalizar(cru: ReleaseCru): Release | null {
  if (typeof cru.tag_name !== "string" || cru.tag_name === "") return null;
  if (cru.draft === true || cru.prerelease === true) return null;
  const assets: ReleaseAsset[] = [];
  for (const item of Array.isArray(cru.assets) ? cru.assets : []) {
    const a = item as { id?: unknown; name?: unknown; size?: unknown };
    if (typeof a.id !== "number" || typeof a.name !== "string" || typeof a.size !== "number") continue;
    assets.push({ id: a.id, name: a.name, size: a.size });
  }
  const publicado = typeof cru.published_at === "string" ? Date.parse(cru.published_at) : NaN;
  return {
    tag: cru.tag_name,
    // o electron-updater compara SEMVER, e a tag do projeto é `v1.2.3`
    version: cru.tag_name.replace(/^v/, ""),
    publishedAt: Number.isNaN(publicado) ? 0 : publicado,
    assets,
  };
}

/** Injetável para o teste; produção usa o `fetch` global do Node. */
export type Buscador = typeof fetch;

interface Cache {
  valor: Catalogo | null;
  erro: GithubReleasesError | null;
  ate: number;
}

let cache: Cache = { valor: null, erro: null, ate: 0 };

/** Só para o teste: derruba o cache entre casos. */
export function limparCacheDeReleases(): void {
  cache = { valor: null, erro: null, ate: 0 };
}

async function buscarCatalogo(fetchImpl: Buscador): Promise<Catalogo> {
  const url = `${API_BASE}/repos/${config.releaseRepo}/releases?per_page=${PAGINA}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: cabecalhos("application/vnd.github+json"),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GithubReleasesError(503, `não deu para falar com o GitHub (${String(err)})`);
  }
  if (res.status === 404) {
    throw new GithubReleasesError(
      503,
      `o repositório de releases "${config.releaseRepo}" não existe ou o servidor não tem permissão para vê-lo ` +
        "(repo privado sem GITHUB_RELEASES_TOKEN responde 404, e não 401)",
    );
  }
  if (!res.ok) {
    throw new GithubReleasesError(503, `a API do GitHub respondeu ${res.status} ao listar os releases`);
  }
  let corpo: unknown;
  try {
    corpo = await res.json();
  } catch {
    throw new GithubReleasesError(503, "a API do GitHub devolveu algo que não é JSON");
  }
  if (!Array.isArray(corpo)) throw new GithubReleasesError(503, "a API do GitHub devolveu algo que não é uma lista");

  const releases = corpo.map((r) => normalizar(r as ReleaseCru)).filter((r): r is Release => r !== null);
  // A API devolve por data de criação decrescente, mas a ordem não é contrato —
  // ordenar por data de publicação torna "o mais recente" uma propriedade dos
  // dados, e não da resposta.
  releases.sort((a, b) => b.publishedAt - a.publishedAt);

  const porNome = new Map<string, ReleaseAsset>();
  // do mais NOVO para o mais velho, e sem sobrescrever: dois releases podem ter
  // um asset de mesmo nome (um re-upload), e o do release novo é o que vale
  for (const release of releases) {
    for (const asset of release.assets) if (!porNome.has(asset.name)) porNome.set(asset.name, asset);
  }
  return { latest: releases[0] ?? null, porNome };
}

/**
 * O catálogo, com cache. Erro também é cacheado (por menos tempo): sem isso,
 * um repo mal configurado faria cada cliente do canal bater no GitHub a cada
 * checagem, e o 503 chegaria depois de 8 s de timeout toda vez.
 */
export async function catalogoDeReleases(fetchImpl: Buscador = fetch, agora: number = Date.now()): Promise<Catalogo> {
  if (agora < cache.ate) {
    if (cache.erro !== null) throw cache.erro;
    if (cache.valor !== null) return cache.valor;
  }
  try {
    const valor = await buscarCatalogo(fetchImpl);
    cache = { valor, erro: null, ate: agora + CACHE_OK_MS };
    return valor;
  } catch (err) {
    const erro =
      err instanceof GithubReleasesError ? err : new GithubReleasesError(503, `falha ao ler os releases: ${String(err)}`);
    cache = { valor: null, erro, ate: agora + CACHE_ERRO_MS };
    throw erro;
  }
}

/**
 * A URL pré-assinada de UM asset. A API responde 302 com um `Location` para o
 * CDN do GitHub, válido por poucos minutos e sem credencial nossa dentro — é
 * exatamente esse valor que devolvemos ao cliente.
 *
 * `redirect: "manual"` é o ponto do exercício: seguir o redirect aqui faria o
 * POD baixar os 100 MB, que é o que este módulo inteiro existe para não fazer.
 */
export async function urlDeDownload(assetId: number, fetchImpl: Buscador = fetch): Promise<string> {
  const url = `${API_BASE}/repos/${config.releaseRepo}/releases/assets/${assetId}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: cabecalhos("application/octet-stream"),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GithubReleasesError(503, `não deu para falar com o GitHub (${String(err)})`);
  }
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || location === null) {
    throw new GithubReleasesError(503, `o GitHub não redirecionou o asset ${assetId} (status ${res.status})`);
  }
  let alvo: URL;
  try {
    alvo = new URL(location);
  } catch {
    throw new GithubReleasesError(503, "o GitHub devolveu um Location que não é URL");
  }
  if (!entregaConfiavel(alvo)) {
    throw new GithubReleasesError(503, `o GitHub redirecionou para um host inesperado (${alvo.hostname})`);
  }
  return alvo.toString();
}

/** O instalador do Windows dentro de um release — o único `.exe` publicado. */
export function instalador(release: Release): ReleaseAsset | null {
  return release.assets.find((a) => a.name.toLowerCase().endsWith(".exe")) ?? null;
}

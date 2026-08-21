import { createWriteStream } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DesktopRelease } from "@danjocord/protocol";

/**
 * Onde o instalador do app desktop mora (M14): um diretório no PVC.
 *
 * ---------------------------------------------------------------------------
 * POR QUE AQUI, E NÃO NUM RELEASE DO GITHUB
 * ---------------------------------------------------------------------------
 *
 * Decisão do Leonardo: o binário não fica hospedado no GitHub. O CI continua
 * compilando (NSIS e os módulos nativos precisam de Windows), mas em vez de
 * publicar um Release ele faz POST dos artefatos aqui.
 *
 * Isso tem um custo, e ele é declarado em vez de escondido: **o pod passa a
 * servir os bytes**. Este é o mesmo nó que carrega a mídia (mediasoup, hostPort
 * 40000/UDP), e um release novo significa ~100 MB por amigo saindo pela mesma
 * placa — ~1 GB se os dez atualizarem. Na prática isso se espalha por horas (a
 * checagem é no login e a cada 6 h, nunca simultânea), e para dez amigos é
 * aceitável. Se um dia doer, o remédio é cobrar por MB no `onResponse` ou um
 * teto de downloads simultâneos; nenhum dos dois foi feito.
 *
 * ---------------------------------------------------------------------------
 * O LAYOUT É PLANO, E ISSO É EXIGÊNCIA DO ELECTRON-UPDATER
 * ---------------------------------------------------------------------------
 *
 *     <releasesDir>/
 *       latest.yml                      ← do electron-builder, servido tal e qual
 *       Danjocord-Setup-0.1.0.exe
 *       Danjocord-Setup-0.1.0.exe.blockmap
 *       release.json                    ← NOSSO, e não do electron-builder
 *
 * Nada de subpasta por versão: o electron-updater resolve cada arquivo com
 * `new URL(nome, base)` a partir da URL do feed, então `latest.yml` e o `.exe`
 * TÊM que estar no mesmo nível.
 *
 * O `release.json` existe para o servidor não precisar entender YAML (o projeto
 * não instala dependência, e um parser de YAML escrito à mão para ler metadado
 * é exatamente o tipo de coisa que quebra calada). Ele é escrito pelo COMMIT do
 * publish, depois de os artefatos já estarem no lugar — é ele que decide qual
 * release é "a atual", e é por isso que um upload pela metade nunca vira a
 * versão que os amigos baixam.
 */

/** Quantos instaladores ficam no disco. Ver `podar`. */
export const MANTER_RELEASES = 2;

/**
 * Teto por artefato. Um instalador de Electron fica na casa dos 100 MB; 500 MB
 * é folga de 5× e ainda impede que um POST errado encha o PVC — onde também
 * mora o SQLite.
 */
export const MAX_ARTEFATO_BYTES = 500 * 1024 * 1024;

/**
 * O content-type do upload de release. **Distinto de propósito**: o
 * `application/octet-stream` do `raw-body.ts` é bufferizado com chão de 64 KB, e
 * aceitar 500 MB por ali poria o instalador inteiro na memória de um pod com
 * limite de 1 GiB (o `Buffer.concat` chega a dobrar o pico). Um tipo próprio
 * deixa o caminho "arquivo grande, em fluxo, direto para o disco" visivelmente
 * separado do caminho "arquivo pequeno, na memória".
 */
export const TIPO_RELEASE = "application/vnd.danjocord.release";

/** O manifesto do electron-updater. É por ele que o updater começa. */
export const ARQUIVO_FEED = "latest.yml";
/**
 * Onde o manifesto ESPERA até o commit.
 *
 * Isto existe porque a afirmação "o commit é que publica" era falsa para o
 * cliente que mais importa. O feed serve `latest.yml` direto do disco, então no
 * instante em que o upload dele terminava os apps instalados já enxergavam a
 * versão nova — antes do commit, e mesmo que o job morresse em seguida. O
 * commit governava só a página de download.
 *
 * Com o estágio, o upload do manifesto não muda nada para ninguém: quem vira a
 * chave é o `rename` de UM arquivo dentro do commit, atômico, para os DOIS
 * clientes. E o nome escolhido é deliberadamente inválido para
 * `nomeDeArtefatoValido` (a extensão não está na lista), então o feed não
 * consegue servi-lo nem por engano.
 */
const ARQUIVO_FEED_PENDENTE = "latest.yml.pendente";
/** Nosso metadado — nunca é servido pelo feed. */
const ARQUIVO_RELEASE = "release.json";

/** O nome sob o qual um artefato é GRAVADO (o manifesto fica em estágio). */
export function nomeDeGravacao(nome: string): string {
  return nome === ARQUIVO_FEED ? ARQUIVO_FEED_PENDENTE : nome;
}

/**
 * Nome de artefato aceito. Pura, e é ela que faz as vezes de allowlist: só
 * entram (e só saem) arquivos que casam isto.
 *
 * Sem barra, sem `..`, sem começar com ponto — mas a defesa de verdade não é a
 * regex e sim o fato de o caminho ser SEMPRE `join(releasesDir, nome)` com
 * `nome` já validado, e nunca uma concatenação vinda do pedido.
 */
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXTENSOES = [".exe", ".exe.blockmap", ".yml"];

export function nomeDeArtefatoValido(nome: string): boolean {
  if (!NOME.test(nome) || nome.includes("..")) return false;
  if (nome === ARQUIVO_RELEASE) return false; // metadado nosso não é artefato
  return EXTENSOES.some((ext) => nome.toLowerCase().endsWith(ext));
}

/** Semver simples, do jeito que a tag do projeto produz (`v1.2.3` → `1.2.3`). */
const VERSAO = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;

export function versaoValida(versao: string): boolean {
  return VERSAO.test(versao);
}

/**
 * Grava um artefato em FLUXO, com teto.
 *
 * Escreve num temporário e só então renomeia: `rename` no mesmo sistema de
 * arquivos é atômico, então um upload interrompido nunca aparece como um
 * arquivo pela metade que o updater possa baixar. É a mesma razão de o commit
 * ser um passo separado.
 *
 * O teto é conferido AQUI, contando bytes, porque o `bodyLimit` do Fastify não
 * alcança um parser de fluxo — ele só sabe cortar o que ele mesmo bufferiza.
 */
export async function gravarArtefato(dir: string, nome: string, corpo: Readable): Promise<number> {
  const destino = join(dir, nome);
  const temporario = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  let bytes = 0;
  try {
    await pipeline(
      async function* () {
        for await (const pedaco of corpo) {
          bytes += (pedaco as Buffer).length;
          if (bytes > MAX_ARTEFATO_BYTES) {
            throw new Error(`artefato passou de ${MAX_ARTEFATO_BYTES} bytes`);
          }
          yield pedaco as Buffer;
        }
      },
      createWriteStream(temporario),
    );
  } catch (err) {
    await rm(temporario, { force: true });
    throw err;
  }
  await rename(temporario, destino);
  return bytes;
}

/** O release atual, ou null se ainda não há nenhum (ou o metadado não bate). */
export async function lerRelease(dir: string): Promise<DesktopRelease | null> {
  let cru: unknown;
  try {
    cru = JSON.parse(await readFile(join(dir, ARQUIVO_RELEASE), "utf8"));
  } catch {
    // ausente (deploy limpo) ou ilegível — os dois são "não há release"
    return null;
  }
  const parsed = DesktopRelease.safeParse(cru);
  if (!parsed.success) return null;
  // O metadado não manda sozinho: o arquivo tem que existir DE FATO. Sem esta
  // conferência, uma poda mal feita (ou um `rm` manual) deixaria a página de
  // download oferecendo um botão que dá 404.
  try {
    const info = await stat(join(dir, parsed.data.file));
    if (!info.isFile()) return null;
    // devolve o tamanho REAL, não o declarado no commit
    return { ...parsed.data, size: info.size };
  } catch {
    return null;
  }
}

/** O manifesto desta publicação já chegou e está esperando o commit? */
export async function manifestoPendente(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).includes(ARQUIVO_FEED_PENDENTE);
  } catch {
    return false;
  }
}

/**
 * Vira a chave: o manifesto em estágio passa a ser o `latest.yml` que o feed
 * serve. Um `rename` no mesmo sistema de arquivos é atômico — não existe
 * instante em que o feed devolva meio arquivo.
 */
export async function promoverManifesto(dir: string): Promise<void> {
  await rename(join(dir, ARQUIVO_FEED_PENDENTE), join(dir, ARQUIVO_FEED));
}

/**
 * Faxina dos temporários, no boot.
 *
 * O `gravarArtefato` só apaga o `.tmp-` quando o erro chega ao processo. Se o
 * pod morre no meio de um upload (rollout do deploy, OOM, drain do nó), sobra
 * um arquivo de até 500 MB no MESMO PVC onde mora o SQLite, e nada nunca o
 * recolhe. No boot não há upload em voo por definição, então é a hora segura.
 */
export async function limparTemporarios(dir: string): Promise<string[]> {
  const limpos: string[] = [];
  try {
    for (const nome of await readdir(dir)) {
      if (!nome.startsWith(".tmp-")) continue;
      await rm(join(dir, nome), { force: true });
      limpos.push(nome);
    }
  } catch {
    // diretório recém-criado ou ilegível: não há o que limpar
  }
  return limpos;
}

export async function gravarRelease(dir: string, info: DesktopRelease): Promise<void> {
  const temporario = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  await writeFile(temporario, JSON.stringify(info, null, 2) + "\n", "utf8");
  await rename(temporario, join(dir, ARQUIVO_RELEASE));
}

/**
 * Existe e é arquivo?
 *
 * O `readdir` com comparação EXATA em vez de só um `stat` não é preciosismo:
 * o NTFS é insensível a maiúsculas e o ext4 do pod não é, então `LATEST.YML`
 * abre o `latest.yml` na máquina de quem desenvolve e dá 404 em produção. Pior:
 * quem COMPILA o release é um runner Windows, e quem serve é Linux — é a
 * fronteira exata onde essa diferença vira "publiquei e o pod não acha".
 * Comparar o nome com o que o diretório realmente contém faz as duas
 * plataformas responderem igual.
 */
export async function artefatoExiste(dir: string, nome: string): Promise<boolean> {
  if (!nomeDeArtefatoValido(nome)) return false;
  try {
    if (!(await readdir(dir)).includes(nome)) return false;
    return (await stat(join(dir, nome))).isFile();
  } catch {
    return false;
  }
}

/**
 * Deixa no disco os `manter` instaladores mais recentes (por mtime) e apaga os
 * demais, junto dos `.blockmap` deles.
 *
 * Por mtime e não por versão: ordenar semver à mão é o tipo de código que erra
 * em `1.10.0` vs `1.9.0`, e aqui a ordem de CHEGADA é a ordem certa por
 * construção — cada upload é mais novo que o anterior.
 *
 * Por que guardar DOIS e não um: entre o updater ler o `latest.yml` e baixar o
 * `.exe` passam minutos, e um release publicado nesse intervalo apagaria o
 * arquivo que ele está buscando — 404 no meio da atualização de alguém. O
 * segundo também é o caminho de rollback sem recompilar.
 *
 * `latest.yml` e `release.json` nunca entram na poda: eles são substituídos,
 * não acumulados.
 *
 * `protegido` é o instalador que ACABOU de ser publicado, e ele nunca é podado
 * por mais velho que o mtime o faça parecer. Sem isso existe um caminho real de
 * apagar o arquivo que está no ar: um job que sobe o `.exe` e morre antes do
 * commit deixa um órfão MAIS NOVO que o release corrente, e ele ocupa uma das
 * duas vagas — o commit seguinte apagaria o instalador em uso em vez do lixo.
 */
export async function podar(
  dir: string,
  manter: number = MANTER_RELEASES,
  protegido: string | null = null,
): Promise<string[]> {
  const nomes = await readdir(dir);
  const instaladores: { nome: string; mtime: number }[] = [];
  for (const nome of nomes) {
    if (!nome.toLowerCase().endsWith(".exe")) continue;
    if (nome === protegido) continue;
    try {
      instaladores.push({ nome, mtime: (await stat(join(dir, nome))).mtimeMs });
    } catch {
      // sumiu entre o readdir e o stat — nada a podar
    }
  }
  instaladores.sort((a, b) => b.mtime - a.mtime);
  const apagados: string[] = [];
  // o protegido já está guardado e ficou de fora da lista, então ele ocupa uma
  // das `manter` vagas — as outras saem daqui
  const vagas = Math.max(0, manter - (protegido === null ? 0 : 1));
  for (const { nome } of instaladores.slice(vagas)) {
    for (const alvo of [nome, `${nome}.blockmap`]) {
      try {
        await rm(join(dir, alvo), { force: true });
        if (nomes.includes(alvo)) apagados.push(alvo);
      } catch {
        // permissão ou corrida: a poda é higiene, nunca motivo de falhar o publish
      }
    }
  }
  return apagados;
}

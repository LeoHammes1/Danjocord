/**
 * A página de download do app (M14, roadmap 126): `<origem>/download`.
 *
 * É a segunda tela que alguém de fora vê deste servidor — a primeira é a
 * landing do convite (`invite-landing.ts`), e este arquivo é irmão dela de
 * propósito: mesma casca de tela cheia, mesmo tom de texto, mesma regra de que
 * o ERRO é conteúdo principal e não nota de rodapé.
 *
 * TRÊS COISAS QUE MANDAM NO DESENHO:
 *
 * 1. **O download exige sessão, a página não.** O `.exe` leva os sons
 *    proprietários dentro (ATTRIBUTIONS.md) e a condição escrita para usá-los é
 *    "sem instalador para fora". Então a PÁGINA é pública — dá para mandar o
 *    link no WhatsApp — e os BYTES não: quem não está logado vê o mesmo cartão,
 *    com "Entrar com Discord" no lugar do botão. Isso não exclui ninguém:
 *    quem não passa na allowlist também não teria o que fazer com o app.
 *
 * 2. **O caminho volta depois do login.** O OAuth traz o navegador de volta
 *    para a RAIZ (`APP_URL`), não para `/download` — quem some no meio é o
 *    caminho, e sem cuidado a pessoa loga e cai no chat, tendo que descobrir
 *    sozinha como voltar. O `sessionStorage` guarda a intenção; ele é por ABA,
 *    não atravessa origem e não carrega credencial nenhuma (o código do convite,
 *    que É credencial, continua viajando no `state` assinado — nunca aqui).
 *
 * 3. **O aviso do SmartScreen vem ANTES do clique.** O instalador não é
 *    assinado (roadmap 112) e o Windows mostra "O Windows protegeu o seu
 *    computador" com o botão de continuar ESCONDIDO atrás de "Mais informações".
 *    Quem não foi avisado interpreta aquilo como vírus e desiste — o aviso na
 *    página é a diferença entre o amigo instalar e o amigo não instalar.
 */
import { DesktopRelease, DownloadTicket } from "@danjocord/protocol";
import { API, getAccessToken, refresh } from "../auth.js";
// o roteamento e o caminho de volta moram num módulo PURO (sem import de nada
// que só exista no navegador), para o Node conseguir carregá-los no teste —
// mesma razão do pagination.ts e do sound/policy.ts
import { isDownloadRoute, lembrarVoltaParaDownload } from "../download-route.js";
import { brasao } from "./brasao.js";
import { el } from "./dialog.js";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

type Estado =
  | { kind: "loading" }
  | { kind: "anonimo" }
  | { kind: "pronto"; release: DesktopRelease }
  | { kind: "sem-release"; detalhe: string }
  | { kind: "indisponivel"; detalhe: string }
  | { kind: "offline" };

/** Erros que o `GET /api/updates/download` devolve como `?erro=` na volta. */
const ERRO_DA_VOLTA: Record<string, string> = {
  ticket: "O link de download venceu antes de o arquivo começar. Clique em baixar de novo.",
  indisponivel: "Não deu para falar com o GitHub, de onde o instalador vem. Tente daqui a pouco.",
  "sem-release": "Não há instalador publicado neste momento.",
};

async function buscarRelease(): Promise<Estado> {
  if (getAccessToken() === null) return { kind: "anonimo" };
  let res: Response;
  try {
    res = await fetch(`${API}/api/updates/latest`, {
      headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
    });
  } catch {
    return { kind: "offline" };
  }
  if (res.status === 401) {
    // uma tentativa de renovação, e só. Aqui o 401 NÃO chama o logout do app:
    // esta tela não é o app, e derrubar a sessão de quem só queria o instalador
    // seria efeito colateral de uma página informativa.
    if ((await refresh()) !== "ok") return { kind: "anonimo" };
    try {
      res = await fetch(`${API}/api/updates/latest`, {
        headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
      });
    } catch {
      return { kind: "offline" };
    }
    if (res.status === 401) return { kind: "anonimo" };
  }
  const detalhe = res.ok ? "" : await mensagemDoErro(res);
  if (res.status === 404) return { kind: "sem-release", detalhe };
  if (!res.ok) return { kind: "indisponivel", detalhe };
  try {
    return { kind: "pronto", release: DesktopRelease.parse(await res.json()) };
  } catch {
    // 200 com corpo estranho (proxy respondendo HTML durante um deploy):
    // "servidor fora" é mais honesto do que pintar um botão para o nada
    return { kind: "offline" };
  }
}

async function mensagemDoErro(res: Response): Promise<string> {
  try {
    const corpo = (await res.json()) as { error?: unknown };
    return typeof corpo.error === "string" ? corpo.error : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

function tamanho(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  // pt-BR: vírgula decimal. Um instalador de Electron está sempre na casa das
  // centenas de MB, então não há caso de "0,0 MB" para tratar.
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} MB`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface DownloadPageOptions {
  /** começa o login (o web redireciona para /auth/discord/start) */
  onEnter: () => void;
  /** "já estou logado, quero o app web" — a página se remove antes de chamar */
  onDismiss: () => void;
}

let root: HTMLElement | null = null;
let renderToken = 0;

function mountRoot(): HTMLElement {
  if (root !== null) return root;
  const node = el("div");
  node.id = "download-page";
  // mesma razão do invite-landing: esta tela SUBSTITUI o que houver, e um F5 no
  // meio do fluxo pode ter deixado o #app aberto por baixo
  document.getElementById("login")?.setAttribute("hidden", "");
  document.getElementById("app")?.setAttribute("hidden", "");
  document.body.append(node);
  root = node;
  return node;
}

export function closeDownloadPage(): void {
  renderToken++;
  root?.remove();
  root = null;
  if (isDownloadRoute()) history.replaceState(null, "", "/");
}

/** O bloco de instruções — igual em todos os estados em que há o que instalar. */
function comoInstalar(): HTMLElement {
  const box = el("div", "dl-note");
  box.append(el("p", "dl-note-title", "O Windows vai reclamar — e está tudo bem"));
  box.append(
    el(
      "p",
      "",
      "O instalador não é assinado digitalmente (uma assinatura custa caro e este " +
        "app é de dez amigos). O Windows mostra uma tela azul dizendo “O Windows " +
        "protegeu o seu computador”. Clique em “Mais informações” e depois em " +
        "“Executar assim mesmo”.",
    ),
  );
  return box;
}

function paint(estado: Estado, opts: DownloadPageOptions, aviso: string | null): void {
  const box = el("div", "dl-card");
  box.tabIndex = -1;

  const marca = el("div", "dl-mark");
  marca.append(brasao(44));
  box.append(marca);
  box.append(el("p", "dl-kicker", "Danjocord para Windows"));

  if (aviso !== null) {
    const faixa = el("p", "dl-alert", aviso);
    // role=alert: quem usa leitor de tela precisa saber que a última tentativa
    // não funcionou; sem isso a página parece simplesmente ter recarregado
    faixa.setAttribute("role", "alert");
    box.append(faixa);
  }

  if (estado.kind === "loading") {
    box.append(el("h1", "", "Um instante…"));
    box.append(el("p", "dl-lead", "Procurando a versão mais recente."));
  } else if (estado.kind === "offline") {
    box.append(el("h1", "", "Não consegui falar com o servidor"));
    box.append(el("p", "dl-lead", "Pode ser a sua internet, ou o servidor estar reiniciando."));
    box.append(botao("Tentar de novo", () => void run(opts, null), "dl-cta"));
  } else if (estado.kind === "anonimo") {
    box.append(el("h1", "", "Entre para baixar"));
    box.append(
      el(
        "p",
        "dl-lead",
        "O app é só para quem já está no servidor. Entre com o seu Discord e o " +
          "botão de download aparece aqui mesmo.",
      ),
    );
    const cta = botao("Entrar com Discord", () => {
      cta.disabled = true;
      cta.textContent = "abrindo o Discord…";
      lembrarVoltaParaDownload();
      opts.onEnter();
    }, "dl-cta");
    box.append(cta);
  } else if (estado.kind === "sem-release" || estado.kind === "indisponivel") {
    box.append(el("h1", "", estado.kind === "sem-release" ? "Ainda não há uma versão" : "O download está fora do ar"));
    box.append(
      el(
        "p",
        "dl-lead",
        estado.kind === "sem-release"
          ? "Nenhum instalador foi publicado até agora. Enquanto isso, o Danjocord roda no navegador — é o mesmo app."
          : "O servidor não conseguiu chegar ao arquivo. Tente daqui a pouco; enquanto isso, o Danjocord roda no navegador.",
      ),
    );
    if (estado.detalhe !== "") box.append(el("p", "dl-fine", estado.detalhe));
    box.append(botao("Tentar de novo", () => void run(opts, null), "dl-cta"));
  } else {
    const { release } = estado;
    box.append(el("h1", "", "Baixe o app"));
    box.append(
      el(
        "p",
        "dl-lead",
        "O app faz o que o navegador não faz: fica na bandeja com a voz " +
          "conectada, tem push-to-talk global e atualiza sozinho.",
      ),
    );

    const cta = botao(`Baixar para Windows`, () => void baixar(cta, opts), "dl-cta");
    box.append(cta);
    box.append(el("p", "dl-meta", `versão ${release.version} · ${tamanho(release.size)} · Windows 10 ou 11`));
    box.append(comoInstalar());
  }

  const sair = el("button", "dl-skip", "Abrir no navegador");
  sair.type = "button";
  sair.addEventListener("click", () => {
    closeDownloadPage();
    opts.onDismiss();
  });
  box.append(sair);

  mountRoot().replaceChildren(box);
  box.focus();
}

function botao(texto: string, onClick: () => void, classe: string): HTMLButtonElement {
  const b = el("button", classe, texto);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Pede o tíquete e NAVEGA para o download.
 *
 * `location.assign` e não `fetch` + Blob: um instalador de ~100 MB dentro de um
 * `createObjectURL` fica inteiro na memória da aba e tira do navegador a barra
 * de progresso, o "retomar" e a escolha da pasta. A navegação é o caminho certo
 * — e ela NÃO tira a pessoa desta página, porque a resposta final vem com
 * `Content-Disposition: attachment` (medido contra o CDN do GitHub).
 *
 * Se der errado, o servidor redireciona de volta para `/download?erro=…`, um
 * caminho RELATIVO — o que é certo em produção e no desktop, onde a API e a
 * página moram na mesma origem. Em dev com `VITE_API_BASE` apontando para o
 * :8080 enquanto a página vem do vite (:5173), essa volta cai no servidor, que
 * em dev não serve o cliente: 404. Só o caminho de ERRO, só em dev, e só nessa
 * configuração — o caminho feliz é idêntico nos três ambientes.
 */
async function baixar(cta: HTMLButtonElement, opts: DownloadPageOptions): Promise<void> {
  const idle = cta.textContent ?? "Baixar para Windows";
  cta.disabled = true;
  cta.textContent = "preparando…";
  try {
    const res = await fetch(`${API}/api/updates/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
    });
    if (!res.ok) throw new Error(String(res.status));
    const { ticket } = DownloadTicket.parse(await res.json());
    location.assign(`${API}/api/updates/download?ticket=${encodeURIComponent(ticket)}`);
    // o botão fica desabilitado ~1,5 s: o download começa numa camada que a
    // página não enxerga, e devolver o botão na hora convida a um clique duplo
    // que gasta um tíquete à toa
    setTimeout(() => {
      cta.disabled = false;
      cta.textContent = idle;
    }, 1500);
  } catch {
    cta.disabled = false;
    cta.textContent = idle;
    // repinta com as MESMAS opções: um objeto novo com handlers vazios deixaria
    // "Entrar com Discord" e "Abrir no navegador" mudos a partir daqui
    void run(opts, "Não deu para preparar o download. Tente de novo.");
  }
}

async function run(opts: DownloadPageOptions, aviso: string | null): Promise<void> {
  const token = ++renderToken;
  paint({ kind: "loading" }, opts, aviso);
  const estado = await buscarRelease();
  if (token !== renderToken) return;
  paint(estado, opts, aviso);
}

/**
 * Mostra a página de download. Chamar no boot, quando `isDownloadRoute()` for
 * verdadeiro — antes de decidir entre login e app.
 */
export function renderDownloadPage(opts: DownloadPageOptions): void {
  document.title = "Baixar o Danjocord";
  // `?erro=` vem do redirect do servidor quando o download falhou; some da
  // barra de endereço para um F5 não repetir a mensagem de um erro já superado
  const params = new URLSearchParams(location.search);
  const erro = params.get("erro");
  if (erro !== null) history.replaceState(null, "", "/download");
  void run(opts, erro === null ? null : (ERRO_DA_VOLTA[erro] ?? "O download não foi concluído. Tente de novo."));
}

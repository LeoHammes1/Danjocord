import { shell } from "electron";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * OAuth por loopback (RFC 8252, doc §5): o desktop não tem uma origem https
 * para receber o redirect do fluxo web — então sobe um http.Server efêmero em
 * 127.0.0.1:0 (porta aleatória), manda o NAVEGADOR EXTERNO para
 * <serverUrl>/auth/discord/start?redirect_port=<porta>, e o SERVIDOR (que já
 * validou tudo com o Discord) redireciona o navegador de volta para
 * http://127.0.0.1:<porta>/danjocord-callback?otc=... — em QUERY de propósito:
 * fragment não chega a servidor HTTP nenhum, e loopback não tem access log de
 * terceiros para vazar (contrato do M6; o delta do redirect_port é do pacote C).
 *
 * O OTC resolve a promise e o cliente troca por sessão via POST /auth/session
 * (pacote B). auth_error rejeita com a mensagem. Timeout: 120s.
 */

const TIMEOUT_MS = 120_000;
const CALLBACK_PATH = "/danjocord-callback";

/** login em andamento — um novo oauthLogin cancela o anterior (clique duplo no botão) */
let current: { cancel: (reason: string) => void } | null = null;

/** escapa texto vindo da query antes de ecoar em HTML (auth_error é input externo) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** paginazinha dark que o navegador mostra depois do redirect */
function page(title: string, detail: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Danjocord</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #14181e; color: #e3e7ee; font-family: system-ui, sans-serif; }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 1.4rem; margin-bottom: .5rem; }
  p { color: #9aa4b2; }
</style></head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

export function oauthLogin(serverUrl: string, inviteCode?: string | null): Promise<string> {
  // um fluxo por vez: o anterior (se ficou pendurado) morre agora
  current?.cancel("substituído por um novo login");

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = http.createServer();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (current !== null && current.cancel === cancel) current = null;
      clearTimeout(timer);
      fn();
      // fecha SEM matar a resposta em voo: close() só para de aceitar novas
      // conexões — a que acabou de receber a paginazinha flusha e vira idle.
      // O closeAllConnections atrasado é cinto contra keep-alive pendurado
      // (unref: não segura o processo no quit).
      server.close();
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2000).unref();
    };

    const cancel = (reason: string): void => finish(() => reject(new Error(reason)));
    current = { cancel };

    const timer = setTimeout(() => {
      console.warn("[oauth] timeout de 120s esperando o callback do navegador");
      cancel("tempo esgotado esperando o login no navegador (120s)");
    }, TIMEOUT_MS);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        // favicon.ico e afins do navegador — não é o callback
        res.writeHead(404).end();
        return;
      }
      const otc = url.searchParams.get("otc");
      const authError = url.searchParams.get("auth_error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (otc !== null) {
        res.end(page("Login concluído ✓", "Pode voltar ao Danjocord — esta aba já pode ser fechada."));
        console.log("[oauth] OTC recebido no loopback — devolvendo ao renderer");
        finish(() => resolve(otc));
        return;
      }
      const reason = authError ?? "resposta sem otc nem auth_error";
      res.end(page("Falha no login", `Motivo: ${escapeHtml(reason)}. Volte ao Danjocord e tente de novo.`));
      finish(() => reject(new Error(reason)));
    });

    server.on("error", (err) => {
      console.error("[oauth] listener de loopback falhou", err);
      cancel("não foi possível abrir o listener local de login");
    });

    // porta 0 = o SO escolhe uma livre; só em 127.0.0.1 — nada exposto à rede
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      // M10: o convite viaja junto do redirect_port — o servidor guarda os dois
      // no MESMO PendingAuth (junto do state). Sem isto, quem já tem o app
      // instalado e recebe um link de convite não consegue entrar de jeito
      // nenhum: o oauth recusa por allowlist antes de olhar o convite.
      const invite = inviteCode != null && inviteCode !== "" ? `&invite=${encodeURIComponent(inviteCode)}` : "";
      const startUrl = `${serverUrl}/auth/discord/start?redirect_port=${port}${invite}`;
      console.log(`[oauth] loopback ouvindo em 127.0.0.1:${port} — abrindo o navegador externo`);
      void shell.openExternal(startUrl).catch((err: unknown) => {
        console.error("[oauth] shell.openExternal falhou", err);
        cancel("não foi possível abrir o navegador para o login");
      });
    });
  });
}

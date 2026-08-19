import type { User } from "@danjocord/protocol";
import { config } from "./config.js";
import type { Guild } from "./guild.js";
import type { Store } from "./store.js";

/**
 * Bootstrap do primeiro dono (roadmap 116).
 *
 * O PROBLEMA: num deploy limpo a allowlist nasce vazia e ninguém tem cargo. O
 * `oauth.ts` recusa todo mundo antes de escrever qualquer coisa, e não existe
 * admin para criar o primeiro convite — o servidor sobe trancado por fora, e a
 * única saída é `kubectl exec` para rodar o CLI da allowlist.
 *
 * A SOLUÇÃO DESCARTADA: "o primeiro que logar vira dono". O Ingress é público;
 * entre o pod subir e o Leonardo abrir o navegador cabe qualquer um. Isso não é
 * conveniência, é sequestro de servidor com um passo.
 *
 * A SOLUÇÃO: uma env, `DANJOCORD_OWNER_DISCORD_ID`. Quem opera o deploy já sabe
 * o próprio id do Discord, e ele vai no manifest junto dos outros segredos. O
 * boot só age quando a allowlist está VAZIA — reiniciar o pod com a env
 * definida não mexe em nada depois disso, e mudar a env não promove ninguém
 * numa guild que já existe.
 */
export function bootstrapOwner(store: Store, guild: Guild, log: (msg: string) => void): void {
  const discordId = config.ownerDiscordId.trim();
  if (discordId === "") {
    // Silêncio aqui seria cruel: sem a env e com a allowlist vazia, o servidor
    // sobe saudável, responde /healthz e recusa TODO login — e quem operou o
    // deploy não tem como adivinhar por quê. O aviso é a única pista.
    if (guild.allowlistCount() === 0) {
      log(
        "allowlist VAZIA e DANJOCORD_OWNER_DISCORD_ID não definida: ninguém consegue entrar. " +
          "Defina a env com o seu id do Discord e reinicie, ou use scripts/allowlist.ts add <discord_id>.",
      );
    }
    return;
  }
  if (!/^\d{1,20}$/.test(discordId)) {
    log(`DANJOCORD_OWNER_DISCORD_ID inválido ("${discordId}"): esperado o id numérico do Discord — ignorado`);
    return;
  }
  // a condição inteira do bootstrap: só numa guild que ainda não existe
  if (guild.allowlistCount() > 0) return;

  guild.addToAllowlist(discordId, null);
  guild.log({ actorId: null, action: "owner_bootstrap", targetDiscordId: discordId, detail: "allowlist vazia no boot" });
  log(`bootstrap: allowlist vazia — ${discordId} entrou como dono (DANJOCORD_OWNER_DISCORD_ID)`);

  // Se a linha em `users` já existe (banco restaurado de backup, ou a env
  // chegou depois do primeiro login), o cargo é aplicado JÁ. No deploy
  // realmente limpo ela não existe ainda: quem promove é claimOwner(), no
  // primeiro login.
  claimOwner(store, guild, discordId);
}

/**
 * Promove a `owner` o dono configurado, no login dele. Só age quando a guild
 * ainda NÃO tem dono — se já tem, esta função é ruído; e quando alguém tenta
 * logar com um id que não é o configurado, ela não faz absolutamente nada.
 *
 * Devolve o membro promovido (para o chamador anunciar MEMBER_UPDATE) ou null
 * quando não houve promoção — que é o caso de quase todo login.
 */
export function claimOwner(store: Store, guild: Guild, discordId: string): User | null {
  if (config.ownerDiscordId.trim() === "" || discordId !== config.ownerDiscordId.trim()) return null;
  if (store.hasOwner()) return null;
  const user = store.getUserByDiscordId(discordId);
  if (!user || user.role === "owner") return null;
  const promoted = store.setRole(user.id, "owner");
  guild.log({
    actorId: null,
    action: "role_change",
    targetUserId: user.id,
    targetDiscordId: discordId,
    detail: "owner (bootstrap)",
  });
  return promoted;
}

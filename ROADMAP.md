# Roadmap

O que já existe está no [README.md](README.md); este arquivo é o que **falta**.
Levantado em 18/08/2026 por varredura do repositório (5 agentes de levantamento
+ 2 críticos, que derrubaram os itens já implementados).

Esforço: `P` horas · `M` ~1 dia · `G` vários dias.

## Marcos

| Marco | Conteúdo | Estado |
| --- | --- | --- |
| M0–M6 | repo, chat, auth, voz, vídeo, Go Live, app Electron | ✅ |
| M7 | fundação visual — §6 + 75–77 | ✅ |
| M8 | som — §1 e §2 + 113 | ✅ |
| M9 | soundboard + controles de voz — §3 e §4 | ✅ |
| M10 | convites + moderação — §5 + 114, 116 | ✅ |
| M11a | chat: leitura, markdown, menções — 78–83, 85, 92, 93 | ✅ |
| M11b | chat: reply, reações, anexos, busca — 84, 86–91 | ✅ |
| M12 | troca dos sons de UI — 7 e 8 (reabertos) | ✅ |

Fora de marco, mas **antes do primeiro release público**: ~~106~~ e ~~115~~ foram
fechados no M12 (auditoria de segurança); resta **118** (backup — é irreversível
quando falta), dispensado por ora a pedido do Leonardo.

## 1. Sons — pesquisa e assets ✅ M8

Licenças **verificadas nas páginas oficiais**, não deduzidas.

1. ✅ `P` Baixar e triar o pack [Interface Sounds da Kenney](https://kenney.nl/assets/interface-sounds) — 100 sons, CC0 puro, sem cadastro, sem atribuição obrigatória. Base mais segura para um `.exe` distribuído.
2. ✅ `P` Baixar [UI Audio](https://kenney.nl/assets/ui-audio) e [Digital Audio](https://kenney.nl/assets/digital-audio) da Kenney (CC0) — timbres distintos para mensagem, menção e call.
3. ✅ `P` Baixar o [Interface SFX Pack 1](https://obsydianx.itch.io/interface-sfx-pack-1) (ObsydianX, CC0) — 200+ sons já em OGG, famílias confirm/back/cursor/error.
4. ✅ `P` Baixar [512 Sound Effects 8-bit](https://opengameart.org/content/512-sound-effects-8-bit-style) (CC0) — matéria-prima do soundboard.
5. ✅ `M` Curar busca no Freesound com filtro CC0 — sons gravados combinam mais com app de call que os 8-bit. Exige cadastro. **Só CC0**: CC-BY-NC é proibido no projeto.
6. ✅ `P` Documentar a exclusão de **Pixabay, Mixkit e ZapSplat** — as três proíbem redistribuir o arquivo sem modificação significativa, que é exatamente o que um soundboard faz.
7. ✅ `P` (M12 — **decisão revista**) Documentar a posição sobre os sons do Discord. As brand guidelines vedam copiar "sounds", com essa palavra na cláusula, e a regra vale para o que é **distribuído**. Como esta instância é privada (repo privado, allowlist, sem instalador para fora), o Leonardo optou por usá-los: 12 dos 14 são deles hoje. A exceção vem com advertência no ATTRIBUTIONS.md, trava no `desktop-release.yml` e conjunto sintetizado de reserva — ver docs/som.md §3.8.
8. ✅ `M` (M12 — reaberto e feito por inteiro) Gerar os sons com síntese em vez de garimpar mais pack. Dispensado no M8 por os 14 terem vindo de pack CC0; reaberto quando o timbre de pack de JOGO virou a queixa. `apps/client/scripts/gen-sounds.mjs` tem receita para os 14; **2 estão em uso** (`stream-start` e `error`, que a fonte do Discord não tem) e os outros 12 são a reserva/caminho de volta — ver docs/som.md §3.8.1.
9. ✅ `P` Definir o formato canônico. Ficou Ogg/Vorbis no M8 (é como o pack vem) e, no M12, **duas extensões de propósito**: MP3 nos 12 do Discord (intactos — o md5 é o hash da URL de origem, o que torna a procedência verificável) e WAV PCM nos 2 sintetizados (sem encoder na máquina, e sem codec com perda num transiente de 3 ms). Ver docs/som.md §3.3.
10. `M` (dispensado — a normalização virou ganho no playback, ver docs/som.md; no M12 a medição virou ferramenta própria, `scripts/measure-sounds.mjs`, no Chromium do Electron, e o silêncio das pontas passou a ser ignorado na conta em vez de cortado do arquivo) Script ffmpeg de normalização em lote — loudnorm EBU R128 entre −20 e −16 LUFS (abaixo da voz), fade de 5 ms, trim de silêncio.
11. ✅ `P` Criar `ATTRIBUTIONS.md` com procedência e licença de cada arquivo.

## 2. Sons — sistema no cliente ✅ M8

12. ✅ `M` Trocar os chirps de `sounds.ts` por player de `AudioBuffer` com cache, ganho por categoria e ganho mestre.
13. ✅ `P` Fechar o catálogo de eventos e a matriz de quem ouve o quê — **antes** de encomendar os arquivos.
14. ✅ `P` Destravar o AudioContext no primeiro gesto (o comentário atual assume que todo som sucede um clique; deixa de valer com som de mensagem).
15. ✅ `P` Sons de mute/unmute e deafen/undeafen (só para si). Deafen já implica mute — não pode disparar dois sons.
16. ✅ `P` Som quando alguém começa Go Live no meu canal (hoje só o badge "AO VIVO", inútil com a janela no tray).
17. ✅ `P` Sons de desconexão e reconexão, com anti-flapping de ~2 s.
18. ✅ `P` Centralizar a regra de "não tocar o som do próprio usuário" (hoje duplicada em dois pontos do `main.ts`).
19. ✅ `P` Extrair a decisão de tocar som para módulo puro e cobrir com `node --test`.
20. ✅ `M` (investigado; ver docs/som.md) Investigar se os sons de UI vazam para o microfone (AEC e loopback do Go Live).
21. ✅ `M` Painel de configurações de som: volume por categoria e chave geral.

## 3. Soundboard (pad de sons) ✅ M9

22. ✅ `P` Decidir e documentar a arquitetura. Três caminhos: (a) evento no gateway + playback local do asset embutido, (b) o cliente que aperta mixa no próprio producer, (c) injeção no SFU via PlainTransport. **Recomendação: (a)**.
23. ✅ `P` Adicionar `VOICE_SOUNDBOARD` ao protocolo (schema Zod).
24. ✅ `M` `POST` de tocar som com validação de presença no canal — sem isso qualquer sessão toca som onde nem está.
25. ✅ `P` Cooldown e anti-spam server-side (não existe nenhum rate limit hoje).
26. ✅ `M` Implementar o pad no rodapé de voz com playback local.
27. ✅ `P` Respeitar deafen, volume próprio e "desativar soundboard" — com playback local o deafen atual **não silencia o pad**.
28. ✅ `P` Mostrar quem tocou o som (reusa o anel de `VOICE_SPEAKING`).
29. ✅ `P` Definir permissões: quem toca, quem sobe, quem apaga.
30. ✅ `P` Decidir catálogo fixo × upload livre. **Decidido pelo Leonardo: upload livre**, como no Discord — qualquer membro sobe e todos usam. Os 9 CC0 viraram *seed* no banco, não catálogo.
31. ✅ `G` Se for adiante: migration `003` + tabela `sounds`, upload validado, rota com cache imutável, `media-src` na CSP.
32. `G` (não feito — segue como estudo opcional) Spike didático: injeção no SFU via PlainTransport + ffmpeg — não é o caminho do pad, mas é o único que ensina como um SFU recebe mídia que não veio de navegador.

## 4. Voz — mutar, volume, dispositivos ✅ M9

33. ✅ `M` Mute **local** por usuário (só eu paro de ouvir fulano) — puro cliente.
34. ✅ `G` **Server mute** de admin com enforcement no mediasoup (pausar o producer).
35. ✅ `P` Tornar o deafen real — pausar os consumers em vez de só mutar os `<audio>`.
36. ✅ `M` Volume por usuário com `GainNode` + slider.
37. ✅ `P` Desconectar à força alguém do canal de voz.
38. ✅ `G` Tela de configurações de dispositivo — `getUserMedia` sem `deviceId` e consumers sem `setSinkId`: **maior atrito real da voz hoje**.
39. ✅ `M` Teste de microfone + controles de supressão de ruído/AGC (hoje fixos em `true`).
40. ✅ `M` Indicador de qualidade da conexão via `getStats`.
41. ✅ `P` Erro acionável quando entrar na voz falha — hoje `joinVoice()` engole a exceção num `console.warn` e nada acontece na tela.
42. ✅ `P` Mostrar quem está falando nos tiles de vídeo e no rodapé.

## 5. Convite por link e moderação ✅ M10

43. ✅ `M` Migration + tabela `invites` (código, criador, expiração, limite de usos, revogação).
44. ✅ `M` Aceitar `?invite=<código>` no fluxo OAuth — o `oauth.ts` recusa fora da allowlist **antes** de escrever no banco; o convite é a exceção controlada desse ponto.
45. ✅ `M` `POST /api/invites` restrito a admin + `GET`/`DELETE` para listar e revogar.
46. ✅ `M` UI de convites: gerar, copiar, ver usos/validade, revogar.
47. ✅ `M` Rota `/invite/<code>` no cliente com landing e estados de erro.
48. ✅ `M` Card/popover de perfil do membro — é onde mute local, volume, bloquear, server mute, kick e ban precisam **morar**.
49. ✅ `M` Kick pela UI (rota REST que remove da allowlist e revoga sessões).
50. ✅ `M` Tabela `bans`, separando kick de ban — com convite por link, remover da allowlist deixa de ser definitivo.
51. ✅ `M` Trocar `is_admin` por cargo (owner/admin/membro), com proteção contra rebaixar o dono.
52. ✅ `M` `MEMBER_UPDATE` e `MEMBER_REMOVE` no protocolo — só existe `MEMBER_ADD`.
53. ✅ `M` Timeout de chat (silenciar no texto por X min).
54. ✅ `M` Bloquear usuário (esconder mensagens, não só silenciar).
55. ✅ `M` Nickname e avatar próprios da guild (hoje sobrescritos a cada login).
56. ✅ `M` Status real (online/ausente/ocupado/invisível) + auto-ausente por inatividade.
57. ✅ `P` Log auditável de moderação.

## 6. Visual — shell no espírito do Discord ✅ M7

58. ✅ `M` Extrair o CSS do `index.html` para módulos + tokens semânticos. **Sem isso todo item abaixo vira remendo.**
59. ✅ `P` Repaginar a paleta e separar `--accent` de `--danger` (o coral significa hoje enviar, erro e mute ligado).
60. ✅ `P` Coluna de guilds de 72px.
61. ✅ `M` Painel do usuário fixo no rodapé da sidebar — hoje o "eu" está no header e mic/fone só existem dentro da call.
62. ✅ `P` Header de canal com `#` + nome + ações.
63. ✅ `M` Lista de membros em coluna direita, agrupada online/offline, com avatar e badge de admin.
64. ✅ `P` Categorias de canais colapsáveis (visual; o banco vem no item 72 do §9).
65. ✅ `M` Ícones SVG inline no lugar dos emojis.
66. ✅ `P` Scrollbars finas.
67. ✅ `P` Hover, active, `focus-visible` e transições padronizados.
68. ✅ `P` Separar `.active` de "aberto" e "conectado" — a mesma classe significa as duas coisas.
69. ✅ `P` Componente único de avatar com fallback de inicial.
70. ✅ `M` Responsividade mínima.
71. `G` Repensar a área de chamada — stream (60vh) + grade (40vh) **empurram** as mensagens.
72. ✅ `P` Esconder o bloco de login dev (visível sempre, inclusive em produção).
73. ✅ `P` Favicon + título dinâmico com o canal.
74. ✅ `M` Acessibilidade: roles/aria, `prefers-reduced-motion`, contraste do `--muted`.

## 7. Chat ✅

75–77 no M7; 78–83, 85, 92 e 93 no M11a; 84 e 86–91 no M11b.

75. ✅ `G` Agrupar mensagens consecutivas do mesmo autor + avatar no início do bloco. Armadilha: a janela de DOM faz prepend/append/trim nas duas pontas — o agrupamento precisa ser reavaliado **nas bordas**.
76. ✅ `M` Separador de data + timestamp legível.
77. ✅ `M` Textarea auto-crescente com Enter/Shift+Enter e placeholder que segue o canal.
78. ✅ `M` Markdown básico + links clicáveis com sanitização.
79. ✅ `M` Menções `@usuario`/`@todos`.
80. ✅ `M` Badge de não lidas por canal + separador "novas mensagens".
81. ✅ `M` Persistir estado de leitura no servidor (`last_read_message_id` + ack) — **base de 79, 80 e da notificação**.
82. ✅ `M` Mensagem que falhou fica em vermelho com "reenviar" (hoje ela desaparece do DOM).
83. ✅ `P` Botão "pular para o presente" — com o fundo destacado, `MESSAGE_CREATE` é descartado e nada avisa.
84. ✅ `M` Hover na linha inteira + toolbar flutuante + menu de ações.
85. ✅ `P` Cor por autor e tratamento de autor desconhecido (hoje vira `?`).
86. ✅ `M` Responder mensagem (reply).
87. ✅ `G` Reações.
88. ✅ `M` Emoji picker + autocomplete `:nome:`.
89. ✅ `G` Upload de anexos.
90. ✅ `M` Preview de link (unfurl server-side, para não vazar o IP de cada amigo).
91. ✅ `G` Busca no histórico (FTS5).
92. ✅ `M` Mensagens de sistema ("fulano entrou", "canal criado").
93. ✅ `P` Editar a última mensagem com ↑.

## 8. Usabilidade e desktop

94. `M` Notificação nativa do SO com a janela em background — não existe `Notification` nem `visibilitychange`; com o app no tray, mensagem nova **não avisa ninguém**.
95. `P` Não lidas no tray, na barra de tarefas e no título.
96. `P` Módulo de atalhos (mute, deafen, sair da voz, foco no composer, Esc, Alt+setas).
97. `P` Silenciar canal.
98. `M` Quick switcher (Ctrl+K).
99. `M` Toasts e modal próprio — o `confirm()` nativo vira caixa do Windows no Electron.
100. `M` Estados vazio/carregando/paginando (só o erro tem tratamento hoje).
101. `P` Barra de conexão full-width no lugar da pill escondida no header.
102. `M` Banner offline + fila de reenvio.
103. `P` Rascunho por canal + lembrar o último canal aberto.
104. `M` UI de administração de canais (criar, renomear, apagar, reordenar).
105. `M` Onboarding + tela "Sobre" com versão.
106. ✅ `P` **Sincronizar a versão do `apps/desktop/package.json` com a tag** — está em `0.0.1` e o workflow não bumpa: o electron-updater nunca enxerga atualização.
107. `P` Checagem periódica de update + aviso de reiniciar.
108. `P` Iniciar com o Windows, minimizado na bandeja.
109. `P` Persistir tamanho/posição da janela.
110. `P` Log em arquivo + "Abrir logs" no tray.
111. `P` Sons de PTT press/release.
112. `P` Decidir o que fazer com o SmartScreen (app não assinado).
113. ✅ `P` Levar os assets de som para o `app://` e o `client-dist` + criar `vite.config.ts`: asset < 4 KB vira `data:` URI e **as duas CSPs bloqueiam `data:` em mídia**.

## 9. Buracos reais encontrados no levantamento

114. ✅ `M` **Kickado continua dentro** — o gateway valida o token uma única vez, no Identify; a sessão WS aberta segue lendo o chat e ouvindo a voz.
115. ✅ `P` **Um evento novo derruba o cliente antigo** — `ServerMessage.parse()` sem `try/catch` no listener. (M12: try/catch + cão de guarda do handshake, porque engolir o READY travava o cliente em "Conectando…" para sempre.)
116. ✅ `M` **Deploy limpo nasce trancado** — allowlist vazia + `is_admin` default 0. Falta bootstrap do primeiro dono.
117. ✅ `M` Zero rate limit no REST e no gateway. (M12: o GATEWAY ganhou os freios primeiro — op 20 a 60/s, op 3 a 10/s, tetos de sessão e de ring buffer. O REST fechou depois, em `rate-limit.ts`: hook `onRequest` na raiz, classe por PADRÃO de rota carimbado no `onRoute`, e rota fora da tabela DERRUBA O BOOT em vez de nascer ilimitada. A chave é o USUÁRIO e nunca o IP — medido no pod, todo tráfego externo chega como 10.42.0.0 (SNAT antes do Traefik), então balde por IP é um estranho trancando os dez amigos.)
118. `M` **Zero backup do SQLite** — PVC local-path preso a um nó, sem snapshot.
119. ✅ `M` Nada é purgado nunca (`sessions` acumula todas as gerações de refresh). (M12: purga no mesmo sweeper dos órfãos, com corte BEM depois do vencimento — o `rotate` checa revogado antes de expiração de propósito, então apagar no vencimento destruiria a prova de reuso.)
120. ✅ `P` Deploy mata a call sem aviso — o op 7 (Reconnect) existe no protocolo e no cliente, mas o servidor nunca o envia.
121. ✅ `P` Regressão de relógio quebra o snowflake (`nextId()` só compara `now === lastMs`). (M12: trava de monotonia — relógio para trás caía no else, zerava o contador e reemitia ids de um ms já usado; o id é PRIMARY KEY de messages E o cursor de paginação.)
122. ✅ `P` CI roda os testes (`pnpm test`: 105 do servidor + 23 do cliente) — entrou junto do M9, porque a validação de upload é onde um erro é furo de segurança.
123. `M` `mediasoup-client` inteiro carrega antes da tela de login.
124. `P` Runbook de operação (restart, restore, logs, rollback).

## 10. Fora de escopo

Mobile/Capacitor, múltiplas guilds, DMs, threads, bots/API pública, vídeo
gravado, transcrição.

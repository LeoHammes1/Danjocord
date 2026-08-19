/**
 * Limites dos anexos (M11b, item 89).
 *
 * Anexo é a SEGUNDA superfície de binário de usuário do projeto (a primeira foi
 * o soundboard do M9), e a diferença entre as duas é o tamanho: um som cabe em
 * 512 KB, uma foto de celular não. Por isso os tetos aqui são de três tipos, e
 * cada um cobre um abuso diferente:
 *
 *   - por ARQUIVO, contra a imagem gigante que trava o navegador de todo mundo;
 *   - por GUILD, contra o PVC lotado (que derruba o servidor inteiro, não só o
 *     chat: o banco é o mesmo arquivo das mensagens, dos sons e das sessões);
 *   - por TEMPO, contra a enxurrada — e, no caso dos órfãos, contra o lixo que
 *     nunca chega a virar mensagem.
 */

/**
 * Teto por imagem: 8 MB. É o mesmo do Discord grátis e cobre foto de celular
 * moderno sem recompressão. Vale lembrar que o corpo é lido INTEIRO na memória
 * (é o preço do corpo binário cru sem multipart): 8 MB por requisição em voo é
 * confortável no pod, 80 não seria.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Teto de TODOS os anexos da guild somados: 512 MB.
 *
 * O número sai da conta do PVC, não do gosto. O volume tem 2 GiB e guarda UM
 * arquivo — o SQLite — que hoje carrega mensagens, sessões e até 50 MB de sons
 * (M9). Reservando 512 MB para imagens sobram mais de 1,4 GiB para o WAL, para
 * o espaço livre que o SQLite não devolve ao apagar (o banco não encolhe
 * sozinho: um `VACUUM` é operação manual) e para a cópia temporária que
 * qualquer backup futuro (item 118) vai precisar escrever ao lado.
 *
 * 512 MB são ~64 fotos no teto de 8 MB, ou alguns milhares de prints de tela —
 * anos de conversa de dez amigos. E quando encher, o erro é EXPLÍCITO e diz o
 * que fazer: encher o PVC em silêncio derrubaria o servidor inteiro, e não só
 * o upload que passou do limite.
 */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 512 * 1024 * 1024;

/** Anexos por mensagem (o mesmo do Discord): custo máximo conhecido por linha. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Quanto tempo um anexo pode ficar SEM mensagem antes de virar lixo.
 *
 * O upload é em duas etapas (sobe o arquivo, depois manda a mensagem que o
 * referencia), e a janela entre as duas é humana: escolher a imagem, ver o
 * preview, escrever a legenda, se distrair. 15 minutos cobrem isso com folga e
 * ainda garantem que quem fechou a aba não deixou 8 MB no PVC para sempre.
 *
 * A faxina roda no boot e a cada 5 minutos (`index.ts`). Não é um `ON DELETE`
 * nem um trigger porque a condição é de IDADE, não de referência — o SQLite não
 * tem como saber que "faz 15 minutos que ninguém amarrou este anexo".
 */
export const ORPHAN_TTL_MS = 15 * 60_000;
export const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Upload: 10 por minuto por usuário, e a TENTATIVA conta (não só o sucesso) —
 * mesma regra do M9. Mandar lixo repetidamente custa ler o corpo e abrir o
 * cabeçalho; se só o sucesso contasse, o abuso mais barato ficaria de graça.
 */
export const UPLOAD_LIMIT = 10;
export const UPLOAD_WINDOW_MS = 60_000;

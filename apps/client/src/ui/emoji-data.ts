/**
 * Catálogo de emoji do cliente (M11b, item 88).
 *
 * Não existe dependência aqui e não vai existir: emoji Unicode é **texto**.
 * Uma biblioteca de emoji resolveria um problema que este projeto não tem (o
 * conjunto completo, com pele, gênero e ZWJ) e traria um problema que ele tem
 * (mais um pacote para auditar num app que distribui `.exe`).
 *
 * São 469 e não as 3800 do Unicode de propósito: um grupo de dez amigos usa
 * um punhado, e cada linha aqui é bundle que todo mundo baixa. O critério de
 * corte foi "sai do teclado de alguém numa conversa", não "existe no padrão".
 *
 * Três decisões que valem para toda linha abaixo:
 *
 *  - **`name` em inglês** porque `:nome:` é um padrão de fato (Discord, Slack,
 *    GitHub): quem já digita `:thumbsup:` em outro lugar digita aqui. Onde o
 *    nome canônico é longo e o apelido é o que se usa, o apelido entra em
 *    `aliases` (`+1`, `-1`, `heart`) — busca e `emojiByName` olham os dois.
 *  - **`keywords` em português** porque é a língua de quem procura. É o campo
 *    que faz `corac` achar 💜 e `risada` achar 🤣 — o `name` inglês sozinho
 *    deixaria a busca inútil para quem não sabe como o emoji se chama lá.
 *  - **nada de sequência ZWJ** (👨‍👩‍👧, 🧑‍🚀, 🏳️‍🌈) nem modificador de pele. Não é
 *    censura: é que essas sequências quebram diferente em cada fonte de
 *    sistema, e um emoji que vira dois quadrados no Windows de um amigo é pior
 *    que um emoji que não existe na lista. Variation selector (VS16, o `️`
 *    de ❤️) continua, porque sem ele o glifo cai na forma preto-e-branco.
 *
 * Bandeiras ficaram de fora — decisão do pacote, e a mesma razão técnica: no
 * Windows elas nem sequer renderizam como bandeira.
 *
 * Este arquivo é **dado puro**, na mesma divisão do M8 (`sound/catalog.ts`):
 * não importa DOM, não importa nada do cliente, e por isso o teste do Node
 * consegue carregá-lo direto.
 */

export type EmojiCategoria =
  | "rostos"
  | "gestos"
  | "pessoas"
  | "natureza"
  | "comida"
  | "atividades"
  | "objetos"
  | "simbolos";

export interface Emoji {
  /** o caractere em si — é isto que entra no texto da mensagem */
  readonly char: string;
  /** nome canônico, sem os dois-pontos (`smile`, não `:smile:`) */
  readonly name: string;
  /** apelidos aceitos por `emojiByName` e pela busca (`+1` para 👍) */
  readonly aliases: readonly string[];
  /** termos de busca em português, já separados */
  readonly keywords: readonly string[];
  readonly categoria: EmojiCategoria;
}

/** Rótulo humano de cada categoria — o seletor desenha as abas a partir daqui. */
export const CATEGORIAS: readonly { readonly id: EmojiCategoria; readonly rotulo: string }[] = [
  { id: "rostos", rotulo: "Rostos" },
  { id: "gestos", rotulo: "Gestos" },
  { id: "pessoas", rotulo: "Pessoas" },
  { id: "natureza", rotulo: "Natureza" },
  { id: "comida", rotulo: "Comida" },
  { id: "atividades", rotulo: "Atividades" },
  { id: "objetos", rotulo: "Objetos" },
  { id: "simbolos", rotulo: "Símbolos" },
];

/**
 * Uma linha da tabela. Tupla e não objeto porque são centenas: com objeto o
 * arquivo teria três vezes o tamanho e a revisão viraria rolagem. As palavras
 * vêm como UMA string separada por espaço pelo mesmo motivo — quem consome é
 * o `split` logo abaixo, e ninguém lê `["riso","alegre"]` melhor que
 * `"riso alegre"`.
 */
type Entrada = readonly [char: string, name: string, palavras: string, aliases?: string];

const DADOS: Readonly<Record<EmojiCategoria, readonly Entrada[]>> = {
  // -------------------------------------------------------------------------
  // Rostos — a categoria que mais se usa, e por isso a primeira
  // -------------------------------------------------------------------------
  rostos: [
    ["\u{1F600}", "grinning", "sorriso feliz alegre dentes"],
    ["\u{1F603}", "smiley", "sorriso feliz alegre contente"],
    ["\u{1F604}", "smile", "sorriso feliz alegre olhos"],
    ["\u{1F601}", "grin", "sorriso dentes alegre"],
    ["\u{1F606}", "laughing", "risada rindo gargalhada", "satisfied"],
    ["\u{1F605}", "sweat_smile", "risada nervoso suor alivio"],
    ["\u{1F923}", "rofl", "risada chorando rolando gargalhada"],
    ["\u{1F602}", "joy", "risada chorando lagrima gargalhada"],
    ["\u{1F642}", "slightly_smiling_face", "sorriso leve educado ironia"],
    ["\u{1F643}", "upside_down_face", "invertido ironia sarcasmo cabeca"],
    ["\u{1F609}", "wink", "piscada flerte brincadeira"],
    ["\u{1F60A}", "blush", "corado timido feliz sorriso"],
    ["\u{1F607}", "innocent", "anjo inocente santo auréola"],
    ["\u{1F970}", "smiling_face_with_three_hearts", "apaixonado amor coracao fofo"],
    ["\u{1F60D}", "heart_eyes", "apaixonado amor coracao olhos"],
    ["\u{1F929}", "star_struck", "deslumbrado estrela olhos incrivel"],
    ["\u{1F618}", "kissing_heart", "beijo amor coracao"],
    ["\u{1F617}", "kissing", "beijo boca"],
    ["\u{1F60B}", "yum", "delicia gostoso lambendo saboroso"],
    ["\u{1F61B}", "stuck_out_tongue", "lingua brincadeira zoeira"],
    ["\u{1F61C}", "stuck_out_tongue_winking_eye", "lingua piscada zoeira"],
    ["\u{1F92A}", "zany_face", "louco doido maluco lingua"],
    ["\u{1F911}", "money_mouth_face", "dinheiro rico cifrao ganancia"],
    ["\u{1F917}", "hugs", "abraco carinho acolher"],
    ["\u{1F92D}", "hand_over_mouth", "opa risinho segredo boca"],
    ["\u{1F92B}", "shushing_face", "silencio quieto segredo psiu"],
    ["\u{1F914}", "thinking", "pensando duvida hmm reflexao"],
    ["\u{1F910}", "zipper_mouth_face", "boca fechada ziper calado segredo"],
    ["\u{1F928}", "raised_eyebrow", "desconfiado ceticismo sobrancelha duvida"],
    ["\u{1F610}", "neutral_face", "neutro sem reacao indiferente"],
    ["\u{1F611}", "expressionless", "sem expressao entediado indiferente"],
    ["\u{1F636}", "no_mouth", "sem boca calado vazio"],
    ["\u{1F60F}", "smirk", "sorriso torto malicia ironia"],
    ["\u{1F612}", "unamused", "sem gracinha chateado tedio"],
    ["\u{1F644}", "roll_eyes", "revirar olhos tedio ironia"],
    ["\u{1F62C}", "grimacing", "careta constrangido nervoso"],
    ["\u{1F925}", "lying_face", "mentira pinoquio nariz"],
    ["\u{1F60C}", "relieved", "aliviado calmo tranquilo"],
    ["\u{1F614}", "pensive", "pensativo triste cabisbaixo"],
    ["\u{1F62A}", "sleepy", "sono cansado dormindo"],
    ["\u{1F924}", "drooling_face", "babando desejo fome"],
    ["\u{1F634}", "sleeping", "dormindo sono zzz"],
    ["\u{1F637}", "mask", "mascara doente gripe"],
    ["\u{1F912}", "face_with_thermometer", "febre doente termometro"],
    ["\u{1F915}", "face_with_head_bandage", "machucado curativo dor cabeca"],
    ["\u{1F922}", "nauseated_face", "enjoado nausea verde"],
    ["\u{1F92E}", "vomiting_face", "vomito passando mal enjoo"],
    ["\u{1F927}", "sneezing_face", "espirro resfriado gripe lenco"],
    ["\u{1F975}", "hot_face", "calor quente derretendo"],
    ["\u{1F976}", "cold_face", "frio congelando gelo"],
    ["\u{1F974}", "woozy_face", "tonto bebado zonzo"],
    ["\u{1F635}", "dizzy_face", "tonto nocaute confuso"],
    ["\u{1F92F}", "exploding_head", "explodindo cabeca chocado incrivel"],
    ["\u{1F920}", "cowboy_hat_face", "caubói chapeu faroeste"],
    ["\u{1F973}", "partying_face", "festa comemorar aniversario corneta"],
    ["\u{1F60E}", "sunglasses", "oculos escuros estiloso legal"],
    ["\u{1F913}", "nerd_face", "nerd geek oculos estudioso"],
    ["\u{1F9D0}", "monocle_face", "monoculo analisando investigando"],
    ["\u{1F615}", "confused", "confuso incerto duvida"],
    ["\u{1F61F}", "worried", "preocupado aflito"],
    ["\u{1F641}", "slightly_frowning_face", "triste leve descontente"],
    ["\u{1F62E}", "open_mouth", "boca aberta surpreso uau"],
    ["\u{1F62F}", "hushed", "surpreso calado espanto"],
    ["\u{1F632}", "astonished", "espantado chocado surpreso"],
    ["\u{1F633}", "flushed", "vermelho vergonha corado constrangido"],
    ["\u{1F97A}", "pleading_face", "suplicando pedindo olhinhos favor"],
    ["\u{1F628}", "fearful", "medo assustado susto"],
    ["\u{1F630}", "cold_sweat", "medo suor frio nervoso"],
    ["\u{1F622}", "cry", "chorando lagrima triste"],
    ["\u{1F62D}", "sob", "chorando muito triste desespero"],
    ["\u{1F631}", "scream", "grito pavor horror medo"],
    ["\u{1F61E}", "disappointed", "decepcionado triste chateado"],
    ["\u{1F613}", "sweat", "suor nervoso cansado"],
    ["\u{1F629}", "weary", "exausto cansado desespero"],
    ["\u{1F62B}", "tired_face", "cansado exausto esgotado"],
    ["\u{1F971}", "yawning_face", "bocejo sono tedio"],
    ["\u{1F624}", "triumph", "bufando irritado vapor nariz"],
    ["\u{1F621}", "rage", "furioso raiva vermelho bravo", "pout"],
    ["\u{1F620}", "angry", "bravo raiva irritado"],
    ["\u{1F92C}", "cursing_face", "xingando palavrao furioso"],
    ["\u{1F608}", "smiling_imp", "diabo travesso malvado"],
    ["\u{1F47F}", "imp", "diabo bravo malvado"],
    ["\u{1F480}", "skull", "caveira morto morrendo"],
    ["☠️", "skull_and_crossbones", "caveira perigo veneno pirata"],
    ["\u{1F4A9}", "poop", "coco merda ruim"],
    ["\u{1F921}", "clown_face", "palhaco circo piada"],
    ["\u{1F47B}", "ghost", "fantasma assombracao halloween"],
    ["\u{1F47D}", "alien", "et extraterrestre espaco"],
    ["\u{1F916}", "robot", "robo bot maquina"],
    ["\u{1F383}", "jack_o_lantern", "abobora halloween assustador"],
    ["\u{1F978}", "disguised_face", "disfarce bigode oculos falso"],
    ["\u{1FAE0}", "melting_face", "derretendo vergonha calor"],
    ["\u{1FAE1}", "saluting_face", "continencia saudacao respeito"],
    ["\u{1F979}", "face_holding_back_tears", "segurando choro emocionado"],
    ["\u{1F648}", "see_no_evil", "macaco olhos vergonha nao vi"],
    ["\u{1F649}", "hear_no_evil", "macaco ouvidos nao ouvi"],
    ["\u{1F64A}", "speak_no_evil", "macaco boca calado nao falo"],
    ["\u{1F63B}", "heart_eyes_cat", "gato apaixonado coracao"],
  ],

  // -------------------------------------------------------------------------
  // Gestos — mãos. É o que vira "reação" na prática (👍 é metade do uso real)
  // -------------------------------------------------------------------------
  gestos: [
    ["\u{1F44D}", "thumbsup", "joia positivo ok curtir aprovado", "+1 like"],
    ["\u{1F44E}", "thumbsdown", "negativo ruim reprovado descurtir", "-1 dislike"],
    ["\u{1F44C}", "ok_hand", "ok certo perfeito beleza"],
    ["✌️", "v", "paz vitoria dois dedos", "victory_hand"],
    ["\u{1F91E}", "crossed_fingers", "dedos cruzados sorte torcendo"],
    ["\u{1F91F}", "love_you_gesture", "amo voce mao gesto"],
    ["\u{1F918}", "metal", "rock chifrinho metal show"],
    ["\u{1F919}", "call_me_hand", "me liga shaka gesto"],
    ["\u{1F448}", "point_left", "aponta esquerda dedo"],
    ["\u{1F449}", "point_right", "aponta direita dedo"],
    ["\u{1F446}", "point_up_2", "aponta cima dedo"],
    ["\u{1F447}", "point_down", "aponta baixo dedo"],
    ["☝️", "point_up", "aponta cima indicador atencao"],
    ["✋", "raised_hand", "mao levantada parar oi"],
    ["\u{1F91A}", "raised_back_of_hand", "costas mao levantada"],
    ["\u{1F590}️", "raised_hand_with_fingers_splayed", "mao aberta dedos separados"],
    ["\u{1F596}", "vulcan_salute", "vulcano spock saudacao"],
    ["\u{1F44B}", "wave", "aceno oi tchau"],
    ["\u{1F91D}", "handshake", "aperto maos acordo negocio"],
    ["\u{1F44F}", "clap", "palmas aplauso parabens"],
    ["\u{1F64C}", "raised_hands", "aleluia comemorar maos cima"],
    ["\u{1F64F}", "pray", "reza obrigado por favor maos"],
    ["✍️", "writing_hand", "escrevendo caneta anotar"],
    ["\u{1F4AA}", "muscle", "forca biceps academia"],
    ["\u{1F9BE}", "mechanical_arm", "braco mecanico protese robo"],
    ["\u{1F91B}", "fist_left", "soco esquerda punho"],
    ["\u{1F91C}", "fist_right", "soco direita punho"],
    ["✊", "fist_raised", "punho luta resistencia"],
    ["\u{1F44A}", "punch", "soco murro briga"],
    ["\u{1FAF0}", "hand_with_index_finger_and_thumb_crossed", "coracaozinho dedos dinheiro"],
    ["\u{1FAF6}", "heart_hands", "coracao maos amor carinho"],
    ["\u{1F932}", "palms_up_together", "maos juntas pedindo por favor"],
    ["\u{1FAF5}", "index_pointing_at_the_viewer", "apontando voce dedo"],
    ["\u{1F595}", "middle_finger", "dedo medio ofensa"],
    ["\u{1F485}", "nail_care", "unhas esmalte pouco caso"],
    ["\u{1F90C}", "pinched_fingers", "dedos juntos italiano gesto"],
  ],

  // -------------------------------------------------------------------------
  // Pessoas e partes do corpo
  // -------------------------------------------------------------------------
  pessoas: [
    ["\u{1F440}", "eyes", "olhos olhando vendo fofoca"],
    ["\u{1F441}️", "eye", "olho vendo observando"],
    ["\u{1F444}", "lips", "boca labios beijo"],
    ["\u{1F445}", "tongue", "lingua"],
    ["\u{1F9E0}", "brain", "cerebro ideia inteligencia"],
    ["\u{1F9B7}", "tooth", "dente dentista"],
    ["\u{1F9B4}", "bone", "osso esqueleto"],
    ["\u{1F476}", "baby", "bebe crianca recem nascido"],
    ["\u{1F9D2}", "child", "crianca"],
    ["\u{1F466}", "boy", "menino garoto"],
    ["\u{1F467}", "girl", "menina garota"],
    ["\u{1F9D1}", "adult", "pessoa adulto"],
    ["\u{1F468}", "man", "homem cara"],
    ["\u{1F469}", "woman", "mulher moca"],
    ["\u{1F474}", "older_man", "senhor idoso velho"],
    ["\u{1F475}", "older_woman", "senhora idosa velha"],
    ["\u{1F46E}", "police_officer", "policial policia"],
    ["\u{1F575}️", "detective", "detetive investigador espiao"],
    ["\u{1F477}", "construction_worker", "operario obra construcao"],
    ["\u{1F977}", "ninja", "ninja furtivo"],
    ["\u{1F9DF}", "zombie", "zumbi morto vivo"],
    ["\u{1F464}", "bust_in_silhouette", "usuario perfil pessoa silhueta"],
    ["\u{1F465}", "busts_in_silhouette", "usuarios grupo pessoas"],
    ["\u{1F5E3}️", "speaking_head", "falando voz cabeca"],
    ["\u{1F6B6}", "walking", "andando caminhando"],
    ["\u{1F3C3}", "runner", "correndo corrida fuga"],
    ["\u{1F483}", "dancer", "dancando festa"],
    ["\u{1F57A}", "man_dancing", "dancando festa homem"],
    ["\u{1F933}", "selfie", "foto celular selfie"],
    ["\u{1F926}", "facepalm", "vergonha alheia mao rosto desisto"],
    ["\u{1F937}", "shrug", "sei la ombros dar de ombros"],
    ["\u{1F64B}", "raising_hand", "mao levantada pergunta eu"],
    ["\u{1F645}", "no_good", "nao pode proibido x"],
  ],

  // -------------------------------------------------------------------------
  // Natureza — bichos, plantas, céu e clima
  // -------------------------------------------------------------------------
  natureza: [
    ["\u{1F436}", "dog", "cachorro cao doguinho"],
    ["\u{1F431}", "cat", "gato gatinho"],
    ["\u{1F42D}", "mouse", "rato camundongo"],
    ["\u{1F439}", "hamster", "hamster roedor"],
    ["\u{1F430}", "rabbit", "coelho"],
    ["\u{1F98A}", "fox_face", "raposa"],
    ["\u{1F43B}", "bear", "urso"],
    ["\u{1F43C}", "panda_face", "panda"],
    ["\u{1F428}", "koala", "coala"],
    ["\u{1F42F}", "tiger", "tigre"],
    ["\u{1F981}", "lion", "leao"],
    ["\u{1F42E}", "cow", "vaca boi"],
    ["\u{1F437}", "pig", "porco"],
    ["\u{1F438}", "frog", "sapo ra"],
    ["\u{1F435}", "monkey_face", "macaco"],
    ["\u{1F414}", "chicken", "galinha frango"],
    ["\u{1F427}", "penguin", "pinguim"],
    ["\u{1F426}", "bird", "passaro ave"],
    ["\u{1F43A}", "wolf", "lobo"],
    ["\u{1F434}", "horse", "cavalo"],
    ["\u{1F984}", "unicorn", "unicornio magia"],
    ["\u{1F41D}", "bee", "abelha mel", "honeybee"],
    ["\u{1F41B}", "bug", "inseto lagarta bicho erro"],
    ["\u{1F98B}", "butterfly", "borboleta"],
    ["\u{1F40C}", "snail", "caracol lento"],
    ["\u{1F577}️", "spider", "aranha"],
    ["\u{1F422}", "turtle", "tartaruga lento"],
    ["\u{1F40D}", "snake", "cobra serpente"],
    ["\u{1F419}", "octopus", "polvo"],
    ["\u{1F980}", "crab", "caranguejo"],
    ["\u{1F420}", "tropical_fish", "peixe tropical"],
    ["\u{1F41F}", "fish", "peixe"],
    ["\u{1F42C}", "dolphin", "golfinho"],
    ["\u{1F433}", "whale", "baleia"],
    ["\u{1F988}", "shark", "tubarao"],
    ["\u{1F40A}", "crocodile", "jacare crocodilo"],
    ["\u{1F418}", "elephant", "elefante"],
    ["\u{1F43E}", "paw_prints", "patas pegadas bicho"],
    ["\u{1F409}", "dragon", "dragao"],
    ["\u{1F335}", "cactus", "cacto deserto"],
    ["\u{1F384}", "christmas_tree", "natal arvore pinheiro"],
    ["\u{1F332}", "evergreen_tree", "pinheiro arvore"],
    ["\u{1F333}", "deciduous_tree", "arvore folhas"],
    ["\u{1F334}", "palm_tree", "coqueiro praia palmeira"],
    ["\u{1F331}", "seedling", "muda broto planta crescer"],
    ["\u{1F33F}", "herb", "erva folha planta"],
    ["\u{1F340}", "four_leaf_clover", "trevo quatro folhas sorte"],
    ["\u{1F343}", "leaves", "folhas vento"],
    ["\u{1F342}", "fallen_leaf", "folha caida outono"],
    ["\u{1F341}", "maple_leaf", "folha bordo outono"],
    ["\u{1F33B}", "sunflower", "girassol flor"],
    ["\u{1F339}", "rose", "rosa flor amor"],
    ["\u{1F338}", "cherry_blossom", "flor cerejeira sakura"],
    ["\u{1F490}", "bouquet", "buque flores"],
    ["\u{1F344}", "mushroom", "cogumelo"],
    ["\u{1F30D}", "earth_africa", "terra planeta mundo mapa"],
    ["\u{1F319}", "crescent_moon", "lua noite dormir"],
    ["⭐", "star", "estrela favorito"],
    ["\u{1F31F}", "star2", "estrela brilhante brilho"],
    ["✨", "sparkles", "brilho estrelas magia novo"],
    ["⚡", "zap", "raio energia rapido"],
    ["\u{1F525}", "fire", "fogo chama incrivel"],
    ["\u{1F4A5}", "boom", "explosao impacto colisao"],
    ["☀️", "sunny", "sol calor claro"],
    ["⛅", "partly_sunny", "sol nuvem parcial"],
    ["☁️", "cloud", "nuvem nublado"],
    ["\u{1F327}️", "cloud_with_rain", "chuva nuvem"],
    ["\u{1F308}", "rainbow", "arco iris cores"],
    ["❄️", "snowflake", "neve floco frio"],
    ["⛄", "snowman", "boneco neve frio"],
    ["\u{1F4A7}", "droplet", "gota agua"],
    ["\u{1F30A}", "ocean", "onda mar agua praia"],
    ["\u{1F32A}️", "tornado", "tornado furacao vento"],
  ],

  // -------------------------------------------------------------------------
  // Comida e bebida
  // -------------------------------------------------------------------------
  comida: [
    ["\u{1F34E}", "apple", "maca fruta"],
    ["\u{1F34F}", "green_apple", "maca verde fruta"],
    ["\u{1F350}", "pear", "pera fruta"],
    ["\u{1F34A}", "tangerine", "laranja mexerica fruta"],
    ["\u{1F34B}", "lemon", "limao azedo fruta"],
    ["\u{1F34C}", "banana", "banana fruta"],
    ["\u{1F349}", "watermelon", "melancia fruta"],
    ["\u{1F347}", "grapes", "uva fruta vinho"],
    ["\u{1F353}", "strawberry", "morango fruta"],
    ["\u{1F352}", "cherries", "cereja fruta"],
    ["\u{1F351}", "peach", "pessego fruta bumbum"],
    ["\u{1F34D}", "pineapple", "abacaxi fruta"],
    ["\u{1F345}", "tomato", "tomate"],
    ["\u{1F951}", "avocado", "abacate"],
    ["\u{1F346}", "eggplant", "berinjela"],
    ["\u{1F954}", "potato", "batata"],
    ["\u{1F955}", "carrot", "cenoura"],
    ["\u{1F33D}", "corn", "milho espiga"],
    ["\u{1F336}️", "hot_pepper", "pimenta ardido picante"],
    ["\u{1F966}", "broccoli", "brocolis"],
    ["\u{1F35E}", "bread", "pao"],
    ["\u{1F9C0}", "cheese", "queijo"],
    ["\u{1F95A}", "egg", "ovo"],
    ["\u{1F373}", "fried_egg", "ovo frito cafe manha"],
    ["\u{1F95E}", "pancakes", "panqueca cafe manha"],
    ["\u{1F953}", "bacon", "bacon"],
    ["\u{1F354}", "hamburger", "hamburguer lanche"],
    ["\u{1F35F}", "fries", "batata frita"],
    ["\u{1F355}", "pizza", "pizza"],
    ["\u{1F32D}", "hotdog", "cachorro quente"],
    ["\u{1F96A}", "sandwich", "sanduiche"],
    ["\u{1F32E}", "taco", "taco mexicano"],
    ["\u{1F32F}", "burrito", "burrito mexicano"],
    ["\u{1F957}", "green_salad", "salada"],
    ["\u{1F37F}", "popcorn", "pipoca cinema"],
    ["\u{1F35A}", "rice", "arroz"],
    ["\u{1F35C}", "ramen", "lamen macarrao sopa"],
    ["\u{1F35D}", "spaghetti", "macarrao espaguete massa"],
    ["\u{1F363}", "sushi", "sushi japonesa"],
    ["\u{1F366}", "icecream", "sorvete casquinha"],
    ["\u{1F369}", "doughnut", "rosquinha donut"],
    ["\u{1F36A}", "cookie", "biscoito bolacha"],
    ["\u{1F382}", "birthday", "bolo aniversario festa"],
    ["\u{1F370}", "cake", "bolo doce fatia"],
    ["\u{1F9C1}", "cupcake", "cupcake bolinho"],
    ["\u{1F36B}", "chocolate_bar", "chocolate barra"],
    ["\u{1F36C}", "candy", "bala doce"],
    ["\u{1F36D}", "lollipop", "pirulito doce"],
    ["\u{1F95B}", "milk_glass", "leite copo"],
    ["☕", "coffee", "cafe cafezinho quente"],
    ["\u{1F375}", "tea", "cha xicara"],
    ["\u{1F37E}", "champagne", "champanhe comemorar garrafa"],
    ["\u{1F377}", "wine_glass", "vinho taca"],
    ["\u{1F378}", "cocktail", "drink coquetel"],
    ["\u{1F379}", "tropical_drink", "drink tropical praia"],
    ["\u{1F37A}", "beer", "cerveja chope"],
    ["\u{1F37B}", "beers", "cervejas brinde chope"],
    ["\u{1F942}", "clinking_glasses", "brinde tacas comemorar"],
    ["\u{1F9C9}", "mate", "chimarrao erva mate"],
    ["\u{1F9CA}", "ice_cube", "gelo cubo"],
    ["\u{1F374}", "fork_and_knife", "talheres comer garfo faca"],
  ],

  // -------------------------------------------------------------------------
  // Atividades — esporte, jogo, música e festa
  // -------------------------------------------------------------------------
  atividades: [
    ["⚽", "soccer", "futebol bola"],
    ["\u{1F3C0}", "basketball", "basquete bola"],
    ["\u{1F3C8}", "football", "futebol americano bola"],
    ["⚾", "baseball", "beisebol bola"],
    ["\u{1F3BE}", "tennis", "tenis bola raquete"],
    ["\u{1F3D0}", "volleyball", "volei bola"],
    ["\u{1F3B1}", "8ball", "sinuca bilhar bola oito"],
    ["\u{1F3D3}", "ping_pong", "pingue pongue tenis mesa"],
    ["\u{1F94A}", "boxing_glove", "boxe luva luta"],
    ["⛳", "golf", "golfe buraco bandeira"],
    ["\u{1F6F9}", "skateboard", "skate"],
    ["\u{1F3CB}️", "weight_lifting", "academia peso musculacao"],
    ["\u{1F6B4}", "bicyclist", "bicicleta ciclismo pedalar"],
    ["\u{1F3C6}", "trophy", "trofeu vitoria campeao premio"],
    ["\u{1F947}", "1st_place_medal", "ouro primeiro medalha"],
    ["\u{1F948}", "2nd_place_medal", "prata segundo medalha"],
    ["\u{1F949}", "3rd_place_medal", "bronze terceiro medalha"],
    ["\u{1F3C5}", "medal_sports", "medalha esporte premio"],
    ["\u{1F3AE}", "video_game", "jogo controle gamer joystick"],
    ["\u{1F579}️", "joystick", "controle arcade jogo"],
    ["\u{1F3B2}", "game_die", "dado sorte jogo rpg"],
    ["\u{1F9E9}", "jigsaw", "quebra cabeca peca"],
    ["♟️", "chess_pawn", "xadrez peao"],
    ["\u{1F3AF}", "dart", "dardo alvo mira acertou"],
    ["\u{1F3B3}", "bowling", "boliche pinos"],
    ["\u{1F3B0}", "slot_machine", "caca niquel cassino sorte"],
    ["\u{1F3AD}", "performing_arts", "teatro mascaras drama"],
    ["\u{1F3A8}", "art", "arte paleta pintura"],
    ["\u{1F3AC}", "clapper", "cinema claquete filme"],
    ["\u{1F3A4}", "microphone", "microfone cantar voz"],
    ["\u{1F3A7}", "headphones", "fone ouvido musica"],
    ["\u{1F3BC}", "musical_score", "partitura musica clave"],
    ["\u{1F3B5}", "musical_note", "nota musical musica"],
    ["\u{1F3B6}", "notes", "notas musicais musica"],
    ["\u{1F3B9}", "musical_keyboard", "teclado piano musica"],
    ["\u{1F941}", "drum", "bateria tambor percussao"],
    ["\u{1F3B7}", "saxophone", "saxofone jazz"],
    ["\u{1F3BA}", "trumpet", "trompete"],
    ["\u{1F3B8}", "guitar", "violao guitarra"],
    ["\u{1F3BB}", "violin", "violino orquestra"],
    ["\u{1F389}", "tada", "festa comemorar parabens confete"],
    ["\u{1F38A}", "confetti_ball", "confete festa comemorar"],
    ["\u{1F388}", "balloon", "balao festa aniversario"],
    ["\u{1F381}", "gift", "presente caixa aniversario"],
    ["\u{1F380}", "ribbon", "laco fita"],
    ["\u{1F9E8}", "firecracker", "rojao fogos explosao"],
    ["\u{1F386}", "fireworks", "fogos artificio festa"],
  ],

  // -------------------------------------------------------------------------
  // Objetos — tecnologia, escritório, ferramentas e alguns veículos.
  // Veículos não ganharam categoria própria: são meia dúzia (🚀 é o único de
  // uso real diário) e uma aba com seis itens é pior que uma linha a mais aqui.
  // -------------------------------------------------------------------------
  objetos: [
    ["\u{1F4F1}", "iphone", "celular telefone smartphone"],
    ["\u{1F4BB}", "computer", "notebook laptop pc"],
    ["\u{1F5A5}️", "desktop_computer", "computador monitor pc"],
    ["⌨️", "keyboard", "teclado digitar"],
    ["\u{1F5B1}️", "computer_mouse", "mouse cursor"],
    ["\u{1F4BE}", "floppy_disk", "disquete salvar"],
    ["\u{1F50C}", "electric_plug", "tomada plugue energia"],
    ["\u{1F50B}", "battery", "bateria carga pilha"],
    ["\u{1F4F7}", "camera", "camera foto"],
    ["\u{1F4F8}", "camera_flash", "camera flash foto"],
    ["\u{1F4F9}", "video_camera", "filmadora video gravar"],
    ["\u{1F3A5}", "movie_camera", "cinema filme camera"],
    ["\u{1F4FA}", "tv", "televisao tela"],
    ["\u{1F4DE}", "telephone_receiver", "telefone fone ligar"],
    ["\u{1F50D}", "mag", "lupa buscar procurar zoom"],
    ["\u{1F4A1}", "bulb", "lampada ideia luz"],
    ["\u{1F526}", "flashlight", "lanterna luz"],
    ["\u{1F4D6}", "book", "livro leitura"],
    ["\u{1F4DA}", "books", "livros estudo biblioteca"],
    ["\u{1F4DD}", "memo", "anotar nota escrever lembrete"],
    ["✏️", "pencil2", "lapis escrever"],
    ["\u{1F4CC}", "pushpin", "alfinete fixar marcar"],
    ["\u{1F4CE}", "paperclip", "clipe anexo anexar"],
    ["✂️", "scissors", "tesoura cortar"],
    ["\u{1F4C1}", "file_folder", "pasta arquivo"],
    ["\u{1F4C2}", "open_file_folder", "pasta aberta arquivo"],
    ["\u{1F4C6}", "calendar", "calendario mes agenda"],
    ["\u{1F4CA}", "bar_chart", "grafico barras dados"],
    ["\u{1F4C8}", "chart_with_upwards_trend", "grafico subindo alta crescimento"],
    ["\u{1F5D1}️", "wastebasket", "lixo lixeira apagar"],
    ["\u{1F512}", "lock", "cadeado trancado seguranca"],
    ["\u{1F513}", "unlock", "cadeado aberto destrancado"],
    ["\u{1F511}", "key", "chave acesso senha"],
    ["\u{1F528}", "hammer", "martelo consertar bater"],
    ["\u{1F527}", "wrench", "chave inglesa consertar ajuste"],
    ["⚙️", "gear", "engrenagem configuracao ajuste"],
    ["\u{1F9EC}", "dna", "dna genetica biologia"],
    ["\u{1F48A}", "pill", "remedio comprimido"],
    ["\u{1F4B0}", "moneybag", "dinheiro saco grana"],
    ["\u{1F4B3}", "credit_card", "cartao credito pagar"],
    ["\u{1F48E}", "gem", "diamante joia pedra"],
    ["\u{1F517}", "link", "elo corrente url"],
    ["⏰", "alarm_clock", "despertador alarme hora"],
    ["⏳", "hourglass_flowing_sand", "ampulheta tempo esperando"],
    ["\u{1F4E6}", "package", "caixa pacote entrega encomenda"],
    ["✉️", "envelope", "carta email envelope"],
    ["\u{1F4E7}", "email", "email correio mensagem", "e-mail"],
    ["\u{1F3F7}️", "label", "etiqueta rotulo tag"],
    ["\u{1F516}", "bookmark", "marcador favorito salvar"],
    ["\u{1F3AB}", "ticket", "ingresso bilhete entrada"],
    ["\u{1F6E1}️", "shield", "escudo protecao seguranca"],
    ["⚔️", "crossed_swords", "espadas luta batalha"],
    ["\u{1F3C1}", "checkered_flag", "bandeira chegada fim corrida"],
    ["\u{1F680}", "rocket", "foguete lancamento rapido deploy"],
    ["\u{1F6F8}", "flying_saucer", "disco voador ovni et"],
    ["✈️", "airplane", "aviao voo viagem"],
    ["\u{1F697}", "car", "carro automovel"],
    ["\u{1F3CD}️", "motorcycle", "moto motocicleta"],
    ["\u{1F6B2}", "bike", "bicicleta bike pedalar"],
    ["\u{1F3E0}", "house", "casa lar"],
  ],

  // -------------------------------------------------------------------------
  // Símbolos — corações, marcas, setas e controles
  // -------------------------------------------------------------------------
  simbolos: [
    ["❤️", "heart", "coracao amor vermelho", "red_heart"],
    ["\u{1F9E1}", "orange_heart", "coracao laranja amor"],
    ["\u{1F49B}", "yellow_heart", "coracao amarelo amor"],
    ["\u{1F49A}", "green_heart", "coracao verde amor"],
    ["\u{1F499}", "blue_heart", "coracao azul amor"],
    ["\u{1F49C}", "purple_heart", "coracao roxo amor"],
    ["\u{1F5A4}", "black_heart", "coracao preto"],
    ["\u{1F90D}", "white_heart", "coracao branco"],
    ["\u{1F90E}", "brown_heart", "coracao marrom"],
    ["\u{1F494}", "broken_heart", "coracao partido triste"],
    ["❣️", "heavy_heart_exclamation", "coracao exclamacao amor"],
    ["\u{1F495}", "two_hearts", "coracoes amor"],
    ["\u{1F49E}", "revolving_hearts", "coracoes girando amor"],
    ["\u{1F493}", "heartbeat", "coracao batendo amor"],
    ["\u{1F497}", "heartpulse", "coracao crescendo amor"],
    ["\u{1F496}", "sparkling_heart", "coracao brilhante amor"],
    ["\u{1F498}", "cupid", "coracao flecha cupido amor"],
    ["\u{1F4AF}", "100", "cem nota perfeito exato concordo"],
    ["\u{1F4A2}", "anger", "raiva veia irritado"],
    ["\u{1F4AC}", "speech_balloon", "balao fala mensagem conversa"],
    ["\u{1F4AD}", "thought_balloon", "balao pensamento ideia"],
    ["\u{1F4A4}", "zzz", "sono dormindo tedio"],
    ["✅", "white_check_mark", "certo ok feito confirmado verde"],
    ["✔️", "heavy_check_mark", "certo confirmado feito"],
    ["❌", "x", "errado nao cancelar erro"],
    ["⭕", "o", "circulo certo correto"],
    ["\u{1F6AB}", "no_entry_sign", "proibido nao pode bloqueado"],
    ["⛔", "no_entry", "proibido entrada bloqueado"],
    ["⚠️", "warning", "atencao aviso cuidado perigo"],
    ["\u{1F6A8}", "rotating_light", "alerta sirene emergencia policia"],
    ["❗", "exclamation", "exclamacao atencao importante"],
    ["❓", "question", "pergunta duvida interrogacao"],
    ["‼️", "bangbang", "duas exclamacoes atencao"],
    ["♻️", "recycle", "reciclar verde ambiente"],
    ["\u{1F192}", "ok", "ok certo beleza"],
    ["\u{1F195}", "new", "novo lancamento"],
    ["\u{1F51D}", "top", "topo cima melhor"],
    ["➡️", "arrow_right", "seta direita"],
    ["⬅️", "arrow_left", "seta esquerda"],
    ["⬆️", "arrow_up", "seta cima"],
    ["⬇️", "arrow_down", "seta baixo"],
    ["\u{1F500}", "twisted_rightwards_arrows", "aleatorio embaralhar shuffle"],
    ["\u{1F501}", "repeat", "repetir loop"],
    ["▶️", "arrow_forward", "play tocar iniciar"],
    ["⏸️", "pause_button", "pausar pause"],
    ["⏹️", "stop_button", "parar stop"],
    ["⏩", "fast_forward", "avancar rapido adiantar"],
    ["⏪", "rewind", "retroceder voltar rapido"],
    ["\u{1F50A}", "loud_sound", "som alto volume alto"],
    ["\u{1F509}", "sound", "som medio volume"],
    ["\u{1F508}", "speaker", "alto falante som"],
    ["\u{1F507}", "mute", "mudo sem som silencio"],
    ["\u{1F514}", "bell", "sino notificacao aviso"],
    ["\u{1F515}", "no_bell", "sino cortado silenciar notificacao"],
    ["\u{1F4E3}", "mega", "megafone anuncio aviso"],
    ["\u{1F4E2}", "loudspeaker", "alto falante anuncio"],
    ["➕", "heavy_plus_sign", "mais somar adicionar"],
    ["➖", "heavy_minus_sign", "menos subtrair remover"],
    ["✖️", "heavy_multiplication_x", "vezes multiplicar"],
    ["\u{1F4B2}", "heavy_dollar_sign", "cifrao dinheiro dolar"],
    ["♾️", "infinity", "infinito sempre"],
  ],
};

/**
 * O catálogo achatado, na ordem das categorias. É a ordem que o seletor
 * desenha e a ordem de desempate da busca — por isso é construída a partir de
 * `CATEGORIAS` e não das chaves de `DADOS`: a ordem de iteração de um objeto
 * é a de inserção, mas depender disso deixaria a UI refém de um detalhe de
 * runtime.
 */
export const EMOJIS: readonly Emoji[] = CATEGORIAS.flatMap(({ id }) =>
  DADOS[id].map(([char, name, palavras, aliases]) => ({
    char,
    name,
    aliases: aliases === undefined ? [] : aliases.split(" "),
    keywords: palavras.split(" "),
    categoria: id,
  })),
);

/**
 * Índice por nome E por apelido, montado uma vez. `emojiByName` é chamado a
 * cada `:atalho:` digitado; varrer 430 itens a cada tecla seria trabalho por
 * nada num laço que já roda no caminho do teclado.
 */
export const POR_NOME: ReadonlyMap<string, Emoji> = (() => {
  const mapa = new Map<string, Emoji>();
  for (const emoji of EMOJIS) {
    // o primeiro a registrar ganha: um apelido nunca sobrescreve um nome
    // canônico (`:heart:` é ❤️, mesmo que outro emoji se apelide de heart)
    if (!mapa.has(emoji.name)) mapa.set(emoji.name, emoji);
  }
  for (const emoji of EMOJIS) {
    for (const alias of emoji.aliases) if (!mapa.has(alias)) mapa.set(alias, emoji);
  }
  return mapa;
})();

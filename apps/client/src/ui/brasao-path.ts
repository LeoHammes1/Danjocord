/**
 * GERADO por scripts/trace-logo.mjs — não editar à mão.
 * Refazer:  node scripts/trace-logo.mjs
 *
 * Brasão do Danjomar vetorizado de assets/brand/danjomar-logo-fonte.png.
 * O desenho tem uma cor só (o "branco" é transparência), então é UM path com
 * fill-rule="evenodd": 6 laços, 92 pontos.
 *
 * Fidelidade aferida rasterizando o path de volta: 0.63% da área diverge,
 * e é a borda de antialiasing do PNG — nada estrutural (tolerância eps=1.6).
 */

/** sha256 do PNG de origem — o teste reprova se o arquivo mudar sem regerar. */
export const BRASAO_ORIGEM_SHA256 = "7327dcacacf992a5e0438c867f65123978f00666b58328a14326fa739bd22d0c";

/** viewBox do path: a resolução do PNG de origem, sem reescala (sem perda). */
export const BRASAO_VIEWBOX = "0 0 1048 944";

/**
 * A proporção, já em número. Sai daqui em vez de ser reparseada do viewBox
 * porque com `noUncheckedIndexedAccess` cada índice de um split vira
 * `number | undefined` — e enfeitar o chamador com guardas para reaver um
 * dado que o gerador já tinha na mão é ruído, não segurança.
 */
export const BRASAO_LARGURA = 1048;
export const BRASAO_ALTURA = 944;

export const BRASAO_PATH =
  "M158 0L890 0L1047 216L1048 262L1045 302L1029 388L1012 443L996 484L970 539L949 577L892 664L823 751L763 817L701 879L630 944L418 944L360 891L293 825L205 727L142 644L105 587L74 531L40 454L16 376L3 302L0 263L0 218ZM189 58L58 237L62 305L76 376L103 455L136 524L194 617L265 708L341 791L441 886L608 886L715 783L779 713L847 627L898 549L940 467L969 387L986 305L990 256L989 235L860 58ZM823 97L829 97L832 100L900 195L643 194L559 850L481 851L409 196L148 195L221 99ZM111 242L369 242L444 848L320 717L281 672L233 609L182 527L153 467L129 398L119 347ZM687 242L939 242L939 285L936 311L929 336L779 337L758 452L898 452L898 455L866 519L833 570L735 571L715 670L753 670L755 672L652 794L599 849ZM229 349L228 354L236 385L252 428L276 477L294 506L275 349Z";

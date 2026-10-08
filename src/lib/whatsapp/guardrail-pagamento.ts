/** Guardrail pós-LLM: a Hígia NUNCA confirma pagamento por texto — quem confirma é o código. */

/** Detecta o modelo afirmando que um pagamento/reserva está confirmado. Recall priorizado:
 * falso-positivo apenas troca a frase por um pedido de comprovante (não escala).
 * Cobre substantivo+verbo, verbo+substantivo, confirmações curtas e coloquiais. */
export const RE_CONFIRMA = new RegExp(
  [
    "(pagamento|pix|comprovante|reserva)\s+(foi\s+|est[áa]\s+|já\s+)?(confirmad|aprovad|recebid|garantid|pag[oa])",
    "\b(recebi|confirmei|aprovei|validei)\b[^.!?\n]{0,25}\b(pix|pagamento|comprovante|reserva|valor)\b",
    "(^|[\n.!?]\s*)(confirmad[oa]|aprovad[oa])\s*[!.]",
    "\b(t[áa]|est[áa])\s+(tudo\s+)?(pag[oa]|confirmad[oa])\b",
    "\b(pix|pagamento)\b[^.!?\n]{0,15}\b(caiu|entrou|compensad[oa])\b",
    "\bquitad[oa]\b",
  ].join("|"),
  "iu"
);

export const PEDIR_COMPROVANTE =
  "Pra confirmar, me envia aqui o comprovante do Pix, tá? Pode ser print, imagem ou o PDF do banco. Assim que chegar eu confirmo na hora 🙏";

/**
 * Se o texto afirma confirmação de pagamento SEM que o código tenha confirmado, troca a frase
 * pelo pedido do comprovante real. Exceção: reserva paga por saldo de pacote/crédito É
 * confirmada de verdade — aí o texto passa intacto.
 */
export function aplicarGuardrailPagamento(
  texto: string,
  confirmadoPorSaldo: boolean
): { texto: string; violou: boolean } {
  if (RE_CONFIRMA.test(texto) && !confirmadoPorSaldo) {
    return { texto: PEDIR_COMPROVANTE, violou: true };
  }
  return { texto, violou: false };
}

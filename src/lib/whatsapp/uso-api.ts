/** Contabilidade de consumo da API por mensagem (base para acompanhar custo). */
export type UsoApi = { chamadas: number; entrada: number; saida: number; cacheEscrito: number; cacheLido: number };

/** Soma o consumo de uma chamada da API (o campo `usage` da resposta). */
export function contabilizar(uso: UsoApi, usage?: Record<string, number>): void {
  if (!usage) return;
  uso.chamadas += 1;
  uso.entrada += usage.input_tokens ?? 0;
  uso.saida += usage.output_tokens ?? 0;
  uso.cacheEscrito += usage.cache_creation_input_tokens ?? 0;
  uso.cacheLido += usage.cache_read_input_tokens ?? 0;
}


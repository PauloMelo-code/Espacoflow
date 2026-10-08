/**
 * Diagnóstico de CONSUMO da API da Anthropic: qual modelo está configurado, quanto a Hígia
 * conversou por dia e quantas chamadas cada mensagem custou. Serve para responder "por que o
 * consumo subiu" com dados, em vez de suposição.
 *
 * Uso:  npx tsx src/scripts/diagnostico-consumo.ts
 */
import "dotenv/config";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agenteConfig } from "@/lib/db/schema/agente";
import { whatsappMensagens } from "@/lib/db/schema/whatsapp";

async function main() {
  const [cfg] = await db
    .select({
      modelo: agenteConfig.modelo_ia,
      ativo: agenteConfig.ativo,
      resposta: agenteConfig.resposta_automatica,
      reservaIa: agenteConfig.reserva_via_ia,
      atualizado: agenteConfig.updated_at,
      prompt: agenteConfig.prompt_sistema,
    })
    .from(agenteConfig)
    .where(eq(agenteConfig.is_deleted, false))
    .limit(1);

  console.log("=== CONFIGURAÇÃO DO AGENTE ===");
  console.log(`modelo configurado : ${cfg?.modelo ?? "(padrão do código: claude-haiku-4-5)"}`);
  console.log(`ativo              : ${cfg?.ativo}`);
  console.log(`resposta automática: ${cfg?.resposta}`);
  console.log(`reserva via IA     : ${cfg?.reservaIa}`);
  console.log(`última alteração   : ${cfg?.atualizado?.toISOString() ?? "-"}`);
  console.log(`prompt customizado : ${cfg?.prompt ? `${cfg.prompt.length} caracteres` : "não (usa o do código)"}`);

  const dias = (await db.execute(sql`
    select date_trunc('day', created_at)::date as dia,
           count(*) filter (where origem = 'user')   as do_cliente,
           count(*) filter (where origem = 'higia')  as da_higia,
           count(distinct conversa_id)               as conversas
      from whatsapp_mensagens
     where is_deleted = false and created_at > now() - interval '45 days'
     group by 1 order by 1 desc
  `)) as unknown as Array<{ dia: Date; do_cliente: string; da_higia: string; conversas: string }>;

  console.log("\n=== VOLUME POR DIA (45 dias) ===");
  console.log("dia          msgs do cliente   respostas   conversas");
  for (const d of dias) {
    const data = new Date(d.dia).toISOString().slice(0, 10);
    console.log(
      `${data}   ${String(d.do_cliente).padStart(9)}   ${String(d.da_higia).padStart(9)}   ${String(d.conversas).padStart(9)}`
    );
  }

  // Cada mensagem do cliente dispara 1 chamada + até 6 do loop de ferramentas.
  const total = dias.reduce((a, d) => a + Number(d.do_cliente), 0);
  console.log(
    `\nMensagens de cliente no período: ${total}. Cada uma gera de 1 a 7 chamadas à API ` +
      `(loop de ferramentas), e TODA chamada reenvia o prompt do sistema + as ferramentas.`
  );

  const [recente] = await db
    .select({ n: sql<number>`count(*)` })
    .from(whatsappMensagens)
    .where(and(eq(whatsappMensagens.is_deleted, false), gt(whatsappMensagens.created_at, new Date(Date.now() - 86_400_000))));
  console.log(`Mensagens nas últimas 24h: ${recente?.n ?? 0}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("erro:", e);
  process.exit(1);
});

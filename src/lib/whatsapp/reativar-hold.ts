import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { reservas } from "@/lib/db/schema/reservas";

/**
 * RESSUSCITA holds expirados quando o cliente REALMENTE pagou. O hold dura 45 min; se o
 * pagamento vem depois (ou no dia seguinte), a reserva já foi cancelada e o comprovante não
 * tinha onde ser aplicado — o cliente ouvia "preciso confirmar com a equipe" e a reserva "não
 * era registrada" (relatório 25/09). Devolve a reserva quando o horário ainda está livre; se
 * alguém já pegou, a constraint anti-overbooking recusa e o caso vai para a equipe.
 */
export async function reativarHoldsExpirados(reservaIds: string[]): Promise<string[]> {
  if (reservaIds.length === 0) return [];
  const expiradas = await db
    .select({ id: reservas.id })
    .from(reservas)
    .where(
      and(
        inArray(reservas.id, reservaIds),
        eq(reservas.is_deleted, false),
        eq(reservas.status_reserva, "cancelada"),
        gt(reservas.fim_em, new Date()) // só faz sentido reativar o que ainda não passou
      )
    );
  const voltaram: string[] = [];
  for (const r of expiradas) {
    const ok = await db
      .update(reservas)
      .set({
        status_reserva: "pendente",
        updated_at: new Date(),
        notas_internas: sql`coalesce(${reservas.notas_internas} || ' | ', '') || 'Reativada: comprovante chegou após o hold expirar'`,
      })
      .where(and(eq(reservas.id, r.id), eq(reservas.status_reserva, "cancelada")))
      .returning({ id: reservas.id })
      .catch(() => [] as { id: string }[]); // 23P01 = horário já ocupado
    if (ok.length > 0) voltaram.push(ok[0].id);
  }
  return voltaram;
}

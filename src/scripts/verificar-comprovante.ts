/**
 * PROVA ponta a ponta: comprovante em PDF chega e a RESERVA FICA CONFIRMADA (paga).
 * Reproduz o caso dos relatórios 01/09, 03/09 e 08/09 do FLOW:
 *  - cliente recorrente com reserva PENDENTE aguardando Pix;
 *  - manda o comprovante em PDF (como PicPay/Nubank geram), não imagem;
 *  - escreve "Obrigado" depois (a mídia deixa de ser a última mensagem);
 *  - a EQUIPE responde manualmente antes (a conversa fica em atendimento humano).
 * Em todos esses casos a reserva DEVE terminar confirmada/paga. Se qualquer asserção falhar,
 * o bug NÃO está corrigido.
 *
 * Uso:  npx tsx src/scripts/verificar-comprovante.ts
 * Escreve dados de teste e faz SOFT DELETE deles no fim.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { clientes } from "@/lib/db/schema/clientes";
import { salas } from "@/lib/db/schema/salas";
import { reservas } from "@/lib/db/schema/reservas";
import { pagamentos } from "@/lib/db/schema/pagamentos";
import { whatsappConversas, whatsappMensagens } from "@/lib/db/schema/whatsapp";
import { agenteConfig } from "@/lib/db/schema/agente";
import { persistirMidiaBase64 } from "@/lib/storage/midia";
import { gerarRespostaHigia } from "@/lib/whatsapp/higia";
import { tipoRealDoArquivo } from "@/lib/documentos/tipo-arquivo";

let falhas = 0;
function assert(nome: string, cond: boolean, detalhe = "") {
  console.log(`${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
}

/** PDF mínimo válido (começa com %PDF-), suficiente para o teste de tipo/fluxo. */
function pdfFake(): Buffer {
  const corpo = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(corpo, "latin1");
}

async function main() {
  const suf = String(Date.now()).slice(-6);
  // DDD 00 nao existe: nenhuma mensagem real chega a ninguem se o envio for tentado.
  const telefone = `5500${suf}0`.slice(0, 13);

  // 0) O PDF é reconhecido pelo conteúdo (era aqui que o fix anterior falhava)
  const pdf = pdfFake();
  assert("PDF reconhecido pelos magic bytes", tipoRealDoArquivo(pdf) === "application/pdf", String(tipoRealDoArquivo(pdf)));

  // 1) Sobe o PDF como a ingestao faria. Se o MinIO estiver fora (dev), serve o PDF por um HTTP
  //    local so para o teste, provando a LOGICA em qualquer ambiente. Em PRODUCAO, MinIO fora
  //    significa comprovante sem URL utilizavel (limitacao conhecida).
  let url = await persistirMidiaBase64(pdf.toString("base64"), "document", "application/pdf");
  if (!url) console.log("  (MinIO indisponivel — o comprovante deve funcionar mesmo assim, pelo payload)");
  let servidor: ReturnType<typeof createServer> | null = null;
  if (!url) {
    servidor = createServer((_req, res) => {
      // De proposito SEM content-type de PDF: prova que o tipo vem do CONTEUDO.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(pdf);
    });
    await new Promise<void>((ok) => servidor!.listen(0, "127.0.0.1", () => ok()));
    const porta = (servidor.address() as { port: number }).port;
    url = `http://127.0.0.1:${porta}/midia/teste.bin`; // extensao .bin, como o MinIO salvava
    console.log(`  (MinIO off: servindo o PDF em ${url} para provar a logica)`);
  }

  const [cfg] = await db.select().from(agenteConfig).where(eq(agenteConfig.is_deleted, false)).limit(1);
  assert("agente ATIVO", !!cfg?.ativo, String(cfg?.ativo));
  assert("reserva via IA LIGADA (sem isso o comprovante nunca é lido)", !!cfg?.reserva_via_ia, String(cfg?.reserva_via_ia));

  const [sala] = await db.select().from(salas).where(eq(salas.is_deleted, false)).limit(1);
  assert("existe sala cadastrada", !!sala);
  if (!sala) process.exit(1);

  // 2) Cliente RECORRENTE + reserva PENDENTE aguardando Pix
  const [cli] = await db
    .insert(clientes)
    .values({ nome: `Teste Comprovante ${suf}`, telefone, origem: "whatsapp", status_lead: "cliente" })
    .returning();
  const inicio = new Date(Date.now() + 3 * 86_400_000);
  inicio.setHours(10, 0, 0, 0);
  const fim = new Date(inicio.getTime() + 60 * 60_000);
  const [res] = await db
    .insert(reservas)
    .values({
      cliente_id: cli.id,
      sala_id: sala.id,
      data: inicio.toISOString().slice(0, 10),
      hora: "10:00:00",
      duracao_min: 60,
      inicio_em: inicio,
      fim_em: fim,
      status_reserva: "pendente",
      status_pagamento: "pendente",
    })
    .returning();
  const [pg] = await db
    .insert(pagamentos)
    .values({
      cliente_id: cli.id,
      reserva_id: res.id,
      valor: "40.00",
      status: "pendente",
      provedor: "pix_manual",
      // Ordem da vida real: o pagamento nasce ANTES do comprovante chegar.
      created_at: new Date(Date.now() - 60_000),
    })
    .returning();
  assert("reserva criada PENDENTE aguardando Pix", res.status_pagamento === "pendente" && !!pg.id);

  // 3) Conversa em ATENDIMENTO HUMANO (a equipe respondeu manualmente) — era aqui que o
  //    fluxo do comprovante nem era alcançado.
  const [conv] = await db
    .insert(whatsappConversas)
    .values({ cliente_id: cli.id, status: "humano", ultima_mensagem_em: new Date(), nao_lidas: 0 })
    .returning();

  const t = (ms: number) => new Date(Date.now() + ms);
  await db.insert(whatsappMensagens).values([
    { conversa_id: conv.id, origem: "user", tipo: "text", conteudo: "quero reservar amanhã 10h", created_at: t(-50_000), enviada_em: t(-50_000) },
    { conversa_id: conv.id, origem: "higia", tipo: "text", conteudo: "Já segurei seu horário! Me manda o comprovante.", processada_por_higia: true, created_at: t(-40_000), enviada_em: t(-40_000) },
    // o COMPROVANTE em PDF
    {
      conversa_id: conv.id,
      origem: "user",
      tipo: "document",
      conteudo: "comprovante_picpay.pdf",
      midia_url: url,
      midia_tipo: "document",
      // Como chega de verdade: o arquivo vem em base64 NO PAYLOAD do webhook. A URL do
      // WhatsApp e ".enc" (criptografada) e a copia no MinIO pode nao existir.
      payload_bruto: { data: { message: { base64: pdf.toString("base64") } } },
      created_at: t(-30_000),
      enviada_em: t(-30_000),
    },
    // o cliente escreve depois (a mídia deixa de ser a última mensagem)
    { conversa_id: conv.id, origem: "user", tipo: "text", conteudo: "Obrigado!", created_at: t(-20_000), enviada_em: t(-20_000) },
    // a EQUIPE responde manualmente por último
    { conversa_id: conv.id, origem: "humano", tipo: "text", conteudo: "Disponha! Boa sessão.", created_at: t(-10_000), enviada_em: t(-10_000) },
  ]);

  // 4) Roda o fluxo REAL
  const r = await gerarRespostaHigia(conv.id);
  console.log(`\n[fluxo] enviada=${r.enviada} motivo=${r.motivo ?? "-"}`);

  // 5) A RESERVA precisa estar CONFIRMADA e PAGA
  const [depois] = await db.select().from(reservas).where(eq(reservas.id, res.id));
  const [pgDepois] = await db.select().from(pagamentos).where(eq(pagamentos.id, pg.id));
  assert("PAGAMENTO confirmado", pgDepois.status === "confirmado", pgDepois.status);
  assert("RESERVA marcada como PAGA", depois.status_pagamento === "pago", depois.status_pagamento);
  assert("RESERVA marcada como CONFIRMADA", depois.status_reserva === "confirmada", depois.status_reserva);
  assert("comprovante registrado no pagamento", pgDepois.comprovante_url === url);

  // 6) REGRESSÃO 10/09: mídia ANTIGA no histórico + mensagem de texto nova NÃO pode disparar
  //    "Recebi seu comprovante". Cria outra reserva pendente e um texto novo do cliente.
  const [res2] = await db
    .insert(reservas)
    .values({
      cliente_id: cli.id,
      sala_id: sala.id,
      data: inicio.toISOString().slice(0, 10),
      hora: "15:00:00",
      duracao_min: 60,
      inicio_em: new Date(inicio.getTime() + 5 * 3_600_000),
      fim_em: new Date(inicio.getTime() + 6 * 3_600_000),
      status_reserva: "pendente",
      status_pagamento: "pendente",
    })
    .returning();
  const [pg2] = await db
    .insert(pagamentos)
    .values({ cliente_id: cli.id, reserva_id: res2.id, valor: "40.00", status: "pendente", provedor: "pix_manual" })
    .returning();
  await db.update(whatsappConversas).set({ status: "higia" }).where(eq(whatsappConversas.id, conv.id));
  await db.insert(whatsappMensagens).values({
    conversa_id: conv.id,
    origem: "user",
    tipo: "text",
    conteudo: "Boa tarde, gostaria de reservar a sala 03 hoje das 19h as 22h.",
    created_at: new Date(),
    enviada_em: new Date(),
  });
  const r3 = await gerarRespostaHigia(conv.id);
  const [pg2Depois] = await db.select().from(pagamentos).where(eq(pagamentos.id, pg2.id));
  assert(
    "texto novo + mídia antiga NÃO vira comprovante",
    r3.motivo !== "comprovante escalado" && pg2Depois.status === "pendente",
    `${r3.motivo ?? "-"} / pagamento ${pg2Depois.status}`
  );

  // 7) HOLD EXPIRADO (relatório 25/09): o cliente paga DEPOIS dos 45 min (ou no dia seguinte).
  //    A reserva já foi cancelada; se o horário continua livre, ela TEM que voltar e confirmar.
  const ini3 = new Date(inicio.getTime() + 10 * 3_600_000);
  const [res3] = await db
    .insert(reservas)
    .values({
      cliente_id: cli.id,
      sala_id: sala.id,
      data: ini3.toISOString().slice(0, 10),
      hora: "20:00:00",
      duracao_min: 60,
      inicio_em: ini3,
      fim_em: new Date(ini3.getTime() + 3_600_000),
      status_reserva: "cancelada", // hold expirou
      status_pagamento: "pendente",
      origem: "higia",
      notas_internas: "Hold expirado (sem pagamento)",
    })
    .returning();
  const [pg3] = await db
    .insert(pagamentos)
    .values({
      cliente_id: cli.id,
      reserva_id: res3.id,
      valor: "40.00",
      status: "pendente",
      provedor: "pix_manual",
      created_at: new Date(Date.now() - 120_000),
    })
    .returning();
  const urlPdf3 = `http://127.0.0.1:0/x.pdf`; // não usada: o payload traz o arquivo
  await db.insert(whatsappMensagens).values({
    conversa_id: conv.id,
    origem: "user",
    tipo: "document",
    conteudo: "comprovante_atrasado.pdf",
    midia_url: urlPdf3,
    midia_tipo: "document",
    payload_bruto: { data: { message: { base64: pdf.toString("base64") } } },
    created_at: new Date(),
    enviada_em: new Date(),
  });
  await gerarRespostaHigia(conv.id);
  const [res3Depois] = await db.select().from(reservas).where(eq(reservas.id, res3.id));
  const [pg3Depois] = await db.select().from(pagamentos).where(eq(pagamentos.id, pg3.id));
  assert(
    "hold expirado + comprovante depois: RESERVA VOLTA e confirma",
    res3Depois.status_reserva === "confirmada" && pg3Depois.status === "confirmado",
    `reserva ${res3Depois.status_reserva} / pagamento ${pg3Depois.status}`
  );

  // 8) Anti-reuso: rodar de novo NÃO pode confirmar nada novo nem repetir
  const r2 = await gerarRespostaHigia(conv.id);
  assert("não reprocessa o mesmo comprovante", r2.motivo !== "pagamento confirmado (IA)", r2.motivo ?? "-");

  // Limpeza (soft delete — nunca físico)
  const agora = new Date();
  await db.update(pagamentos).set({ is_deleted: true, deleted_at: agora }).where(eq(pagamentos.cliente_id, cli.id));
  await db.update(reservas).set({ is_deleted: true, deleted_at: agora }).where(eq(reservas.cliente_id, cli.id));
  await db.update(whatsappMensagens).set({ is_deleted: true, deleted_at: agora }).where(eq(whatsappMensagens.conversa_id, conv.id));
  await db.update(whatsappConversas).set({ is_deleted: true, deleted_at: agora }).where(eq(whatsappConversas.id, conv.id));
  await db.update(clientes).set({ is_deleted: true, deleted_at: agora }).where(eq(clientes.id, cli.id));

  servidor?.close();

  console.log(
    falhas === 0
      ? "\n\x1b[32m✓ COMPROVANTE OK — PDF reconhecido, reserva confirmada e paga, mesmo em atendimento humano e com texto depois.\x1b[0m"
      : `\n\x1b[31m✗ ${falhas} FALHA(S) — o comprovante NÃO confirma a reserva.\x1b[0m`
  );
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("erro:", e);
  process.exit(1);
});

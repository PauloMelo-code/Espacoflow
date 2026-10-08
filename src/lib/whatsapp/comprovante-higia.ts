import { and, desc, eq, gt, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pagamentos } from "@/lib/db/schema/pagamentos";
import { reservas } from "@/lib/db/schema/reservas";
import { salas } from "@/lib/db/schema/salas";
import { clientes } from "@/lib/db/schema/clientes";
import { agenteConfig } from "@/lib/db/schema/agente";
import { whatsappConversas, whatsappMensagens } from "@/lib/db/schema/whatsapp";
import { lerComprovante, type LeituraComprovante } from "@/lib/documentos/ler-comprovante";
import { tipoRealDoArquivo } from "@/lib/documentos/tipo-arquivo";
import { sincronizarReserva } from "@/lib/google/calendar";
import { registrarAuditoria } from "@/lib/audit/logger";
import { hojeSaoPaulo } from "@/lib/reservas/disponibilidade";
import { ativarPacotePendentePorComprovante } from "@/lib/reservas/pacote-saldo";
import { formatarDataCurta, formatarHoraCurta } from "@/lib/utils";
import { getProvider } from "./provider";
import { enviarHumanizado } from "./humanizar";
import { enviarBoasVindas } from "./boas-vindas";
import { resumoReservaTexto } from "./resumo-reserva";
import { reativarHoldsExpirados } from "./reativar-hold";
import { midiaEhComprovante, comprovanteJaUsado, extrairBase64DoPayload } from "./comprovante-midia";

export interface ResultadoComprovante {
  tratou: boolean; // true = era comprovante e nós tratamos (não cai no LLM)
  enviada?: boolean;
  confirmada?: boolean;
}

// Regras puras/consultas sobre a MÍDIA do comprovante ficam em módulo próprio (arquivo < 500
// linhas e separação regra x orquestração); reexportadas para não quebrar quem já importa daqui.
export { midiaEhComprovante, acharComprovanteNovo, comprovanteJaUsado, type MsgHistorico } from "./comprovante-midia";

function normalizar(s?: string | null): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos (diacríticos combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** O comprovante foi para a conta do espaço? (favorecido bate com o beneficiário Pix). */
function favorecidoConfere(favorecido: string | null, beneficiario?: string | null): boolean {
  const ben = normalizar(beneficiario);
  const fav = normalizar(favorecido);
  if (!ben || !fav) return false; // sem beneficiário cadastrado ou sem favorecido lido → não confirma
  if (fav.includes(ben) || ben.includes(fav)) return true;
  const tokensBen = ben.split(" ").filter((t) => t.length >= 3);
  const tokensFav = new Set(fav.split(" "));
  return tokensBen.filter((t) => tokensFav.has(t)).length >= 2; // ao menos 2 nomes batem
}

/** Data do comprovante é claramente antiga (> 2 dias)? Só reprova se conseguir ler a data. */
function dataAntiga(data: string | null): boolean {
  if (!data) return false;
  let iso: string | null = null;
  let m = data.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
  else {
    m = data.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) iso = `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (!iso) return false;
  const d1 = new Date(`${iso}T00:00:00-03:00`).getTime();
  const d0 = new Date(`${hojeSaoPaulo()}T00:00:00-03:00`).getTime();
  if (Number.isNaN(d1)) return false;
  return Math.abs(d0 - d1) / 86_400_000 > 2;
}

/** Anti-reuso: o id da transação já foi usado para confirmar OUTRO pagamento? */
async function idTransacaoJaUsado(idTx: string | null, pgId: string): Promise<boolean> {
  if (!idTx) return false;
  const [r] = await db
    .select({ id: pagamentos.id })
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.id_externo, idTx),
        eq(pagamentos.status, "confirmado"),
        eq(pagamentos.is_deleted, false),
        ne(pagamentos.id, pgId)
      )
    )
    .limit(1);
  return Boolean(r);
}

function obsLeitura(l: LeituraComprovante): string {
  return [
    l.instituicao,
    l.favorecido ? `favorecido ${l.favorecido}` : null,
    l.id_transacao ? `id ${l.id_transacao}` : null,
    l.e_pix ? "Pix" : null,
    l.confianca ? `confiança ${l.confianca}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Envia a resposta da Hígia (humanizada) e persiste como mensagem da conversa. */
async function responder(conversaId: string, telefone: string, texto: string): Promise<boolean> {
  const provider = getProvider();
  const r = await enviarHumanizado(provider, telefone, texto, {
    onBloco: async (bloco, idExterno, ok) => {
      await db.insert(whatsappMensagens).values({
        conversa_id: conversaId,
        origem: "higia",
        tipo: "text",
        conteudo: bloco,
        status: ok ? "sent" : "failed",
        processada_por_higia: true,
        enviada_em: new Date(),
        id_externo: idExterno ?? null,
      });
    },
  });
  await db
    .update(whatsappConversas)
    .set({ ultima_mensagem_em: new Date() })
    .where(eq(whatsappConversas.id, conversaId));
  return r.algumOk;
}

/** Envia UMA mensagem intacta (sem picar) — para blocos formatados (resumo da reserva). */
async function responderUnico(conversaId: string, telefone: string, texto: string): Promise<boolean> {
  const provider = getProvider();
  await provider.definirPresenca(telefone, "composing").catch(() => undefined);
  const envio = await provider.enviarTexto(telefone, texto);
  await db.insert(whatsappMensagens).values({
    conversa_id: conversaId,
    origem: "higia",
    tipo: "text",
    conteudo: texto,
    status: envio.ok ? "sent" : "failed",
    processada_por_higia: true,
    enviada_em: new Date(),
    id_externo: envio.idExterno ?? null,
  });
  await db
    .update(whatsappConversas)
    .set({ ultima_mensagem_em: new Date() })
    .where(eq(whatsappConversas.id, conversaId));
  return envio.ok;
}

/** Resumo da reserva no layout do espaço (data, sala, início, término, horas, confirmada). */

/**
 * Processa um comprovante enviado pelo CLIENTE no chat. A validação é feita em
 * CÓDIGO (não pelo LLM): só confirma automaticamente quando bate 100% — Pix, alta
 * confiança, valor exato da reserva, favorecido = conta do espaço, data recente e
 * comprovante não reutilizado. Qualquer divergência → escala para a equipe.
 */
export async function processarComprovanteHigia(params: {
  conversaId: string;
  clienteId: string;
  telefone: string;
  midiaUrl: string;
  /** "image" | "document" — documento só confirma se o arquivo for PDF de verdade. */
  tipoMidia?: string;
  /** quando o cliente mandou a mídia — só quita pagamento criado ANTES disso. */
  midiaEnviadaEm?: Date;
  /** payload cru do webhook — traz o arquivo em base64 (dispensa baixar a mídia). */
  payloadBruto?: unknown;
}): Promise<ResultadoComprovante> {
  // ANTI-REUSO: a busca pega a mídia mais recente do cliente, então um comprovante JÁ usado
  // não pode confirmar uma reserva nova (nem ser reprocessado num retry do job).
  if (await comprovanteJaUsado(params.midiaUrl)) return { tratou: false };

  // TODOS os pagamentos pendentes vinculados a reservas (o lote aguardando Pix) —
  // um comprovante único costuma quitar várias sessões agendadas na mesma conversa.
  const pendentesTodos = await db
    .select()
    .from(pagamentos)
    .where(
      and(
        eq(pagamentos.cliente_id, params.clienteId),
        eq(pagamentos.is_deleted, false),
        inArray(pagamentos.status, ["pendente", "em_analise"]),
        isNotNull(pagamentos.reserva_id)
      )
    )
    .orderBy(desc(pagamentos.created_at));

  // FRONTEIRA: o comprovante só quita pagamento que já existia quando ele foi enviado. Sem
  // isso, uma mídia anterior à reserva poderia dar como paga uma reserva criada depois dela.
  const pendentes = params.midiaEnviadaEm
    ? pendentesTodos.filter((pg) => pg.created_at.getTime() <= params.midiaEnviadaEm!.getTime())
    : pendentesTodos;
  if (pendentes.length === 0) {
    // SEM reserva pendente → este comprovante pode ser de uma COMPRA DE PACOTE. Só tratamos
    // pacote AQUI (não antes) para nunca ativar um pacote não pago com o print de uma reserva:
    // se houver reserva pendente, ela tem prioridade e é validada no fluxo abaixo.
    const pacote = await ativarPacotePendentePorComprovante(params.clienteId).catch(() => ({ ativado: false as const }));
    if (pacote.ativado) {
      const enviada = await responder(
        params.conversaId,
        params.telefone,
        `Pagamento do pacote confirmado! ✅ Seu *${pacote.pacoteNome}* está ativo com *${pacote.horas}h* de saldo. Quando quiser reservar usando o saldo, é só me chamar 🙌`
      );
      return { tratou: true, enviada, confirmada: true };
    }
    // Sem pagamento pendente. Se o cliente acabou de pagar e REENVIOU o print (caso
    // comum), responde idempotente em vez de deixar o LLM/guardrail pedir o comprovante
    // de novo a quem já foi confirmado.
    const corte2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [confirmadoRecente] = await db
      .select({ id: pagamentos.id })
      .from(pagamentos)
      .where(
        and(
          eq(pagamentos.cliente_id, params.clienteId),
          eq(pagamentos.is_deleted, false),
          eq(pagamentos.status, "confirmado"),
          isNotNull(pagamentos.reserva_id),
          gt(pagamentos.validado_em, corte2h)
        )
      )
      .limit(1);
    if (confirmadoRecente) {
      const enviada = await responder(
        params.conversaId,
        params.telefone,
        "Sua reserva já está confirmada ✅ Tá tudo certo, pode ficar tranquila(o). Te espero no horário combinado 🙌"
      );
      return { tratou: true, enviada, confirmada: true };
    }
    return { tratou: false }; // nada aguardando Pix → não é o fluxo
  }

  const ids = pendentes.map((p) => p.id);
  const reservaIds = pendentes.map((p) => p.reserva_id).filter((x): x is string => Boolean(x));
  const totalEsperado = pendentes.reduce((acc, p) => acc + (p.valor != null ? Number(p.valor) : 0), 0);

  // Lê o comprovante (best-effort) — APENAS para registro/auditoria. Por decisão do
  // espaço, a confirmação é DIRETA após o envio do comprovante (o cliente assume o
  // risco); a leitura não bloqueia — só gera a marca "confere?" para a equipe revisar.
  let base64 = "";
  let mediaType = "";
  // 1º) o ARQUIVO que veio no próprio webhook (base64 já descriptografado). É o caminho
  // confiável: a URL do WhatsApp é ".enc" (criptografada) e a cópia no MinIO pode não existir.
  const doPayload = extrairBase64DoPayload(params.payloadBruto);
  if (doPayload) {
    base64 = doPayload;
    mediaType = tipoRealDoArquivo(Buffer.from(doPayload, "base64")) || "";
  }
  try {
    if (base64) throw new Error("já temos o arquivo do payload");
    // Timeout: sem isso um MinIO/CDN pendurado segura o job da fila no caminho da confirmação.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(params.midiaUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      // Tipo pelo CONTEUDO (magic bytes). A midia e re-hospedada com extensao/MIME genericos
      // ("document" -> .bin + application/octet-stream), entao nem o header nem a URL revelam
      // que e um PDF; e um PNG chegava aqui rotulado image/jpeg, o que a API do modelo recusa.
      mediaType = tipoRealDoArquivo(buf) || res.headers.get("content-type")?.split(";")[0] || "";
      base64 = buf.toString("base64");
    }
  } catch {
    // ignora falha de download — segue confirmando mesmo assim (política do espaço)
  }

  // DOCUMENTO só vale como comprovante se for PDF (é o que PicPay/bancos geram). Um .docx,
  // .xlsx ou zip qualquer NÃO pode confirmar reserva — nesse caso devolve o fluxo para a
  // Hígia pedir o comprovante certo, em vez de dar a reserva como paga.
  if (!midiaEhComprovante(params.tipoMidia, mediaType, params.midiaUrl)) return { tratou: false };

  const leitura = base64 ? await lerComprovante(base64, mediaType).catch(() => null) : null;

  // Marca informativa "confere?" (não bloqueia): valor (vs total do lote)/Pix/favorecido/data/anti-reuso.
  const [cfg] = await db.select().from(agenteConfig).where(eq(agenteConfig.is_deleted, false)).limit(1);
  const motivos: string[] = [];
  if (!leitura) {
    motivos.push("comprovante não lido");
  } else {
    if (leitura.e_pix !== true) motivos.push("não identificado como Pix");
    if (leitura.confianca !== "alta") motivos.push("leitura sem alta confiança");
    if (!(leitura.valor != null && totalEsperado > 0 && Math.abs(leitura.valor - totalEsperado) < 0.01)) {
      motivos.push("valor diverge do total");
    }
    if (!favorecidoConfere(leitura.favorecido, cfg?.pix_beneficiario)) motivos.push("favorecido diverge");
    if (dataAntiga(leitura.data)) motivos.push("data não recente");
    if (await idTransacaoJaUsado(leitura.id_transacao, ids[0])) motivos.push("id reutilizado");
  }
  const confere = motivos.length === 0;

  // Registra o comprovante + a leitura em TODOS os pagamentos do lote (para a equipe consultar).
  await db
    .update(pagamentos)
    .set({
      comprovante_url: params.midiaUrl,
      comprovante_recebido: true,
      leitura_confere: confere,
      ...(leitura
        ? {
            valor_lido: leitura.valor != null ? String(leitura.valor) : null,
            pagador_lido: leitura.pagador,
            data_lida: leitura.data,
            leitura_obs: obsLeitura(leitura),
            leitura_em: new Date(),
          }
        : {}),
      updated_at: new Date(),
    })
    .where(inArray(pagamentos.id, ids));

  // Só confirma reservas ainda VIVAS (pendente/rascunho). Sem este filtro, um comprovante
  // que chega depois de a reserva ser cancelada a "ressuscitaria" para confirmada — e, se
  // o horário já foi re-reservado, colidiria com a constraint de overbooking, derrubando
  // a transação inteira.
  const vivas = reservaIds.length
    ? await db
        .select({ id: reservas.id })
        .from(reservas)
        .where(
          and(
            inArray(reservas.id, reservaIds),
            eq(reservas.is_deleted, false),
            inArray(reservas.status_reserva, ["pendente", "rascunho"])
          )
        )
    : [];
  let reservaIdsOk = vivas.map((v) => v.id);

  // Hold expirado + comprovante depois: devolve a reserva se o horário ainda estiver livre.
  if (reservaIdsOk.length === 0 && reservaIds.length > 0) {
    reservaIdsOk = await reativarHoldsExpirados(reservaIds);
  }

  const idsOk = pendentes.filter((p) => p.reserva_id && reservaIdsOk.includes(p.reserva_id)).map((p) => p.id);
  // Pagamentos do MESMO comprovante cuja reserva não está mais ativa (lote misto):
  // não somem em silêncio — vão para em_análise + auditoria (a equipe verifica).
  const idsMortos = ids.filter((id) => !idsOk.includes(id));

  // Cliente é NOVO se ainda não é "cliente" E não tem outra reserva confirmada/concluída
  // fora deste lote. (Calculado ANTES da transação que confirma o lote.) Só cliente novo
  // recebe o onboarding/boas-vindas. Checar status_lead="cliente" cobre o caso de quem já
  // confirmou uma reserva antes e depois CANCELOU (continua sendo cliente — não é "novo").
  const [cliRow] = await db
    .select({ status: clientes.status_lead })
    .from(clientes)
    .where(and(eq(clientes.id, params.clienteId), eq(clientes.is_deleted, false)));
  const [outraConfirmada] =
    reservaIdsOk.length > 0
      ? await db
          .select({ id: reservas.id })
          .from(reservas)
          .where(
            and(
              eq(reservas.cliente_id, params.clienteId),
              eq(reservas.is_deleted, false),
              inArray(reservas.status_reserva, ["confirmada", "concluida"]),
              notInArray(reservas.id, reservaIdsOk)
            )
          )
          .limit(1)
      : [];
  const clienteNovo = cliRow?.status !== "cliente" && !outraConfirmada;

  if (reservaIdsOk.length === 0) {
    // Comprovante sem reserva ativa correspondente (cancelada/expirada) — não confirma às
    // cegas nem promete "garantida"; manda para em_análise e registra para a equipe.
    await db
      .update(pagamentos)
      .set({ status: "em_analise", updated_at: new Date() })
      .where(inArray(pagamentos.id, ids));
    await registrarAuditoria({
      acao: "validar_pix",
      entidade: "pagamentos",
      registroId: ids[0],
      severidade: "warn",
      detalhes: "Comprovante recebido, mas a(s) reserva(s) vinculada(s) não estão mais ativas (canceladas/expiradas) — verificar manualmente.",
    }).catch(() => undefined);
    const enviada = await responder(
      params.conversaId,
      params.telefone,
      "Recebi seu comprovante 🙏 Preciso confirmar um detalhe da sua reserva com a equipe e já te retorno por aqui, tá?"
    );
    return { tratou: true, enviada, confirmada: false };
  }

  // ===== Confirma DIRETO o lote ainda válido (decisão do espaço; sem etapa da equipe). =====
  // Guarda de corrida: a confirmação SÓ vale se ESTE processo flipou os pagamentos de
  // pendente/em_análise → confirmado (predicado de status + returning). No modo inline
  // (sem worker) dois prints quase simultâneos disparam duas execuções; a 2ª encontra 0
  // linhas para flipar → NÃO reenvia confirmação/resumo/boas-vindas (sem duplicar no chat).
  const confirmados = await db.transaction(async (tx) => {
    const flip = await tx
      .update(pagamentos)
      .set({
        status: "confirmado",
        pago_em: new Date(),
        validado_em: new Date(),
        ...(leitura?.id_transacao ? { id_externo: leitura.id_transacao } : {}),
        // validado_por null = confirmado automaticamente pela Hígia (decisão do espaço).
        updated_at: new Date(),
      })
      .where(
        and(
          inArray(pagamentos.id, idsOk),
          eq(pagamentos.is_deleted, false), // hold expirado solta o pagamento (soft delete) → não confirma
          inArray(pagamentos.status, ["pendente", "em_analise"])
        )
      )
      .returning({ id: pagamentos.id });
    if (flip.length === 0) return [] as { id: string }[]; // outra execução já confirmou / hold expirou
    await tx
      .update(reservas)
      .set({ status_pagamento: "pago", status_reserva: "confirmada", updated_at: new Date() })
      // Só confirma reservas AINDA vivas — não ressuscita um hold que o job de expiração cancelou.
      .where(and(inArray(reservas.id, reservaIdsOk), inArray(reservas.status_reserva, ["pendente", "rascunho"])));
    if (idsMortos.length) {
      await tx
        .update(pagamentos)
        .set({ status: "em_analise", updated_at: new Date() })
        .where(inArray(pagamentos.id, idsMortos));
    }
    // Promove a "cliente" após a 1ª reserva confirmada — só se já houve aceite da
    // política (cadastro). Garante "cadastro + aceite ANTES da mudança de status".
    await tx
      .update(clientes)
      .set({ status_lead: "cliente", updated_at: new Date() })
      .where(
        and(
          eq(clientes.id, params.clienteId),
          eq(clientes.is_deleted, false),
          ne(clientes.status_lead, "cliente"),
          isNotNull(clientes.aceitou_politica_em)
        )
      );
    return flip;
  });

  if (confirmados.length === 0) {
    // Corrida no modo inline: outra execução concorrente já confirmou este mesmo lote e
    // está enviando a confirmação/resumo/boas-vindas. Aqui não duplicamos nada.
    return { tratou: true, enviada: false, confirmada: true };
  }

  await registrarAuditoria({
    acao: "validar_pix",
    entidade: "pagamentos",
    registroId: idsOk[0],
    severidade: confere ? "info" : "warn",
    detalhes: `Confirmado direto após comprovante (decisão do espaço): ${reservaIdsOk.length} reserva(s). ${
      confere ? `Leitura confere: ${leitura ? obsLeitura(leitura) : "—"}` : `DIVERGÊNCIA na leitura: ${motivos.join("; ")}`
    }`,
  }).catch(() => undefined);

  if (idsMortos.length) {
    await registrarAuditoria({
      acao: "validar_pix",
      entidade: "pagamentos",
      registroId: idsMortos[0],
      severidade: "warn",
      detalhes: `Comprovante cobre ${idsMortos.length} pagamento(s) de reserva(s) que não estão mais ativas — marcados em análise para a equipe verificar.`,
    }).catch(() => undefined);
  }

  for (const rid of reservaIdsOk) await sincronizarReserva(rid).catch(() => undefined);

  // Detalhes das reservas confirmadas (para o resumo formatado e o onboarding).
  const detalhes = await db
    .select({
      id: reservas.id,
      data: reservas.data,
      duracao_min: reservas.duracao_min,
      inicio_em: reservas.inicio_em,
      fim_em: reservas.fim_em,
      sala_id: reservas.sala_id,
      sala: salas.nome,
    })
    .from(reservas)
    .innerJoin(salas, eq(reservas.sala_id, salas.id))
    .where(inArray(reservas.id, reservaIdsOk));

  // 1) Recebimento do comprovante. NÃO afirma "pagamento confirmado" (quem valida o
  // pagamento é o sistema/equipe); o resumo abaixo confirma a RESERVA.
  const enviada = await responder(params.conversaId, params.telefone, "Recebi seu comprovante! 🙏");
  // 2) Resumo formatado de cada reserva (mensagem única, no layout do espaço).
  for (const d of detalhes) {
    await responderUnico(params.conversaId, params.telefone, resumoReservaTexto(d));
  }
  // 3) Boas-vindas / onboarding com instruções de acesso — SÓ para cliente novo (1ª
  // reserva confirmada), uma vez por sala. Recorrente não recebe de novo.
  if (clienteNovo) {
    const salasEnviadas = new Set<string>();
    for (const d of detalhes) {
      if (salasEnviadas.has(d.sala_id)) continue;
      salasEnviadas.add(d.sala_id);
      await enviarBoasVindas(d.id, params.conversaId, params.telefone);
    }
  }
  return { tratou: true, enviada, confirmada: true };
}

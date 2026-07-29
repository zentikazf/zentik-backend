import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../../database/prisma.service';
import {
  ClientBillingService,
  CycleDto,
  CycleTransactionLine,
} from './client-billing.service';

// Zona del negocio (es-PY). Los instantes (emisión, corte, anulación) se muestran en esta zona;
// los montos usan Intl es-PY con 0 decimales (PYG), idéntico al `formatCurrency` del frontend.
const ASUNCION_TZ = 'America/Asuncion';

// ── Formatters es-PY (puros, reutilizados por buildInvoiceModel y los tests) ──────────────

/** Montos como el `formatCurrency` del front (zentik/src/lib/utils.ts): Intl es-PY, 0 decimales. */
export function fmtMoney(amount: string | null | undefined, currency: string): string {
  if (amount == null) return '—';
  const num = parseFloat(amount);
  if (Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: currency || 'PYG',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

/** Fecha de un INSTANTE en la zona del negocio: '28 jul 2026' (evita el day-shift por TZ). */
export function fmtDateAsuncion(date: Date | null | undefined): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('es-PY', {
    timeZone: ASUNCION_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Clave 'YYYY-MM' del mes de Asunción de un instante (igual criterio que asuncionPeriodKey). */
export function monthKeyAsuncion(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ASUNCION_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${y}-${m}`;
}

/** 'YYYY-MM' → 'Julio 2026' (es-PY, capitalizado), igual que el monthLabel del servicio de billing. */
export function monthLabelEs(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  const label = new Intl.DateTimeFormat('es-PY', { month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ── Modelo intermedio (todo pre-formateado): separa el "qué dibujar" (puro, testeable)
//    del "cómo dibujar" (pdfkit). Los tests verifican este modelo sin parsear el binario. ──────

export interface InvoiceLine {
  concepto: string;
  tipo: string;
  horas: string;
  tarifa: string;
  monto: string;
}

export interface InvoiceGroup {
  label: string;
  showHeader: boolean; // solo se muestra el encabezado del mes cuando hay desglose (>1 grupo)
  subtotal: string;
  horas: string;
  lines: InvoiceLine[];
}

export interface InvoiceModel {
  orgName: string;
  supportEmail: string | null;
  invoiceNumber: string;
  kind: string; // MONTH | ACCUMULATED
  emittedAt: string;
  clientName: string;
  periodLabel: string;
  cutoffLabel: string | null;
  cancelled: { reason: string; at: string | null } | null;
  groups: InvoiceGroup[];
  totalHoras: string;
  totalMonto: string;
  currency: string;
  docTitle?: string; // default 'FACTURA'; NC pasa 'NOTA DE CRÉDITO'
  referenceLine?: string; // NC: 'Aplica a FAC-YYYY-NNNNN'
}

/**
 * Arma el modelo de la factura desde el snapshot congelado (`getCycleTransactions`) + nombre del
 * cliente + datos de la agencia. Puro y determinístico: sin pdfkit, sin I/O. El período se deriva del
 * mes de Asunción de periodStart y del corte (cutoffDate ?? periodEnd) — TZ-safe, sin off-by-one de mes.
 */
export function buildInvoiceModel(input: {
  cycle: CycleDto;
  clientName: string;
  org: { name: string | null; supportEmail: string | null } | null;
  transactions: CycleTransactionLine[];
  grupos: Array<{ workedMonth: string; label: string; subtotal: string; horas: number }>;
}): InvoiceModel {
  const { cycle, clientName, org, transactions, grupos } = input;
  const currency = cycle.currency;

  const startKey = monthKeyAsuncion(cycle.periodStart);
  const endKey = monthKeyAsuncion(cycle.cutoffDate ?? cycle.periodEnd);
  const periodLabel =
    startKey === endKey
      ? monthLabelEs(startKey)
      : `${monthLabelEs(startKey)} – ${monthLabelEs(endKey)}`;

  // #23: si la factura estampó variables, se muestra una sección "Variables" (Gs convertidos) además de
  //   Soporte, y se etiquetan TODAS las secciones (aunque el soporte sea de un solo mes) para distinguirlas.
  const stamp = cycle.variablesBilling;
  const hasVars = !!stamp && stamp.lines.length > 0;
  const multi = grupos.length > 1 || hasVars;
  const groups: InvoiceGroup[] = grupos
    .map((g) => {
      const lines: InvoiceLine[] = transactions
        .filter((t) =>
          g.workedMonth === 'sin-fecha' ? t.workedMonth === null : t.workedMonth === g.workedMonth,
        )
        .map((t) => ({
          concepto: t.task?.title ?? t.note ?? '—',
          tipo: t.type === 'LOAN' ? 'Fuera de cupo' : 'Soporte',
          horas: `${t.hours.toFixed(2)}h`,
          tarifa: fmtMoney(t.priceRate, currency),
          monto: fmtMoney(t.priceAmount, currency),
        }));
      return {
        label: g.label,
        showHeader: multi,
        subtotal: fmtMoney(g.subtotal, currency),
        horas: `${g.horas.toFixed(2)}h`,
        lines,
      };
    })
    .filter((grp) => grp.lines.length > 0);

  if (hasVars && stamp) {
    groups.push({
      label: `Variables (Botmaker) — 1 USD ≈ ${fmtMoney(stamp.rate, currency)} (${fmtDateAsuncion(new Date(stamp.rateDate))})`,
      showHeader: true,
      subtotal: fmtMoney(stamp.amountPyg, currency),
      horas: `${stamp.lines.length} ítem(s)`,
      lines: stamp.lines.map((l) => ({
        concepto: l.label,
        tipo: 'Variable',
        horas: '—',
        tarifa: `US$ ${l.commercialUsd}`,
        monto: fmtMoney(l.convertedPyg, currency),
      })),
    });
  }

  return {
    orgName: org?.name ?? 'Organización',
    supportEmail: org?.supportEmail ?? null,
    invoiceNumber: cycle.invoiceNumber,
    kind: cycle.kind,
    emittedAt: fmtDateAsuncion(cycle.closedAt ?? cycle.createdAt),
    clientName,
    periodLabel,
    cutoffLabel: cycle.cutoffDate ? fmtDateAsuncion(cycle.cutoffDate) : null,
    cancelled:
      cycle.status === 'CANCELLED'
        ? {
            reason: cycle.cancelReason?.trim() || 'Sin motivo especificado',
            at: cycle.cancelledAt ? fmtDateAsuncion(cycle.cancelledAt) : null,
          }
        : null,
    groups,
    totalHoras: `${cycle.totalHours.toFixed(2)}h`,
    totalMonto: fmtMoney(cycle.totalAmount, currency),
    currency,
  };
}

// ── H9b: Nota de crédito ────────────────────────────────────────────────────

/** Mes de pertenencia 'YYYY-MM' de un workedOn (@db.Date, UTC-midnight). Partes UTC, NO TZ (patrón workedMonthKey del service). */
function creditWorkedMonthKey(workedOn: Date): string {
  return `${workedOn.getUTCFullYear()}-${String(workedOn.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface CreditNoteModelInput {
  creditNote: {
    number: string;
    reason: string;
    currency: string;
    totalAmount: Prisma.Decimal; // NEGATIVO (efecto neto)
    totalHours: number; // NEGATIVO
    issuedAt: Date;
    createdAt: Date;
    appliesTo: { invoiceNumber: string };
  };
  lines: Array<{
    hours: number; // POSITIVO (snapshot fiel)
    priceAmount: Prisma.Decimal; // POSITIVO (snapshot fiel)
    priceRate: Prisma.Decimal | null;
    priceCurrency: string | null;
    workedOn: Date | null;
    description: string | null;
  }>;
  clientName: string;
  org: { name: string | null; supportEmail: string | null } | null;
}

/**
 * H9b: arma el MISMO `InvoiceModel` para una nota de crédito, con `docTitle`/`referenceLine` seteados y
 * TODOS los montos/horas en NEGATIVO (las líneas guardan positivo → se niegan para presentar; los totales
 * ya vienen negativos de la tabla). Sin banda ANULADA. Reusa la lógica de agrupación por mes-de-trabajo.
 */
export function buildCreditNoteModel(input: CreditNoteModelInput): InvoiceModel {
  const { creditNote, lines, clientName, org } = input;
  const currency = creditNote.currency;

  // Agrupa por mes-de-trabajo (partes UTC de workedOn; null → 'sin-fecha').
  const buckets = new Map<string, { subtotal: Prisma.Decimal; horas: number; lines: InvoiceLine[] }>();
  for (const l of lines) {
    const key = l.workedOn ? creditWorkedMonthKey(l.workedOn) : 'sin-fecha';
    const b = buckets.get(key) ?? { subtotal: new Prisma.Decimal(0), horas: 0, lines: [] };
    b.subtotal = b.subtotal.plus(l.priceAmount);
    b.horas += l.hours;
    b.lines.push({
      concepto: l.description ?? '—',
      tipo: 'Crédito',
      horas: `${(-l.hours).toFixed(2)}h`, // NEGATIVO (presentación)
      tarifa: fmtMoney(l.priceRate != null ? l.priceRate.toString() : null, currency),
      monto: fmtMoney(l.priceAmount.negated().toString(), currency), // NEGATIVO
    });
    buckets.set(key, b);
  }

  const keys = [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const multi = keys.length > 1;
  const groups: InvoiceGroup[] = keys.map((key) => {
    const b = buckets.get(key)!;
    return {
      label: key === 'sin-fecha' ? 'Sin fecha' : monthLabelEs(key),
      showHeader: multi,
      subtotal: fmtMoney(b.subtotal.negated().toString(), currency), // NEGATIVO
      horas: `${(-b.horas).toFixed(2)}h`,
      lines: b.lines,
    };
  });

  // Período: rango de meses reales tocados (excluye 'sin-fecha'); fallback al mes de emisión.
  const realKeys = keys.filter((k) => k !== 'sin-fecha');
  let periodLabel: string;
  if (realKeys.length === 0) {
    periodLabel = monthLabelEs(monthKeyAsuncion(creditNote.issuedAt));
  } else {
    const startKey = realKeys[0];
    const endKey = realKeys[realKeys.length - 1];
    periodLabel = startKey === endKey ? monthLabelEs(startKey) : `${monthLabelEs(startKey)} – ${monthLabelEs(endKey)}`;
  }

  return {
    orgName: org?.name ?? 'Organización',
    supportEmail: org?.supportEmail ?? null,
    invoiceNumber: creditNote.number,
    kind: 'CREDIT_NOTE', // no ACCUMULATED → no dibuja "Factura acumulada"
    emittedAt: fmtDateAsuncion(creditNote.issuedAt ?? creditNote.createdAt),
    clientName,
    periodLabel,
    cutoffLabel: null,
    cancelled: null, // D3: sin banda ANULADA en v1
    groups,
    totalHoras: `${creditNote.totalHours.toFixed(2)}h`, // ya NEGATIVO
    totalMonto: fmtMoney(creditNote.totalAmount.toString(), currency), // ya NEGATIVO
    currency,
    docTitle: 'NOTA DE CRÉDITO',
    referenceLine: `Aplica a ${creditNote.appliesTo.invoiceNumber}`,
  };
}

/**
 * Logo de la agencia SOLO como data-URI PNG/JPEG (embebible por pdfkit, sin red). Decisión
 * deliberada: NO se hace fetch de URLs remotas desde el generador de un documento financiero
 * (postura anti-SSRF + robustez). Si el logo es una URL, se muestra solo el nombre de la agencia.
 */
export function loadLogoDataUri(logo: string | null | undefined): Buffer | null {
  if (!logo || !logo.startsWith('data:image/')) return null;
  const comma = logo.indexOf(',');
  if (comma === -1) return null;
  const meta = logo.slice(5, comma); // p.ej. "image/png;base64"
  if (!/^image\/(png|jpe?g);base64$/i.test(meta)) return null;
  try {
    const buf = Buffer.from(logo.slice(comma + 1), 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

@Injectable()
export class ClientBillingPdfService {
  private readonly logger = new Logger(ClientBillingPdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: ClientBillingService,
  ) {}

  /**
   * Genera el PDF de una factura (ClientBillingCycle). Reusa el snapshot congelado
   * `getCycleTransactions` (scopeado por org/cliente/ciclo; lanza 404 si no existe) + query de
   * cliente/agencia. Devuelve el Buffer y el nombre de archivo (FAC-YYYY-NNNNN.pdf) para el header.
   */
  async generateInvoicePdf(
    orgId: string,
    clientId: string,
    cycleId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const { cycle, transactions, grupos } = await this.billing.getCycleTransactions(
      orgId,
      clientId,
      cycleId,
    );

    const [client, org] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: clientId }, select: { name: true } }),
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, logo: true, supportEmail: true },
      }),
    ]);

    const model = buildInvoiceModel({
      cycle,
      clientName: client?.name ?? 'Cliente',
      org: org ? { name: org.name, supportEmail: org.supportEmail } : null,
      transactions,
      grupos,
    });

    const buffer = await this.render(model, loadLogoDataUri(org?.logo));
    return { buffer, filename: `${cycle.invoiceNumber}.pdf` };
  }

  /**
   * H9b: genera el PDF de una NOTA DE CRÉDITO. Lee la NC + sus líneas congeladas (`getCreditNoteTransactions`,
   * scopeada por org/cliente; lanza 404 si no existe) + query de cliente/agencia. Reusa el mismo `render`
   * con `docTitle`/`referenceLine`/montos negativos. Filename NC-YYYY-NNNNN.pdf.
   */
  async generateCreditNotePdf(
    orgId: string,
    clientId: string,
    creditNoteId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const { creditNote, lines } = await this.billing.getCreditNoteTransactions(orgId, clientId, creditNoteId);

    const [client, org] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: clientId }, select: { name: true } }),
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, logo: true, supportEmail: true },
      }),
    ]);

    const model = buildCreditNoteModel({
      creditNote,
      lines,
      clientName: client?.name ?? 'Cliente',
      org: org ? { name: org.name, supportEmail: org.supportEmail } : null,
    });

    const buffer = await this.render(model, loadLogoDataUri(org?.logo));
    return { buffer, filename: `${creditNote.number}.pdf` };
  }

  /** Dibuja el modelo con pdfkit. Layout absoluto + salto de página con re-dibujo del encabezado de tabla. */
  private render(model: InvoiceModel, logoBuf: Buffer | null): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const LEFT = 50;
    const RIGHT = 545;
    const INK = '#111827';
    const MUTED = '#6b7280';
    const LINE = '#e5e7eb';
    const bottom = doc.page.height - doc.page.margins.bottom;

    // Columnas de la tabla (x izquierdo + ancho; numéricas alineadas a la derecha).
    const COL = {
      concepto: { x: LEFT, w: 188 },
      tipo: { x: 242, w: 64 },
      horas: { x: 306, w: 58 },
      tarifa: { x: 368, w: 82 },
      monto: { x: 453, w: 92 },
    };

    const drawTableHeader = (): void => {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
      doc.text('CONCEPTO', COL.concepto.x, y, { width: COL.concepto.w, lineBreak: false });
      doc.text('TIPO', COL.tipo.x, y, { width: COL.tipo.w, lineBreak: false });
      doc.text('HORAS', COL.horas.x, y, { width: COL.horas.w, align: 'right', lineBreak: false });
      doc.text('TARIFA', COL.tarifa.x, y, { width: COL.tarifa.w, align: 'right', lineBreak: false });
      doc.text('MONTO', COL.monto.x, y, { width: COL.monto.w, align: 'right', lineBreak: false });
      doc.y = y + 14;
      doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y += 4;
      doc.fillColor(INK);
    };

    const ensureSpace = (needed: number): void => {
      if (doc.y + needed > bottom) {
        doc.addPage();
        drawTableHeader();
      }
    };

    const drawLine = (l: InvoiceLine): void => {
      ensureSpace(18);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(l.concepto, COL.concepto.x, y, { width: COL.concepto.w, lineBreak: false, ellipsis: true });
      doc.text(l.tipo, COL.tipo.x, y, { width: COL.tipo.w, lineBreak: false });
      doc.text(l.horas, COL.horas.x, y, { width: COL.horas.w, align: 'right', lineBreak: false });
      doc.text(l.tarifa, COL.tarifa.x, y, { width: COL.tarifa.w, align: 'right', lineBreak: false });
      doc.text(l.monto, COL.monto.x, y, { width: COL.monto.w, align: 'right', lineBreak: false });
      doc.y = y + 16;
    };

    const drawGroupHeader = (g: InvoiceGroup): void => {
      ensureSpace(24);
      const y = doc.y;
      doc.rect(LEFT, y - 2, RIGHT - LEFT, 18).fill('#f3f4f6');
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(g.label, LEFT + 6, y + 2, {
        width: 300,
        lineBreak: false,
      });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(`${g.horas}  ·  ${g.subtotal}`, 245, y + 2, {
        width: RIGHT - 245 - 6,
        align: 'right',
        lineBreak: false,
      });
      doc.y = y + 22;
      doc.fillColor(INK);
    };

    // ── Encabezado (agencia + FACTURA + número + fecha) ──
    const top = 50;
    if (logoBuf) {
      try {
        doc.image(logoBuf, LEFT, top, { fit: [120, 46] });
      } catch {
        /* bytes de imagen inválidos: se ignora, sigue solo el nombre */
      }
    }
    const orgY = logoBuf ? top + 54 : top;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(model.orgName, LEFT, orgY, { width: 280 });
    if (model.supportEmail) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(model.supportEmail, LEFT, doc.y + 1, { width: 280 });
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .fillColor(INK)
      .text(model.docTitle ?? 'FACTURA', 300, top, { width: 245, align: 'right' });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(INK)
      .text(model.invoiceNumber, 300, top + 26, { width: 245, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Emitida: ${model.emittedAt}`, 300, top + 44, { width: 245, align: 'right' });
    if (model.referenceLine) {
      // NC: línea de referencia a la FAC acreditada (mismo estilo muted).
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(model.referenceLine, 300, top + 58, {
        width: 245,
        align: 'right',
      });
    }
    if (model.kind === 'ACCUMULATED') {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Factura acumulada', 300, top + 58, {
        width: 245,
        align: 'right',
      });
    }

    doc.y = Math.max(doc.y, top + 78);
    doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).lineWidth(1).strokeColor(LINE).stroke();
    doc.y += 14;

    // ── Cliente (izq) + período (der) ──
    const blockY = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('CLIENTE', LEFT, blockY, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(model.clientName, LEFT, blockY + 12, { width: 280 });

    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text('PERÍODO', 300, blockY, { width: 245, align: 'right', lineBreak: false });
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(model.periodLabel, 300, blockY + 12, { width: 245, align: 'right' });
    if (model.cutoffLabel) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(`Facturado hasta ${model.cutoffLabel}`, 300, blockY + 30, { width: 245, align: 'right' });
    }
    doc.y = blockY + (model.cutoffLabel ? 50 : 40);

    // ── Banda ANULADA ──
    if (model.cancelled) {
      ensureSpace(50);
      const y = doc.y;
      doc.rect(LEFT, y, RIGHT - LEFT, 42).fill('#fbeaea');
      doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(12).text('ANULADA', LEFT + 12, y + 7);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#7f1d1d')
        .text(
          `Motivo: ${model.cancelled.reason}${model.cancelled.at ? `   ·   Anulada: ${model.cancelled.at}` : ''}`,
          LEFT + 12,
          y + 24,
          { width: RIGHT - LEFT - 24 },
        );
      doc.y = y + 42 + 14;
      doc.fillColor(INK);
    }

    // ── Tabla de líneas ──
    drawTableHeader();
    if (model.groups.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Sin líneas en esta factura', LEFT, doc.y + 4);
      doc.y += 20;
    } else {
      for (const g of model.groups) {
        if (g.showHeader) drawGroupHeader(g);
        for (const line of g.lines) drawLine(line);
        if (g.showHeader) doc.moveDown(0.4);
      }
    }

    // ── Total ──
    ensureSpace(34);
    doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).lineWidth(1).strokeColor(INK).stroke();
    doc.y += 8;
    const ty = doc.y;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    doc.text('TOTAL', COL.concepto.x, ty, { width: 200, lineBreak: false });
    doc.text(model.totalHoras, COL.horas.x, ty, { width: COL.horas.w, align: 'right', lineBreak: false });
    doc.text(model.totalMonto, COL.monto.x, ty, { width: COL.monto.w, align: 'right', lineBreak: false });
    doc.y = ty + 22;

    // ── Pie ──
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text('Documento interno de facturación — no constituye comprobante fiscal.', LEFT, doc.y + 8, {
        width: RIGHT - LEFT,
      });

    doc.end();
    return done;
  }
}

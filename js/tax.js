// =====================================================================
// tax.js — datos para el resumen fiscal de un año.
// Funciones puras (sin pantalla): se prueban igual que engine.js.
//
// Método de costo: FIFO (primeras acciones compradas = primeras vendidas).
// Cada venta se reporta por lote, con su fecha de compra, para que la
// contadora pueda ver el plazo de tenencia de cada parte vendida.
// La comisión de una compra suma al costo; la de una venta resta del valor
// recibido. Todo está en USD; la conversión a COP la hace el Excel con la TRM.
// =====================================================================
import { dnum, dstr, normalizeTx, estimateInterest, inCashScope, brokerAnchor, TIPOS } from "./engine.js";

const ORDER = { saldo_inicial: 0, deposito: 1, transferencia: 1, dividendo: 2, interes: 2, venta: 3, compra: 4, compra_reinversion: 4, comision: 5, retiro: 6 };
const EPS = 1e-9;

export function buildTaxReport({ brokers, txs, year, shareKey = "andres", closes = {}, today = null }) {
  const y0 = dnum(`${year}-01-01`);
  // año en curso: el corte es hoy, no el 31-dic
  const y1 = Math.min(dnum(`${year}-12-31`), today ? dnum(today) : Infinity);
  const out = { year, cierre: dstr(y1), parcial: dstr(y1) !== `${year}-12-31`, brokers: [], positions: [], sales: [], income: [], movements: [], warnings: [] };

  for (const b of brokers) {
    const factor = b.shares ? Number(b.shares[shareKey] ?? 0) : 1;
    const real = (txs[b.id] || []).map(normalizeTx)
      .filter((t) => dnum(t.fecha) <= y1)
      .sort((a, c) => dnum(a.fecha) - dnum(c.fecha) || (ORDER[a.tipo] ?? 9) - (ORDER[c.tipo] ?? 9));
    const full = (txs[b.id] || []).map(normalizeTx);
    const anchorN = brokerAnchor(b, full);
    const est = anchorN != null && anchorN > y1 ? [] : estimateInterest(b, real, y1);
    if (!real.length) continue; // la cuenta aún no existía en ese año

    // ---- lotes FIFO por acción
    const lots = {};          // ticker -> [{fecha, qty, cost}]
    const lastBuy = {};       // `${ticker}|${fecha}` -> lote (para sumarle la comisión del mismo día)
    const lastSale = {};      // `${ticker}|${fecha}` -> [filas de venta] (para restarles la comisión)
    const sum = {
      broker: b.nombre || b.id, brokerId: b.id, factor, shares: b.shares || null,
      dividendos: 0, retencion: 0, intereses: 0, interesesEst: 0,
      ventasValor: 0, ventasCosto: 0, comisionesSueltas: 0, depositos: 0, retiros: 0,
    };

    for (const t of real) {
      const n = dnum(t.fecha), inYear = n >= y0;
      if (t.ticker && (t.tipo === "compra" || t.tipo === "compra_reinversion")) {
        const lot = { fecha: t.fecha, qty: Number(t.cantidad) || 0, cost: -t.monto, reinv: t.tipo === "compra_reinversion" };
        (lots[t.ticker] ||= []).push(lot);
        lastBuy[`${t.ticker}|${t.fecha}`] = lot;
      } else if (t.ticker && t.tipo === "venta") {
        let qty = Math.abs(Number(t.cantidad) || 0);
        const total = qty, proceeds = t.monto;
        const q = lots[t.ticker] || [];
        const rows = [];
        while (qty > EPS && q.length) {
          const lot = q[0];
          const take = Math.min(qty, lot.qty);
          const cost = lot.qty > EPS ? lot.cost * (take / lot.qty) : 0;
          rows.push({
            broker: sum.broker, brokerId: b.id, factor, ticker: t.ticker,
            fechaCompra: lot.fecha, fechaVenta: t.fecha, cantidad: take,
            precioVenta: Number(t.precio) || (total ? proceeds / total : 0),
            valorVenta: total ? proceeds * (take / total) : 0, costo: cost,
            dias: n - dnum(lot.fecha),
          });
          lot.cost -= cost; lot.qty -= take; qty -= take;
          if (lot.qty <= EPS) q.shift();
        }
        if (qty > EPS) out.warnings.push(`${sum.broker} ${t.ticker} ${t.fecha}: se vendieron ${fmt(total)} acciones pero solo había ${fmt(total - qty)} registradas; revisa las compras anteriores.`);
        lastSale[`${t.ticker}|${t.fecha}`] = rows;
        if (inYear) for (const r of rows) { r.utilidad = r.valorVenta - r.costo; out.sales.push(r); }
      } else if (t.tipo === "comision" && t.ticker) {
        const k = `${t.ticker}|${t.fecha}`;
        if (lastBuy[k]) lastBuy[k].cost += -t.monto;
        else if (lastSale[k] && lastSale[k].length) {
          const rows = lastSale[k], tot = rows.reduce((s, r) => s + r.cantidad, 0);
          rows.forEach((r) => { r.valorVenta += t.monto * (r.cantidad / tot); r.utilidad = r.valorVenta - r.costo; });
        } else if (inYear) sum.comisionesSueltas += -t.monto;
      } else if (t.tipo === "comision" && inYear) sum.comisionesSueltas += -t.monto;

      if (!inYear) continue;
      if (t.tipo === "dividendo" || t.tipo === "interes") {
        const ret = t.retencion || 0;
        if (t.tipo === "dividendo") { sum.dividendos += t.monto; sum.retencion += ret; }
        else { sum.intereses += t.monto; sum.retencion += ret; }
        out.income.push({ broker: sum.broker, brokerId: b.id, factor, fecha: t.fecha, tipo: t.tipo, ticker: t.ticker, neto: t.monto, retencion: t.retencion ?? null, periodo: t.periodo || null, nota: t.nota || "" });
      }
      if (t.tipo === "deposito" || (t.tipo === "transferencia" && t.monto > 0)) sum.depositos += t.monto;
      if (t.tipo === "retiro" || (t.tipo === "transferencia" && t.monto < 0)) sum.retiros += -t.monto;
      out.movements.push({ broker: sum.broker, brokerId: b.id, factor, fecha: t.fecha, tipo: TIPOS[t.tipo] ? TIPOS[t.tipo].label : t.tipo, ticker: t.ticker, cantidad: t.cantidad, precio: t.precio, monto: t.monto, retencion: t.retencion ?? null, nota: t.nota || "" });
    }
    for (const e of est) {
      if (dnum(e.fecha) < y0) continue;
      sum.interesesEst += e.monto;
      out.income.push({ broker: sum.broker, brokerId: b.id, factor, fecha: e.fecha, tipo: "interes_estimado", ticker: null, neto: e.monto, retencion: null, periodo: e.periodo, nota: "Estimado por la app: falta registrar el interés real de este mes" });
    }
    for (const r of out.sales.filter((s) => s.brokerId === b.id)) { sum.ventasValor += r.valorVenta; sum.ventasCosto += r.costo; }

    // ---- efectivo al cierre
    if (anchorN != null && anchorN > y1) {
      // El saldo conocido es posterior al cierre: se calcula hacia atrás,
      // restando lo que pasó entre el 31-dic y la fecha de ese saldo.
      const si = full.find((t) => t.tipo === "saldo_inicial" && dnum(t.fecha) === anchorN);
      if (!si) {
        sum.efectivo = null;
        out.warnings.push(`${sum.broker}: no hay saldo de efectivo registrado para calcular el cierre de ${year}; usa el certificado del broker.`);
      } else {
        const between = full.filter((t) => t.tipo !== "saldo_inicial" && dnum(t.fecha) > y1 && (dnum(t.fecha) < anchorN || (dnum(t.fecha) === anchorN && t.ticker)));
        sum.efectivo = si.monto - between.reduce((s, t) => s + t.monto, 0);
        sum.efectivoNota = `Calculado hacia atrás desde el saldo de ${si.fecha}`;
      }
    } else {
      sum.efectivo = [...real, ...est].reduce((s, t) => s + (inCashScope(t, anchorN) ? t.monto : 0), 0);
    }

    // ---- posiciones al cierre
    sum.costoAcciones = 0; sum.valorMercado = 0; sum.faltanPrecios = [];
    for (const [tk, q] of Object.entries(lots)) {
      const qty = q.reduce((s, l) => s + l.qty, 0);
      if (qty <= 1e-6) continue;
      const cost = q.reduce((s, l) => s + l.cost, 0);
      const px = closes[tk] != null && closes[tk] !== "" ? Number(closes[tk]) : null;
      const meta = (b.tickers || {})[tk] || {};
      out.positions.push({
        broker: sum.broker, brokerId: b.id, factor, ticker: tk, nombre: meta.nombre || tk,
        cantidad: qty, costo: cost, costoPromedio: cost / qty, primeraCompra: q[0].fecha,
        precioCierre: px, valorMercado: px != null ? px * qty : null,
      });
      sum.costoAcciones += cost;
      if (px == null) sum.faltanPrecios.push(tk); else sum.valorMercado += px * qty;
    }
    if (sum.faltanPrecios.length) sum.valorMercado = null;
    out.brokers.push(sum);
  }
  out.positions.sort((a, c) => a.broker.localeCompare(c.broker) || a.ticker.localeCompare(c.ticker));
  out.sales.sort((a, c) => a.fechaVenta.localeCompare(c.fechaVenta) || a.ticker.localeCompare(c.ticker));
  out.income.sort((a, c) => a.fecha.localeCompare(c.fecha));
  out.movements.sort((a, c) => a.fecha.localeCompare(c.fecha));
  return out;
}

/** Acciones que quedaron abiertas al cierre del año (para pedir los precios). */
export function tickersHeldAt(brokers, txs, year, today = null) {
  const r = buildTaxReport({ brokers, txs, year, today });
  return [...new Set(r.positions.map((p) => p.ticker))].sort();
}

/** Años con movimientos, del más reciente al más antiguo. */
export function yearsWithData(txs) {
  const ys = new Set();
  for (const list of Object.values(txs)) for (const t of list) if (t.fecha) ys.add(Number(String(t.fecha).slice(0, 4)));
  return [...ys].sort((a, b) => b - a);
}

function fmt(x) { return Number(x).toLocaleString("en-US", { maximumFractionDigits: 6 }); }
export { dstr };

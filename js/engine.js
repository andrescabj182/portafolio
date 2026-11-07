// =====================================================================
// engine.js — motor de cálculo del portafolio (sin dependencias).
// Funciona igual en el navegador y en Node (para pruebas).
//
// Reglas clave (validadas a lo largo del proyecto):
//  - TIR de cada posición: todos sus flujos (compra, venta, dividendo,
//    reinversión, comisión asociada) + valor de mercado hoy.
//  - TIR del portafolio / de un broker: SOLO flujos externos
//    (depósitos, retiros, y compras anteriores al ancla en brokers que
//    no tienen historial de depósitos) + valor total hoy. Ventas,
//    dividendos, reinversiones e intereses son internos: nunca cuentan
//    como flujo externo (evita el doble conteo de la venta de BAC).
//  - Vista "Mi parte": cada flujo y valor de un broker se multiplica por
//    la participación del usuario en ese broker. La TIR de una posición
//    que vive en un solo broker no cambia; los valores sí.
//  - Intereses (Tyba): se causan a diario sobre el saldo en efectivo. Un
//    interés real registrado para un mes reemplaza la estimación de ese mes.
// =====================================================================

const DAY = 86400000;

export function dnum(s) {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
}
export function dstr(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}
function monthOf(s) {
  return s.slice(0, 7);
}
function prevMonth(s) {
  let [y, m] = s.split("-").map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function isLastDayOfMonth(n) {
  return new Date((n + 1) * DAY).getUTCDate() === 1;
}

// ---------------------------------------------------------------- XIRR
function npvAt(cfs, r) {
  const d0 = cfs[0][0];
  let t = 0;
  for (const [d, a] of cfs) t += a / Math.pow(1 + r, (d - d0) / 365);
  return t;
}

/** cfs: [[dayNumber, amount], ...] */
export function xirr(cfs) {
  cfs = cfs.filter((c) => Math.abs(c[1]) > 1e-9).sort((a, b) => a[0] - b[0]);
  if (cfs.length < 2) return null;
  if (!cfs.some((c) => c[1] < 0) || !cfs.some((c) => c[1] > 0)) return null;
  let lo = -0.9999, hi = 10;
  let flo = npvAt(cfs, lo), fhi = npvAt(cfs, hi);
  if (flo * fhi > 0) { hi = 1000; fhi = npvAt(cfs, hi); if (flo * fhi > 0) return null; }
  for (let i = 0; i < 400; i++) {
    const mid = (lo + hi) / 2, f = npvAt(cfs, mid);
    if (Math.abs(f) < 1e-10 || hi - lo < 1e-13) return mid;
    if (flo * f < 0) { hi = mid; fhi = f; } else { lo = mid; flo = f; }
  }
  return (lo + hi) / 2;
}

export function xnpv(cfs, rate) {
  cfs = cfs.filter((c) => Math.abs(c[1]) > 1e-9).sort((a, b) => a[0] - b[0]);
  if (!cfs.length) return null;
  return npvAt(cfs, rate);
}

// ---------------------------------------------------------- Movimientos
export const TIPOS = {
  compra: { label: "Compra", conTicker: true, conCantidad: true },
  venta: { label: "Venta", conTicker: true, conCantidad: true },
  dividendo: { label: "Dividendo", conTicker: true },
  compra_reinversion: { label: "Reinversión de dividendo", conTicker: true, conCantidad: true },
  comision: { label: "Comisión", conTicker: "opcional" },
  deposito: { label: "Depósito" },
  retiro: { label: "Retiro" },
  interes: { label: "Interés (real)" },
  transferencia: { label: "Transferencia entre brokers" },
  saldo_inicial: { label: "Saldo inicial (ancla)" },
  interes_estimado: { label: "Interés estimado" },
};

/**
 * Convención de signos del campo `monto` (efecto sobre el efectivo del broker):
 *  compra / compra_reinversion / comision / retiro      -> negativo
 *  venta / dividendo / deposito / interes / saldo_inicial -> positivo
 *  transferencia -> positivo si entra al broker, negativo si sale
 *  venta lleva `cantidad` negativa.
 */
export function normalizeTx(t) {
  const tx = { ...t };
  tx.cantidad = tx.cantidad === "" || tx.cantidad == null ? null : Number(tx.cantidad);
  tx.precio = tx.precio === "" || tx.precio == null ? null : Number(tx.precio);
  tx.monto = Number(tx.monto);
  tx.ticker = tx.ticker ? String(tx.ticker).trim().toUpperCase() : null;
  // impuesto retenido en la fuente (positivo); el monto ya viene neto
  if (tx.retencion === "" || tx.retencion == null || isNaN(Number(tx.retencion)) || Number(tx.retencion) <= 0) delete tx.retencion;
  else tx.retencion = Number(tx.retencion);
  return tx;
}

// ------------------------------------------------- Intereses (estimados)
function interestRateOn(broker, dayN) {
  const cfg = broker.interes;
  if (!cfg || !cfg.tasas || !cfg.tasas.length) return 0;
  const vig = cfg.tasas
    .filter((t) => dnum(t.desde) <= dayN)
    .sort((a, b) => dnum(b.desde) - dnum(a.desde))[0];
  if (!vig) return 0;
  const tasa = Number(vig.tasa);
  return cfg.base === "nominal" ? tasa / 365 : Math.pow(1 + tasa, 1 / 365) - 1;
}

/**
 * Genera movimientos sintéticos "interes_estimado" para los meses que aún no
 * tienen un interés real registrado. Causación diaria sobre el saldo de
 * cierre de cada día; se capitaliza al cierre de cada mes. El mes en curso
 * se muestra como causado hasta hoy (marcado `parcial`).
 */
export function estimateInterest(broker, txs, todayN) {
  if (!broker.interes || !broker.interes.tasas || !broker.interes.tasas.length) return [];
  if (!txs.length) return [];
  const anchorN = brokerAnchor(broker, txs);
  const settled = new Set(
    txs.filter((t) => t.tipo === "interes").map((t) => t.periodo || prevMonth(t.fecha))
  );
  const deltas = new Map();
  let startN = Infinity;
  for (const t of txs) {
    if (!inCashScope(t, anchorN)) continue;
    const n = dnum(t.fecha);
    deltas.set(n, (deltas.get(n) || 0) + t.monto);
    startN = Math.min(startN, n);
  }
  if (!isFinite(startN)) return [];
  const out = [];
  let bal = 0, accrued = 0;
  for (let d = startN; d <= todayN; d++) {
    bal += deltas.get(d) || 0;
    const month = monthOf(dstr(d));
    if (!settled.has(month) && bal > 0) accrued += bal * interestRateOn(broker, d);
    const monthEnd = isLastDayOfMonth(d);
    if ((monthEnd || d === todayN) && accrued > 0.000001) {
      out.push({
        id: `est-${broker.id}-${month}`,
        fecha: dstr(d),
        ticker: null,
        tipo: "interes_estimado",
        cantidad: null,
        precio: null,
        monto: accrued,
        periodo: month,
        parcial: !monthEnd,
        sintetico: true,
      });
      if (monthEnd) { bal += accrued; accrued = 0; }
    }
  }
  return out;
}

/**
 * ¿Este movimiento afecta el efectivo calculado del broker?
 * Sin ancla: todos. Con ancla (saldo de efectivo conocido en una fecha):
 * el saldo inicial + todo lo posterior; lo anterior ya está dentro de ese
 * saldo. El mismo día del ancla solo cuentan movimientos sin ticker.
 */
export function inCashScope(t, anchorN) {
  if (t.tipo === "saldo_inicial") return true;
  if (anchorN == null) return true;
  const n = dnum(t.fecha);
  if (n < anchorN) return false;
  if (n === anchorN && t.ticker) return false;
  return true;
}

export function brokerAnchor(broker, txs) {
  if (broker.anchorDate) return dnum(broker.anchorDate);
  const si = txs.find((t) => t.tipo === "saldo_inicial");
  return si ? dnum(si.fecha) : null;
}

// ---------------------------------------------------------------- Alertas
export const DEFAULT_ALERT_CONFIG = {
  peMultiplier: 1.3,
  highProximityPct: 0.95,
  currentRatioMin: 1.0,
  debtEquityMax: 2.0,
  concentrationMaxPct: 35,
};

function fmtMoney(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function detectDividendCut(txs) {
  const sorted = [...txs].sort((a, b) => dnum(a.fecha) - dnum(b.fecha));
  const divs = sorted.filter((t) => t.tipo === "dividendo");
  if (divs.length < 2) return null;
  const sharesAsOf = (f) => sorted.reduce((s, t) => (t.cantidad && dnum(t.fecha) < dnum(f) ? s + t.cantidad : s), 0);
  const last = divs[divs.length - 1], prev = divs[divs.length - 2];
  const ls = sharesAsOf(last.fecha), ps = sharesAsOf(prev.fecha);
  if (ls <= 0 || ps <= 0) return null;
  const lps = last.monto / ls, pps = prev.monto / ps;
  if (lps < pps * 0.98) return { last: lps, prev: pps, drop: 1 - lps / pps };
  return null;
}

function evaluateAlerts(row, meta, metrics, cfg, txsByBroker) {
  const alerts = [];
  const m = metrics || {};
  if (m.pe && meta.industryPE) {
    if (m.pe > meta.industryPE * cfg.peMultiplier) {
      alerts.push({
        tipo: "valoracion_exigente",
        label: "Valoración exigente",
        detail: `PE actual de ${m.pe.toFixed(1)}x, ${((m.pe / meta.industryPE - 1) * 100).toFixed(0)}% por encima del PE de industria que configuraste (${Number(meta.industryPE).toFixed(1)}x). No es necesariamente una señal de inestabilidad: el mercado puede estar descontando un crecimiento superior al del sector. Vale la pena revisar si esa expectativa está justificada.`,
      });
    }
  }
  if (m.week52High && row.price) {
    const p = row.price / m.week52High;
    if (p >= cfg.highProximityPct) {
      alerts.push({
        tipo: "cerca_maximo",
        label: "Cerca de su máximo de 52 semanas",
        detail: `Precio actual a ${(p * 100).toFixed(1)}% de su máximo de 52 semanas (${fmtMoney(m.week52High)}${m.week52HighDate ? ", " + m.week52HighDate : ""}). No implica que vaya a corregir, pero es buen momento para revisar si el tamaño de la posición sigue siendo el que quieres.`,
      });
    }
  }
  if (m.currentRatio != null && m.currentRatio < cfg.currentRatioMin) {
    alerts.push({
      tipo: "liquidez",
      label: "Liquidez corriente ajustada",
      detail: `Current ratio de ${m.currentRatio.toFixed(2)}x, por debajo del umbral de ${Number(cfg.currentRatioMin).toFixed(2)}x. Los pasivos de corto plazo superan a los activos de corto plazo; revisa el contexto, porque algunas industrias operan así de forma estructural.`,
    });
  }
  if (m.debtToEquity != null && m.debtToEquity > cfg.debtEquityMax) {
    alerts.push({
      tipo: "apalancamiento",
      label: "Apalancamiento elevado",
      detail: `Deuda/patrimonio de ${m.debtToEquity.toFixed(2)}x, por encima del umbral de ${Number(cfg.debtEquityMax).toFixed(2)}x. Bancos y financieras operan estructuralmente con apalancamiento alto; este umbral es más relevante para empresas no financieras.`,
    });
  }
  for (const txs of txsByBroker) {
    const cut = detectDividendCut(txs);
    if (cut) {
      alerts.push({
        tipo: "recorte_dividendo",
        label: "Recorte de dividendo",
        detail: `El último dividendo por acción (${fmtMoney(cut.last)}) fue menor al anterior (${fmtMoney(cut.prev)}), una caída de ${(cut.drop * 100).toFixed(1)}%. Calculado desde tu historial de movimientos.`,
      });
      break;
    }
  }
  return alerts;
}

// ------------------------------------------------------------ Portafolio
/**
 * @param {object} p
 *  brokers: [{id, nombre, shares:{andres:1,...}, anchorDate?, interes?, saldoReportado?, tickers?}]
 *  txs: {brokerId: [tx, ...]}
 *  prices: {TICKER: {price, date, source}}
 *  today: 'YYYY-MM-DD'
 *  view: 'total' | 'mine'
 *  shareKey: clave de participación del usuario ('andres', 'ricardo')
 */
export function buildPortfolio(p) {
  const {
    brokers, txs, prices = {}, today, view = "total", shareKey = "andres",
    discountRate = 0.1, alertConfig = DEFAULT_ALERT_CONFIG, metrics = {},
  } = p;
  const todayN = dnum(today);
  const cfg = { ...DEFAULT_ALERT_CONFIG, ...(alertConfig || {}) };
  const warnings = [];

  const tickerMeta = {};
  const tickerAgg = {}; // ticker -> { cfs, shares, invested(qty,cost), brokers:[], txs:[] }
  const brokerRows = [];
  const portfolioExternal = [];
  let portfolioValue = 0, portfolioCash = 0, portfolioHoldings = 0;

  for (const b of brokers) {
    const f = view === "total" ? 1 : Number((b.shares || {})[shareKey] ?? 0);
    if (!(f > 0)) continue;
    for (const [t, meta] of Object.entries(b.tickers || {})) {
      tickerMeta[t] = { ...(tickerMeta[t] || {}), ...meta };
    }

    const real = (txs[b.id] || []).map(normalizeTx).filter((t) => dnum(t.fecha) <= todayN);
    real.sort((a, c) => dnum(a.fecha) - dnum(c.fecha));
    const est = estimateInterest(b, real, todayN);
    const all = [...real, ...est].sort((a, c) => dnum(a.fecha) - dnum(c.fecha));
    const anchorN = brokerAnchor(b, real);

    // --- efectivo
    let cash = 0;
    for (const t of all) if (inCashScope(t, anchorN)) cash += t.monto;

    // --- posiciones dentro del broker
    const pos = {};
    for (const t of all) {
      if (!t.ticker) continue;
      const ps = (pos[t.ticker] ||= { ticker: t.ticker, shares: 0, cfs: [], txs: [], buyQty: 0, buyCost: 0 });
      if (t.cantidad) ps.shares += t.cantidad;
      ps.cfs.push([dnum(t.fecha), t.monto]);
      ps.txs.push(t);
      if ((t.tipo === "compra" || t.tipo === "compra_reinversion") && t.cantidad > 0) {
        ps.buyQty += t.cantidad;
        ps.buyCost += -t.monto;
      }
    }

    let holdingsValue = 0, missing = [];
    const positions = [];
    for (const ps of Object.values(pos)) {
      if (Math.abs(ps.shares) < 1e-7) ps.shares = 0;
      const pr = prices[ps.ticker];
      let value = null;
      if (ps.shares !== 0) {
        if (pr && pr.price) value = ps.shares * pr.price;
        else missing.push(ps.ticker);
      } else value = 0;
      if (value != null) holdingsValue += value;
      const cfs = value != null ? [...ps.cfs, [todayN, value]] : ps.cfs;
      positions.push({
        ticker: ps.ticker,
        shares: ps.shares * f,
        value: value == null ? null : value * f,
        irr: value == null ? null : xirr(cfs),
        npv: value == null ? null : xnpv(cfs.map(([d, a]) => [d, a * f]), discountRate),
        closed: ps.shares === 0,
      });
      const agg = (tickerAgg[ps.ticker] ||= { cfs: [], shares: 0, value: 0, missing: false, buyQty: 0, buyCost: 0, brokers: [], txs: [], txsByBroker: [] });
      for (const [d, a] of ps.cfs) agg.cfs.push([d, a * f]);
      agg.shares += ps.shares * f;
      if (value == null) agg.missing = true; else agg.value += value * f;
      agg.buyQty += ps.buyQty;
      agg.buyCost += ps.buyCost;
      agg.txsByBroker.push(ps.txs);
      for (const t of ps.txs) agg.txs.push({ ...t, brokerId: b.id, brokerNombre: b.nombre });
      agg.brokers.push({
        brokerId: b.id, nombre: b.nombre, shares: ps.shares * f,
        value: value == null ? null : value * f,
        irr: value == null ? null : xirr(cfs),
      });
    }
    if (missing.length) warnings.push(`${b.nombre}: sin precio para ${missing.join(", ")}`);
    if (cash < -1) warnings.push(`${b.nombre}: el efectivo calculado es negativo (${fmtMoney(cash)}). Probablemente falta registrar algún depósito.`);

    const brokerValue = holdingsValue + cash;

    // --- flujos externos del broker
    const ext = [];
    for (const t of real) {
      const n = dnum(t.fecha);
      if (t.tipo === "deposito" || t.tipo === "retiro" || t.tipo === "transferencia") ext.push([n, -t.monto, t.tipo]);
      else if (t.tipo === "compra" && anchorN != null && n <= anchorN) ext.push([n, t.monto, t.tipo]);
    }
    const brokerCfs = [...ext.map(([d, a]) => [d, a]), [todayN, brokerValue]];
    for (const [d, a, tipo] of ext) if (tipo !== "transferencia") portfolioExternal.push([d, a * f]);

    const rec = b.saldoReportado && b.saldoReportado.valor != null && b.saldoReportado.valor !== ""
      ? (() => {
          const rep = Number(b.saldoReportado.valor);
          const diff = brokerValue - rep;
          return { reportado: rep, fecha: b.saldoReportado.fecha || null, diff, pct: rep ? diff / rep : null };
        })()
      : null;

    brokerRows.push({
      id: b.id, nombre: b.nombre, factor: f,
      cash: cash * f, holdingsValue: holdingsValue * f, value: brokerValue * f,
      valueFull: brokerValue,
      irr: missing.length ? null : xirr(brokerCfs),
      npv: missing.length ? null : xnpv(brokerCfs.map(([d, a]) => [d, a * f]), discountRate),
      invested: ext.reduce((s, [, a]) => s - a, 0) * f,
      positions: positions.sort((a, c) => (c.value || 0) - (a.value || 0)),
      cashTxs: all.filter((t) => !t.ticker || t.tipo === "comision").map((t) => ({ ...t, brokerId: b.id })),
      allTxs: all.map((t) => ({ ...t, brokerId: b.id, brokerNombre: b.nombre })),
      estimatedInterest: est.reduce((s, t) => s + t.monto, 0) * f,
      reconciliation: rec,
      hasMissingPrices: missing.length > 0,
    });

    portfolioValue += brokerValue * f;
    portfolioCash += cash * f;
    portfolioHoldings += holdingsValue * f;
  }

  // --- vista consolidada por ticker
  const tickers = Object.entries(tickerAgg).map(([ticker, a]) => {
    const meta = tickerMeta[ticker] || {};
    const price = prices[ticker] ? prices[ticker].price : null;
    const cfs = a.missing ? a.cfs : [...a.cfs, [todayN, a.value]];
    const row = {
      ticker,
      nombre: meta.nombre || ticker,
      shares: a.shares,
      price,
      priceSource: prices[ticker] ? prices[ticker].source : null,
      value: a.missing ? null : a.value,
      irr: a.missing ? null : xirr(cfs),
      npv: a.missing ? null : xnpv(cfs, discountRate),
      avgEntry: a.buyQty ? a.buyCost / a.buyQty : null,
      brokers: a.brokers,
      txs: a.txs.sort((x, y) => dnum(y.fecha) - dnum(x.fecha)),
      closed: Math.abs(a.shares) < 1e-7,
      industryPE: meta.industryPE || null,
      pe: (metrics[ticker] || {}).pe ?? null,
      // ganancia en dólares: todo lo recibido + valor actual − todo lo pagado
      gain: a.missing ? null : cfs.reduce((s, [, v]) => s + v, 0),
    };
    // una posición vendida ya no necesita alertas
    row.alerts = row.closed ? [] : evaluateAlerts(row, meta, metrics[ticker], cfg, a.txsByBroker);
    return row;
  });

  for (const r of tickers) {
    r.pct = portfolioValue && r.value != null ? (r.value / portfolioValue) * 100 : null;
    if (r.pct != null && r.pct > cfg.concentrationMaxPct) {
      r.alerts.push({
        tipo: "concentracion",
        label: "Posición concentrada",
        detail: `${r.ticker} representa ${r.pct.toFixed(1)}% del portafolio, por encima del ${Number(cfg.concentrationMaxPct).toFixed(0)}% que configuraste como máximo. No es una señal sobre la empresa, sino sobre la diversificación de tu portafolio.`,
      });
    }
  }
  tickers.sort((a, b) => (a.closed - b.closed) || ((b.value || 0) - (a.value || 0)));

  const anyMissing = tickers.some((t) => t.value == null && !t.closed);
  const pfCfs = [...portfolioExternal, [todayN, portfolioValue]];

  return {
    asOf: today,
    view,
    totalValue: portfolioValue,
    cash: portfolioCash,
    holdingsValue: portfolioHoldings,
    invested: portfolioExternal.reduce((s, [, a]) => s - a, 0),
    irr: anyMissing ? null : xirr(pfCfs),
    npv: anyMissing ? null : xnpv(pfCfs, discountRate),
    tickers,
    brokers: brokerRows,
    warnings,
  };
}

// ---------------------------------------------------------- CSV import
/** CSV con encabezado: broker,fecha,ticker,tipo,cantidad,precio,monto[,periodo,nota,retencion] */
export function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: ["Archivo vacío"] };
  const sep = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const need = ["broker", "fecha", "tipo", "monto"];
  const errors = [];
  for (const n of need) if (!head.includes(n)) errors.push(`Falta la columna "${n}"`);
  if (errors.length) return { rows: [], errors };
  const rows = [];
  lines.slice(1).forEach((line, i) => {
    const cells = line.split(sep).map((c) => c.trim());
    const r = {};
    head.forEach((h, j) => (r[h] = cells[j] ?? ""));
    const ln = i + 2;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.fecha) || dstr(dnum(r.fecha)) !== r.fecha) { errors.push(`Línea ${ln}: fecha inválida "${r.fecha}" (usa AAAA-MM-DD)`); return; }
    if (!TIPOS[r.tipo] || r.tipo === "interes_estimado") { errors.push(`Línea ${ln}: tipo desconocido "${r.tipo}"`); return; }
    if (r.monto === "" || isNaN(Number(r.monto))) { errors.push(`Línea ${ln}: monto inválido`); return; }
    if (TIPOS[r.tipo].conTicker === true && !r.ticker) { errors.push(`Línea ${ln}: "${r.tipo}" requiere ticker`); return; }
    rows.push({
      broker: r.broker.toLowerCase(),
      tx: normalizeTx({
        fecha: r.fecha, ticker: r.ticker || null, tipo: r.tipo,
        cantidad: r.cantidad, precio: r.precio, monto: r.monto,
        ...(r.periodo ? { periodo: r.periodo } : {}),
        ...(r.nota ? { nota: r.nota } : {}),
        ...(r.retencion ? { retencion: r.retencion } : {}),
      }),
    });
  });
  return { rows, errors };
}

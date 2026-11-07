// =====================================================================
// app.js — interfaz. Toda la lógica financiera vive en engine.js; toda
// la seguridad, en las reglas de Firestore. Este archivo solo dibuja.
// =====================================================================
import { buildPortfolio, parseCsv, normalizeTx, TIPOS, DEFAULT_ALERT_CONFIG } from "./engine.js";
import { createFirebaseStore, createMemoryStore } from "./data.js";
import { buildTaxReport, tickersHeldAt, yearsWithData } from "./tax.js";
import { firebaseConfig, proxyUrl } from "./config.js";

const DEFAULT_NEWS_KEYWORDS = [
  "lawsuit", "sues", "sued", "litigation", "antitrust", "monopoly", "regulator", "regulatory",
  "investigation", "probe", "fraud", "recall", "ban", "sanction", "tariff",
  "ceo", "chief executive", "resign", "steps down", "appoint", "board of directors",
  "merger", "acquisition", "acquire", "buyout", "takeover", "spin-off", "spinoff",
  "layoffs", "restructuring", "bankruptcy", "chapter 11",
  "patent", "market share", "competitor", "disrupt", "breach", "cyberattack",
  "strike", "union", "guidance", "profit warning", "downgrade", "upgrade", "fda",
];

const S = {
  store: null, user: null, access: null, isOwner: false,
  view: "total", tab: "posiciones", screen: { type: "home" },
  movFilter: { broker: "", ticker: "", kind: "" }, movLimit: 30, showClosed: false, keepScroll: false,
  brokers: [], txs: {}, settings: {}, prices: {}, metrics: {},
  pf: null, busy: false, priceErrors: [], newsCache: {},
};

const $app = () => document.getElementById("app");

// ------------------------------------------------------------ utilidades
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function money(n, dec = 2) {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return n < 0 ? `($${a})` : `$${a}`;
}
const pct = (n, d = 1) => (n == null || isNaN(n) ? "—" : `${(n * 100).toFixed(d)}%`);
const num = (n, d = 4) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function prevMonthStr(fecha) {
  let [y, m] = fecha.split("-").map(Number);
  m -= 1; if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function toast(msg, ms = 2600) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const proxyReady = () => proxyUrl && !proxyUrl.startsWith("PEGA_AQUI");
function brokerById(id) { return S.brokers.find((b) => b.id === id); }
function tickerMeta(t) {
  for (const b of S.brokers) if (b.tickers && b.tickers[t]) return b.tickers[t];
  return {};
}
const apiSym = (t) => tickerMeta(t).apiSymbol || t;
function viewLabel() { return S.isOwner ? `Solo ${esc(S.access.nombre || "yo")}` : "Mi parte"; }

// --------------------------------------------------------------- precios
const LIVE_KEY = "pf_live_prices_v1";
const METRICS_KEY = "pf_metrics_v1";
function readLS(k) { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function mergePrices() {
  const live = readLS(LIVE_KEY);
  const out = { ...live };
  for (const b of S.brokers) {
    for (const [t, m] of Object.entries(b.preciosManuales || {})) {
      if (!out[t] || (m.ts || 0) > (out[t].ts || 0)) out[t] = { ...m, source: "Manual" };
    }
  }
  S.prices = out;
  S.metrics = readLS(METRICS_KEY).data || {};
}

async function proxyCall(params) {
  const u = new URL(proxyUrl);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString());
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Error del proxy");
  return j;
}

function heldTickers() {
  const set = new Set();
  for (const b of S.brokers) {
    const sh = {};
    for (const t of S.txs[b.id] || []) if (t.ticker && t.cantidad) sh[t.ticker] = (sh[t.ticker] || 0) + Number(t.cantidad);
    Object.entries(sh).forEach(([t, q]) => Math.abs(q) > 1e-7 && set.add(t));
  }
  return [...set];
}

async function refreshPrices(manual = true) {
  if (!proxyReady()) { if (manual) toast("Falta configurar la URL del proxy de precios"); return; }
  const tickers = heldTickers();
  if (!tickers.length) return;
  S.busy = true; render();
  const live = readLS(LIVE_KEY);
  const errors = [];
  try {
    const syms = tickers.map(apiSym);
    const j = await proxyCall({ action: "quotes", symbols: syms.join(",") });
    const today = todayStr();
    tickers.forEach((t) => {
      const q = j.data[apiSym(t)];
      if (q && q.price) live[t] = { price: q.price, date: today, ts: Date.now(), source: "Finnhub" };
      else errors.push(`${t}: ${(j.errors || {})[apiSym(t)] || "sin dato"}`);
    });
    writeLS(LIVE_KEY, live);
    const mc = readLS(METRICS_KEY);
    if (!mc.ts || Date.now() - mc.ts > 24 * 3600e3) {
      try {
        const m = await proxyCall({ action: "metrics", symbols: syms.join(",") });
        const data = {};
        tickers.forEach((t) => { if (m.data[apiSym(t)]) data[t] = m.data[apiSym(t)]; });
        writeLS(METRICS_KEY, { ts: Date.now(), data });
      } catch { /* las métricas son un extra */ }
    }
  } catch (e) {
    errors.push(`No se pudo contactar el proxy de precios: ${e.message}`);
  }
  S.priceErrors = errors;
  S.busy = false;
  mergePrices(); compute(); render();
  if (manual && !errors.length) toast("Precios actualizados");
}

function pricesStale() {
  const live = readLS(LIVE_KEY);
  const ts = Object.values(live).map((p) => p.ts || 0);
  return !ts.length || Date.now() - Math.min(...ts) > 6 * 3600e3;
}

// --------------------------------------------------------------- cálculo
function compute() {
  S.pf = buildPortfolio({
    brokers: S.brokers, txs: S.txs, prices: S.prices, today: todayStr(),
    view: S.view, shareKey: S.access.shareKey,
    alertConfig: { ...DEFAULT_ALERT_CONFIG, ...(S.settings.alertConfig || {}) },
    metrics: S.metrics,
  });
}

async function reload() {
  const d = await S.store.loadAll(S.access);
  S.brokers = d.brokers; S.txs = d.txs; S.settings = d.settings || {};
  mergePrices(); compute(); render();
}

// ------------------------------------------------------------- pantallas
const ICON = {
  pos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>',
  brk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 9l9-5 9 5M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18"/></svg>',
  mov: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
};
const TABS = [["posiciones", "Posiciones", ICON.pos], ["brokers", "Brokers", ICON.brk], ["movimientos", "Movimientos", ICON.mov], ["mas", "Más", ICON.more]];

const signedPct = (v, d = 1) => (v == null || isNaN(v) ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(d)}%`);
const signedMoney = (v) => (v == null || isNaN(v) ? "—" : `${v >= 0 ? "+" : "−"}${money(Math.abs(v)).replace(/[()]/g, "")}`);
const tone = (v) => (v == null ? "" : v >= 0 ? "gain" : "loss");
function irrText(v, d = 1) { return `<span class="${tone(v)}">${signedPct(v, d)}</span>`; }
function fmtDate(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number);
  return `${d} ${MESES[m - 1]} ${y}`;
}
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_L = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function render() {
  if (!S.pf) return;
  const sc = S.screen;
  let html;
  if (sc.type === "ticker") html = renderTicker(sc.id);
  else if (sc.type === "broker") html = renderBroker(sc.id);
  else if (S.tab === "brokers") html = renderBrokers();
  else if (S.tab === "movimientos") html = renderMovimientos();
  else if (S.tab === "mas") html = renderMas();
  else html = renderHome();
  const y = window.scrollY;
  $app().innerHTML = `<div class="shell">${renderSide()}<main class="main">${renderTop()}${html}</main></div>${renderTabbar()}`;
  if (S.keepScroll) { window.scrollTo(0, y); S.keepScroll = false; }
  if (sc.type === "ticker") loadNews(sc.id);
}

function viewSeg() {
  return `<div class="seg" role="group" aria-label="Vista"><button class="${S.view === "total" ? "on" : ""}" data-a="view" data-v="total">Total</button><button class="${S.view === "mine" ? "on" : ""}" data-a="view" data-v="mine">${viewLabel()}</button></div>`;
}
const activeTab = () => (S.screen.type === "ticker" ? "posiciones" : S.screen.type === "broker" ? "brokers" : S.tab);

function renderTop() {
  return `<header class="top"><div><h1>Portafolio</h1><div class="who">${esc(S.user.nombre)}${S.store.mode === "demo" ? " (demo)" : ""}</div></div>${viewSeg()}</header>`;
}

function renderSide() {
  return `<aside class="side">
    <div class="brand">Portafolio</div>
    <div class="who">${esc(S.user.nombre)}${S.store.mode === "demo" ? " (demo)" : ""}${S.isOwner ? "" : ", solo lectura"}</div>
    ${viewSeg()}
    <nav>${TABS.filter(([k]) => k !== "mas").map(([k, l, i]) => `<button class="${activeTab() === k ? "on" : ""}" data-a="tab" data-v="${k}">${i}${l}</button>`).join("")}</nav>
    ${S.isOwner ? `<button class="btn primary" data-a="new-tx">+ Nuevo movimiento</button>` : ""}
    <div class="grow"></div>
    <button class="act" data-a="refresh" ${S.busy ? "disabled" : ""}>${S.busy ? '<span class="spin">↻</span> Actualizando precios' : "↻ Actualizar precios"}</button>
    <button class="act" data-a="tax">Resumen fiscal</button>
    ${S.isOwner ? `<button class="act" data-a="prices">Precios manuales</button><button class="act" data-a="import">Importar CSV</button><button class="act" data-a="config">Configuración</button>` : ""}
    <button class="act" data-a="logout">Cerrar sesión</button>
  </aside>`;
}

function renderTabbar() {
  return `<nav class="tabbar">${TABS.map(([k, l, i]) => `<button class="${activeTab() === k ? "on" : ""}" data-a="tab" data-v="${k}">${i}<span>${l}</span></button>`).join("")}</nav>
    ${S.isOwner && S.screen.type === "home" && S.tab !== "mas" ? `<button class="fab" data-a="new-tx" aria-label="Nuevo movimiento">${ICON.plus}Movimiento</button>` : ""}`;
}

function warningsBox() {
  const warn = [...S.pf.warnings, ...S.priceErrors];
  return warn.length ? `<div class="notice">${warn.map(esc).join("<br>")}</div>` : "";
}

// ---- resumen (posiciones)
function renderHome() {
  const p = S.pf;
  const open = p.tickers.filter((t) => !t.closed);
  const closed = p.tickers.filter((t) => t.closed);
  const gain = p.totalValue - p.invested;
  let h = `<section class="hero">
    <div class="label">${S.view === "total" ? "Valor total" : `Valor, ${viewLabel().toLowerCase()}`} al ${fmtDate(p.asOf)}</div>
    <div class="total fig">${money(p.totalValue)}</div>
    <div class="facts">
      <div><span>TIR anual</span><b>${irrText(p.irr)}</b></div>
      <div><span>Ganancia</span><b class="${tone(gain)}">${signedMoney(gain)}</b></div>
      <div><span>VPN al 10%</span><b>${money(p.npv)}</b></div>
    </div>
    ${renderStrip(open, p)}
    ${warningsBox()}
  </section>`;
  if (!S.brokers.length) {
    return h + `<div class="notice">${S.isOwner ? "Aún no hay brokers. Créalos en Configuración y luego importa tus movimientos." : "No tienes brokers asignados todavía."}</div>`;
  }
  h += `<section class="block"><h2>Posiciones <small>${open.length} abiertas</small></h2>
    <div class="panel pos-list">
      ${open.map(posRow).join("")}
      <div class="pos cashrow"><div style="min-width:0"><div class="tk">Efectivo</div><div class="nm">${p.brokers.map((b) => `${esc(b.nombre)} ${money(b.cash)}`).join(", ")}</div></div>
        <div><div class="v">${money(p.cash)}</div><div class="s">${p.totalValue ? ((p.cash / p.totalValue) * 100).toFixed(1) + "%" : ""}</div></div></div>
    </div>
    <div class="panel tbl-wrap"><table class="tbl">
      <tr><th>Acción</th><th>Brokers</th><th class="n">Acciones</th><th class="n">Precio</th><th class="n">Valor</th><th class="n">Peso</th><th class="n">TIR</th><th class="n">Ganancia</th></tr>
      ${open.map((t) => `<tr class="click" data-a="open-ticker" data-id="${esc(t.ticker)}">
        <td><span class="tk">${esc(t.ticker)}</span>${t.alerts.length ? `<span class="flag" title="${t.alerts.length} alerta(s)">!</span>` : ""}<div class="tiny muted">${esc(t.nombre)}</div></td>
        <td class="small muted">${t.brokers.map((b) => esc(b.nombre)).join(", ")}</td>
        <td class="n">${num(t.shares)}</td><td class="n">${money(t.price)}</td><td class="n"><b>${money(t.value)}</b></td>
        <td class="n">${t.pct != null ? t.pct.toFixed(1) + "%" : "—"}</td><td class="n">${irrText(t.irr)}</td><td class="n ${tone(t.gain)}">${signedMoney(t.gain)}</td></tr>`).join("")}
      <tr><td><span class="tk">Efectivo</span></td><td class="small muted">${p.brokers.map((b) => `${esc(b.nombre)} ${money(b.cash)}`).join(", ")}</td><td></td><td></td>
        <td class="n"><b>${money(p.cash)}</b></td><td class="n">${p.totalValue ? ((p.cash / p.totalValue) * 100).toFixed(1) + "%" : ""}</td><td></td><td></td></tr>
    </table></div></section>`;
  if (closed.length) {
    h += `<section class="block"><div class="panel">
      <button class="toggle-row" data-a="toggle-closed"><span><b>Vendidas</b> ${closed.length} ${closed.length === 1 ? "posición" : "posiciones"}</span><span>${S.showClosed ? "Ocultar" : "Ver"}</span></button>
      ${S.showClosed ? closed.map(closedRow).join("") : ""}
    </div></section>`;
  }
  return h;
}

function renderStrip(open, p) {
  const items = open.filter((t) => t.value > 0).map((t) => ({ k: t.ticker, v: t.value, open: true }));
  if (p.cash > 0) items.push({ k: "Efectivo", v: p.cash, cash: true });
  const tot = items.reduce((s, x) => s + x.v, 0);
  if (!tot) return "";
  const n = items.filter((x) => !x.cash).length;
  let i = 0;
  items.forEach((x) => { if (!x.cash) { x.shade = Math.round(95 - (i * 70) / Math.max(1, n - 1)); i++; } });
  return `<div class="strip" aria-label="Composición del portafolio">
    <div class="bar">${items.map((x) => `<button ${x.cash ? 'class="cash" tabindex="-1"' : `data-a="open-ticker" data-id="${esc(x.k)}"`} style="flex:${x.v.toFixed(2)};--k:${x.shade}%" title="${esc(x.k)} ${((x.v / tot) * 100).toFixed(1)}%"></button>`).join("")}</div>
    <div class="keys">${items.map((x) => `<span><i ${x.cash ? 'class="cash"' : ""} style="--k:${x.shade}%"></i><b>${esc(x.k)}</b>${((x.v / tot) * 100).toFixed(0)}%</span>`).join("")}</div>
  </div>`;
}

function posRow(t) {
  return `<button class="pos" data-a="open-ticker" data-id="${esc(t.ticker)}">
    <div style="min-width:0"><div class="tk">${esc(t.ticker)}${t.alerts.length ? `<span class="flag" title="${t.alerts.length} alerta(s)">!</span>` : ""}</div>
      <div class="nm">${esc(t.nombre)}, ${t.brokers.map((b) => esc(b.nombre)).join(" y ").replace(/ y (?=.* y )/g, ", ")}</div></div>
    <div><div class="v">${money(t.value)}</div><div class="s">${t.pct != null ? t.pct.toFixed(1) + "%" : "sin precio"}&nbsp;&nbsp;${irrText(t.irr)}</div></div>
  </button>`;
}
function closedRow(t) {
  return `<button class="pos" data-a="open-ticker" data-id="${esc(t.ticker)}">
    <div style="min-width:0"><div class="tk">${esc(t.ticker)}</div><div class="nm">${esc(t.nombre)}, ganancia realizada</div></div>
    <div><div class="v ${tone(t.gain)}">${signedMoney(t.gain)}</div><div class="s">TIR ${irrText(t.irr)}</div></div>
  </button>`;
}

// ---- brokers
function recClass(r) {
  if (!r || r.pct == null) return "";
  const a = Math.abs(r.pct);
  return a < 0.005 ? "ok" : a < 0.02 ? "warn" : "bad";
}
function recLine(r) {
  if (!r) return "";
  return `<div class="rec ${recClass(r)}">El broker reporta ${money(r.reportado)}${r.fecha ? ` el ${fmtDate(r.fecha)}` : ""}. Diferencia: <b>${money(r.diff)}</b> (${pct(r.pct, 2)}).</div>`;
}
function renderBrokers() {
  const p = S.pf;
  return `<section class="hero"><div class="label">Brokers</div><div class="total fig">${money(p.totalValue)}</div>
      <div class="facts"><div><span>Efectivo</span><b>${money(p.cash)}</b></div><div><span>En acciones</span><b>${money(p.holdingsValue)}</b></div></div>${warningsBox()}</section>
    <div class="brokers-grid">${p.brokers.map((b) => `
    <button class="broker" data-a="open-broker" data-id="${esc(b.id)}">
      <div class="h"><b>${esc(b.nombre)}${b.factor < 1 ? `<span class="share">${Math.round(b.factor * 100)}% tuyo</span>` : ""}</b><span class="v fig">${money(b.value)}</span></div>
      <div class="row2"><span>TIR <b>${irrText(b.irr)}</b></span><span>Efectivo <b>${money(b.cash)}</b></span><span><b>${b.positions.filter((x) => !x.closed).length}</b> posiciones</span></div>
      ${S.view === "total" ? recLine(b.reconciliation) : ""}
    </button>`).join("")}</div>`;
}

// ---- movimientos
function allMovs() {
  const out = [];
  for (const b of S.pf.brokers) for (const t of b.allTxs) out.push(t);
  return out.sort((x, y) => (x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : 0));
}
function txTitle(t) {
  const tipo = TIPOS[t.tipo] ? TIPOS[t.tipo].label : t.tipo;
  return `${esc(tipo)}${t.ticker ? ` <b>${esc(t.ticker)}</b>` : ""}`;
}
function txSub(t, showBroker) {
  const parts = [fmtDate(t.fecha)];
  if (showBroker && t.brokerNombre) parts.push(esc(t.brokerNombre));
  if (t.cantidad) parts.push(`${num(Math.abs(t.cantidad))} acc. a ${money(t.precio)}`);
  if (t.periodo && t.tipo !== "compra") parts.push(`periodo ${esc(t.periodo)}`);
  if (t.parcial) parts.push("causado a hoy");
  return parts.join(", ");
}
function txLine(t, showBroker = true) {
  const syn = !!t.sintetico;
  return `<button class="mv ${syn ? "syn" : ""}" ${syn ? 'tabindex="-1"' : `data-a="tx-sheet" data-b="${esc(t.brokerId)}" data-id="${esc(t.id)}"`}>
    <div class="t">${txTitle(t)}${syn ? " (estimado)" : ""}</div><div class="m ${t.monto < 0 ? "loss" : "gain"}">${signedMoney(t.monto)}</div>
    <div class="d">${txSub(t, showBroker)}</div><div></div>
  </button>`;
}
function txList(list, { showBroker = true, limit = 0, moreAction = "", grouped = false } = {}) {
  if (!list.length) return `<div class="panel pad small muted">Sin movimientos.</div>`;
  const shown = limit ? list.slice(0, limit) : list;
  let h = "", month = "";
  for (const t of shown) {
    const m = t.fecha.slice(0, 7);
    if (grouped && m !== month) { month = m; const [y, mm] = m.split("-").map(Number); h += `<div class="mv-month">${MESES_L[mm - 1]} ${y}</div>`; }
    h += txLine(t, showBroker);
  }
  if (limit && list.length > limit) h += `<button class="more" ${moreAction}>Ver ${list.length - limit} más</button>`;
  return `<div class="panel">${h}</div>`;
}
function renderMovimientos() {
  const f = S.movFilter;
  let list = allMovs();
  if (f.broker) list = list.filter((t) => t.brokerId === f.broker);
  if (f.ticker) list = list.filter((t) => t.ticker === f.ticker);
  if (f.kind === "efectivo") list = list.filter((t) => !t.ticker);
  if (f.kind === "acciones") list = list.filter((t) => t.ticker);
  const chip = (on, attrs, label) => `<button class="${on ? "on" : ""}" ${attrs}>${label}</button>`;
  return `<section class="hero"><div class="label">Movimientos</div><div class="total fig">${list.length}</div>
      <div class="facts"><div><span>${f.ticker ? `Solo ${esc(f.ticker)}` : "Todos los brokers y acciones"}</span>${f.ticker ? ` <button class="link" data-a="mov-ticker" data-v="">Quitar filtro</button>` : ""}</div></div></section>
    <div class="chips">
      ${chip(!f.broker, 'data-a="mov-broker" data-v=""', "Todos")}
      ${S.pf.brokers.map((b) => chip(f.broker === b.id, `data-a="mov-broker" data-v="${esc(b.id)}"`, esc(b.nombre))).join("")}
      ${chip(f.kind === "acciones", 'data-a="mov-kind" data-v="acciones"', "Acciones")}
      ${chip(f.kind === "efectivo", 'data-a="mov-kind" data-v="efectivo"', "Efectivo")}
    </div>
    ${txList(list, { limit: S.movLimit, moreAction: 'data-a="mov-more"', grouped: true })}`;
}

// ---- más
function renderMas() {
  return `<section class="hero"><div class="label">Más opciones</div></section>
    <div class="menu">
      <button data-a="refresh" ${S.busy ? "disabled" : ""}>${S.busy ? "Actualizando precios…" : "Actualizar precios"}<span>${lastPriceText()}</span></button>
      ${S.isOwner ? `<button data-a="prices">Precios manuales<span>Si falta algún precio</span></button>
      <button data-a="import">Importar CSV<span>Varios movimientos a la vez</span></button>
      <button data-a="config">Configuración<span>Brokers, tickers, alertas, acceso</span></button>` : ""}
      <button data-a="tax">Resumen fiscal<span>Excel para la declaración de renta</span></button>
    </div>
    <div class="menu" style="margin-top:16px"><button class="danger" data-a="logout">Cerrar sesión<span>${esc(S.user.email || "")}</span></button></div>
    ${S.isOwner ? "" : `<p class="small muted" style="margin-top:16px">Tienes acceso de solo lectura.</p>`}`;
}
function lastPriceText() {
  const live = readLS(LIVE_KEY);
  const ts = Object.values(live).map((p) => p.ts || 0).filter(Boolean);
  if (!ts.length) return "Sin actualizar";
  const min = Math.round((Date.now() - Math.max(...ts)) / 60000);
  return min < 60 ? `Hace ${min} min` : min < 1440 ? `Hace ${Math.round(min / 60)} h` : `Hace ${Math.round(min / 1440)} días`;
}

// ---- detalle de acción
function renderTicker(tk) {
  const t = S.pf.tickers.find((x) => x.ticker === tk);
  if (!t) { S.screen = { type: "home" }; return renderHome(); }
  const vsEntry = !t.closed && t.price && t.avgEntry ? t.price / t.avgEntry - 1 : null;
  const head = t.closed
    ? `<div class="d-head"><div class="tk">${esc(t.ticker)}<span class="closed-tag">Vendida</span></div><div class="nm">${esc(t.nombre)}</div>
        <div class="total fig ${tone(t.gain)}">${signedMoney(t.gain)}</div><div class="small muted">Ganancia realizada, incluidos dividendos</div></div>
       <div class="kpis"><div><div class="k">TIR</div><div class="v">${irrText(t.irr, 2)}</div></div><div><div class="k">VPN al 10%</div><div class="v">${money(t.npv)}</div></div><div><div class="k">Entrada prom.</div><div class="v">${money(t.avgEntry)}</div></div></div>`
    : `<div class="d-head"><div class="tk">${esc(t.ticker)}</div><div class="nm">${esc(t.nombre)}</div>
        <div class="total fig">${money(t.value)}</div>
        <div class="small muted">${num(t.shares)} acciones a ${money(t.price)}${vsEntry != null ? `, <span class="${tone(vsEntry)}">${signedPct(vsEntry)}</span> sobre tu entrada de ${money(t.avgEntry)}` : ""}${t.pe ? `. PE ${t.pe.toFixed(1)}x` : ""}</div></div>
       <div class="kpis"><div><div class="k">TIR</div><div class="v">${irrText(t.irr, 2)}</div></div><div><div class="k">Ganancia</div><div class="v ${tone(t.gain)}">${signedMoney(t.gain)}</div></div><div><div class="k">Peso</div><div class="v">${t.pct != null ? t.pct.toFixed(1) + "%" : "—"}</div></div></div>`;
  const left = `
    ${t.alerts.length ? `<section class="block"><h2>Alertas</h2>${t.alerts.map((a) => `<div class="alert"><b>${esc(a.label)}</b>${esc(a.detail)}</div>`).join("")}</section>` : ""}
    <section class="block"><h2>Por broker</h2><div class="panel"><table class="tbl">
      <tr><th>Broker</th><th class="n">Acciones</th><th class="n">${t.closed ? "TIR" : "Valor"}</th>${t.closed ? "" : '<th class="n">TIR</th>'}</tr>
      ${t.brokers.map((b) => `<tr class="click" data-a="open-broker" data-id="${esc(b.brokerId)}"><td>${esc(b.nombre)}</td><td class="n">${num(b.shares)}</td>${t.closed ? "" : `<td class="n">${money(b.value)}</td>`}<td class="n">${irrText(b.irr)}</td></tr>`).join("")}
    </table></div></section>
    ${t.closed ? "" : `<section class="block"><h2>Noticias relevantes <button class="link small" data-a="news-refresh" data-id="${esc(t.ticker)}">Actualizar</button></h2>
      <div class="panel news" id="news"><div class="empty">${proxyReady() ? "Buscando noticias…" : "Configura el proxy de precios para ver noticias."}</div></div></section>`}`;
  const right = `<section class="block"><h2>Movimientos <small>${t.txs.length}</small></h2>
    ${txList(t.txs, { limit: 6, moreAction: `data-a="mov-ticker" data-v="${esc(t.ticker)}"` })}</section>`;
  return `<button class="back" data-a="home">${ICON.back}Posiciones</button>${head}<div class="cols"><div>${left}</div><div>${right}</div></div>`;
}

// ---- detalle de broker
function renderBroker(id) {
  const b = S.pf.brokers.find((x) => x.id === id);
  const raw = brokerById(id);
  if (!b || !raw) { S.screen = { type: "home" }; return renderHome(); }
  const tasas = (raw.interes && raw.interes.tasas) || [];
  const movs = [...b.allTxs].sort((x, y) => (x.fecha < y.fecha ? 1 : -1));
  const openPos = b.positions.filter((x) => !x.closed), closedPos = b.positions.filter((x) => x.closed);
  const left = `
    <section class="block"><h2>Posiciones</h2><div class="panel"><table class="tbl">
      <tr><th>Acción</th><th class="n">Acciones</th><th class="n">Valor</th><th class="n">TIR</th></tr>
      ${openPos.map((x) => `<tr class="click" data-a="open-ticker" data-id="${esc(x.ticker)}"><td class="tk">${esc(x.ticker)}</td><td class="n">${num(x.shares)}</td><td class="n">${money(x.value)}</td><td class="n">${irrText(x.irr)}</td></tr>`).join("")}
      <tr><td>Efectivo</td><td></td><td class="n">${money(b.cash)}</td><td></td></tr>
      ${closedPos.map((x) => `<tr class="click" data-a="open-ticker" data-id="${esc(x.ticker)}"><td class="tk muted">${esc(x.ticker)} <span class="tiny">vendida</span></td><td></td><td></td><td class="n">${irrText(x.irr)}</td></tr>`).join("")}
    </table></div></section>
    ${tasas.length ? `<section class="block"><h2>Rendimiento del efectivo</h2><div class="panel pad small">
      Tasa vigente <b>${(Number([...tasas].sort((a, c) => (a.desde < c.desde ? 1 : -1))[0].tasa) * 100).toFixed(2)}% ${raw.interes.base === "nominal" ? "nominal" : "EA"}</b>, causada a diario sobre el saldo.
      Intereses estimados sin confirmar: <b>${money(b.estimatedInterest)}</b>.
      <div class="hint" style="margin:8px 0 0">Cuando el broker liquide un mes, registra el interés real con su periodo y reemplaza la estimación.</div></div></section>` : ""}
    <section class="block"><h2>Conciliación</h2><div class="panel pad">
      <div class="small">Valor calculado de la cuenta completa: <b>${money(b.valueFull)}</b></div>
      ${recLine(b.reconciliation) || '<div class="small muted" style="margin-top:6px">Aún no registras el saldo que muestra el broker.</div>'}
      ${S.isOwner ? `<div class="grid2" style="margin-top:12px">
        <div class="field"><label>Saldo que muestra el broker</label><input id="rec-val" type="number" step="0.01" inputmode="decimal" value="${esc(raw.saldoReportado ? raw.saldoReportado.valor : "")}"></div>
        <div class="field"><label>Fecha</label><input id="rec-fecha" type="date" value="${esc(raw.saldoReportado ? raw.saldoReportado.fecha : todayStr())}"></div></div>
        <button class="btn sm" data-a="save-rec" data-id="${esc(id)}">Guardar saldo</button>` : ""}
    </div></section>`;
  const right = `<section class="block"><h2>Movimientos <small>${movs.length}</small></h2>
    ${txList(movs, { showBroker: false, limit: 8, moreAction: `data-a="mov-broker-go" data-v="${esc(id)}"` })}</section>`;
  return `<button class="back" data-a="tab" data-v="brokers">${ICON.back}Brokers</button>
    <div class="d-head"><div class="tk">${esc(b.nombre)}${b.factor < 1 ? `<span class="share" style="vertical-align:6px">${Math.round(b.factor * 100)}% tuyo</span>` : ""}</div>
      <div class="total fig">${money(b.value)}</div></div>
    <div class="kpis"><div><div class="k">TIR</div><div class="v">${irrText(b.irr)}</div></div><div><div class="k">Efectivo</div><div class="v">${money(b.cash)}</div></div><div><div class="k">VPN al 10%</div><div class="v">${money(b.npv)}</div></div></div>
    <div class="cols"><div>${left}</div><div>${right}</div></div>`;
}

// ---- hoja de detalle de un movimiento
function txSheet(bId, id) {
  const raw = (S.txs[bId] || []).find((t) => t.id === id);
  if (!raw) return;
  const t = normalizeTx(raw);
  const b = brokerById(bId);
  const rows = [
    ["Fecha", fmtDate(t.fecha)], ["Broker", esc(b ? b.nombre : bId)],
    t.ticker ? ["Acción", `<b>${esc(t.ticker)}</b>`] : null,
    t.cantidad ? ["Cantidad", num(t.cantidad)] : null,
    t.precio ? ["Precio", money(t.precio)] : null,
    ["Efecto en el efectivo", `<span class="${t.monto < 0 ? "loss" : "gain"}">${signedMoney(t.monto)}</span>`],
    t.retencion ? ["Impuesto retenido", money(t.retencion)] : null,
    t.periodo ? ["Periodo", esc(t.periodo)] : null,
    t.nota ? ["Nota", esc(t.nota)] : null,
  ].filter(Boolean);
  openSheet(TIPOS[t.tipo] ? TIPOS[t.tipo].label : t.tipo, `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${S.isOwner ? `<div class="btn-row"><button class="btn" data-a="edit-tx" data-b="${esc(bId)}" data-id="${esc(id)}">Editar</button><button class="btn danger" data-a="del-tx" data-b="${esc(bId)}" data-id="${esc(id)}">Borrar</button></div>` : ""}`);
}

// ---------------------------------------------------------- resumen fiscal
const CLOSES_KEY = "pf_closes_v1";
function taxForm(year) {
  const years = yearsWithData(S.txs);
  const thisYear = Number(todayStr().slice(0, 4));
  if (!years.includes(thisYear)) years.unshift(thisYear);
  // por defecto, el último año completo (el que se declara)
  const Y = year || (years.find((y) => y < thisYear) ?? thisYear);
  const parcial = Y === thisYear;
  const held = tickersHeldAt(S.brokers, S.txs, Y, todayStr());
  const saved = (readLS(CLOSES_KEY)[Y]) || {};
  const live = {};
  for (const t of S.pf.tickers) live[t.ticker] = t.price;
  const trm = (readLS(CLOSES_KEY).trm || {})[Y] || "";
  const body = `
    <div class="field"><label>Año</label><select id="tx-year" data-a-change="tax-year">${years.map((y) => `<option value="${y}" ${y === Y ? "selected" : ""}>${y}${y === thisYear ? " (en curso)" : ""}</option>`).join("")}</select></div>
    <p class="small muted" style="margin-top:-4px">${parcial ? `El año no ha terminado: el corte es hoy, ${fmtDate(todayStr())}, con los precios actuales.` : `Corte al 31 de diciembre de ${Y}.`}
      ${S.view === "mine" || !S.isOwner ? "" : " El archivo trae el total de cada cuenta y tu parte."}</p>
    ${held.length ? `<h4 style="margin:16px 0 4px">Precios de cierre</h4>
      <div class="hint" style="margin:0 0 10px">${parcial ? "Puedes ajustarlos si quieres otra fecha." : `Precio al cierre del último día hábil de ${Y}. Lo encuentras en el certificado del broker o en Yahoo Finance (Historical data). Si dejas uno vacío, esa celda queda amarilla en el Excel.`}</div>
      <div class="grid3">${held.map((tk) => {
        const v = saved[tk] ?? (parcial && live[tk] ? live[tk].toFixed(2) : "");
        return `<div class="field"><label>${esc(tk)}</label><input class="tx-close" data-tk="${esc(tk)}" type="number" step="any" inputmode="decimal" value="${esc(v)}"></div>`;
      }).join("")}</div>` : ""}
    <div class="field" style="margin-top:6px"><label>TRM al corte (opcional)</label><input id="tx-trm" type="number" step="any" inputmode="decimal" placeholder="Ej. 4,000.00" value="${esc(trm)}"></div>
    <div class="hint">Con la TRM, el Excel calcula los valores en pesos. Si no la tienes, tu contadora puede escribirla en la celda amarilla.</div>
    <button class="btn primary block" style="margin-top:16px" data-a="tax-download" data-y="${Y}">Descargar Excel</button>`;
  openSheet("Resumen fiscal", body);
  document.getElementById("tx-year").addEventListener("change", (e) => taxForm(Number(e.target.value)));
}

async function taxDownload(btn) {
  const Y = Number(btn.dataset.y);
  const closes = {};
  document.querySelectorAll(".tx-close").forEach((i) => { if (i.value !== "") closes[i.dataset.tk] = Number(i.value); });
  const trm = val("tx-trm");
  const store = readLS(CLOSES_KEY);
  store[Y] = closes; store.trm = { ...(store.trm || {}), [Y]: trm };
  writeLS(CLOSES_KEY, store);
  btn.disabled = true; btn.textContent = "Preparando…";
  try {
    const personas = { [S.access.shareKey || "andres"]: S.access.nombre || "Yo" };
    if (S.isOwner) { try { for (const a of await S.store.listAccess()) if (a.shareKey && a.nombre && a.rol !== "owner") personas[a.shareKey] = a.nombre; } catch {} }
    const report = buildTaxReport({ brokers: S.brokers, txs: S.txs, year: Y, shareKey: S.access.shareKey || "andres", closes, today: todayStr() });
    const { downloadTaxExcel } = await import("./tax-excel.js");
    const name = await downloadTaxExcel(report, { trm: trm ? Number(trm) : null, personas, quien: S.access.nombre || S.user.nombre, base: import.meta.url });
    toast(`Descargado ${name}`);
  } catch (e) { toast("Error: " + e.message, 4000); }
  btn.disabled = false; btn.textContent = "Descargar Excel";
}

// --------------------------------------------------------------- noticias
async function loadNews(tk, force = false) {
  const box = document.getElementById("news");
  if (!box || !proxyReady()) return;
  const key = apiSym(tk);
  let arts = !force && S.newsCache[key];
  if (!arts) {
    try {
      const j = await proxyCall({ action: "news", symbol: key });
      arts = j.data || [];
      S.newsCache[key] = arts;
    } catch (e) {
      const b = document.getElementById("news");
      if (b) b.innerHTML = `<div class="empty loss">No se pudieron traer noticias: ${esc(e.message)}</div>`;
      return;
    }
  }
  const kws = (S.settings.newsKeywords && S.settings.newsKeywords.length ? S.settings.newsKeywords : DEFAULT_NEWS_KEYWORDS).map((k) => k.toLowerCase());
  const rel = arts.filter((a) => {
    const txt = `${a.headline || ""} ${a.summary || ""}`.toLowerCase();
    return kws.some((k) => txt.includes(k));
  }).slice(0, 10);
  const b2 = document.getElementById("news");
  if (!b2 || S.screen.id !== tk) return;
  b2.innerHTML = rel.length
    ? rel.map((a) => `<a href="${esc(/^https?:\/\//.test(a.url) ? a.url : "#")}" target="_blank" rel="noopener noreferrer"><div class="h">${esc(a.headline)}</div>
        ${a.summary ? `<div class="muted small">${esc(a.summary.slice(0, 180))}${a.summary.length > 180 ? "…" : ""}</div>` : ""}
        <div class="src">${esc(a.source)}, ${fmtDate(a.date)}</div></a>`).join("")
    : `<div class="empty">No hay noticias cualitativamente relevantes en los últimos 90 días (liderazgo, demandas, regulación, competencia, M&A…). No significa que no haya cobertura, solo que ninguna pasó el filtro.</div>`;
}

// ------------------------------------------------------------- formularios
function openSheet(title, body) {
  closeSheet();
  const bg = document.createElement("div");
  bg.className = "sheet-bg"; bg.id = "sheet";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><h3>${esc(title)}<button class="link" data-a="close">Cerrar</button></h3>${body}</div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) closeSheet(); });
  document.body.appendChild(bg);
}
function closeSheet() { const s = document.getElementById("sheet"); if (s) s.remove(); }
const val = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ""; };

const FORM_TIPOS = [
  ["compra", "Compra"], ["venta", "Venta"], ["dividendo", "Dividendo en efectivo"],
  ["dividendo_reinvertido", "Dividendo reinvertido"], ["deposito", "Depósito (fondeo)"],
  ["retiro", "Retiro"], ["interes", "Interés (real, del extracto)"], ["comision", "Comisión"],
  ["transferencia", "Transferencia entre brokers"], ["saldo_inicial", "Saldo inicial (ancla)"],
];

function txForm(edit) {
  const brokers = S.brokers;
  if (!brokers.length) { toast("Primero crea un broker en Configuración"); return; }
  const t = edit ? edit.tx : null;
  const tipo = t ? t.tipo : "compra";
  const bId = edit ? edit.brokerId : (S.screen.type === "broker" ? S.screen.id : brokers[0].id);
  const com = t && t.tipo === "compra" && t.cantidad && t.precio ? -t.monto - t.cantidad * t.precio
    : t && t.tipo === "venta" && t.cantidad && t.precio ? -t.cantidad * t.precio - t.monto : 0;
  const body = `
    <div class="grid2">
      <div class="field"><label>Broker</label><select id="f-broker" ${edit ? "disabled" : ""}>${brokers.map((b) => `<option value="${esc(b.id)}" ${b.id === bId ? "selected" : ""}>${esc(b.nombre)}</option>`).join("")}</select></div>
      <div class="field"><label>Tipo</label><select id="f-tipo" ${edit ? "disabled" : ""}>${(edit ? [[tipo, TIPOS[tipo].label]] : FORM_TIPOS).map(([v, l]) => `<option value="${v}" ${v === tipo ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label>Fecha</label><input id="f-fecha" type="date" value="${esc(t ? t.fecha : todayStr())}"></div>
    <div id="f-dyn"></div>
    <div class="field"><label>Nota (opcional)</label><input id="f-nota" value="${esc(t && t.nota ? t.nota : "")}"></div>
    <div class="preview" id="f-prev"></div>
    <button class="btn primary" data-a="save-tx" ${edit ? `data-b="${esc(edit.brokerId)}" data-id="${esc(t.id)}"` : ""}>Guardar movimiento</button>`;
  openSheet(edit ? "Editar movimiento" : "Nuevo movimiento", body);
  const dyn = () => {
    const tp = val("f-tipo"), b = brokerById(val("f-broker"));
    const tks = Object.keys((b && b.tickers) || {}).sort();
    const tickerSel = (opt) => `<div class="field"><label>Ticker${opt ? " (opcional)" : ""}</label><select id="f-ticker">${opt ? '<option value="">— ninguno —</option>' : ""}${tks.map((x) => `<option ${t && t.ticker === x ? "selected" : ""}>${esc(x)}</option>`).join("")}${edit ? "" : '<option value="__new">+ Nuevo ticker…</option>'}</select></div>
      <div id="f-new" style="display:none" class="grid3"><div class="field"><label>Ticker</label><input id="f-ntk" placeholder="ACN"></div><div class="field"><label>Nombre</label><input id="f-nnm" placeholder="Accenture"></div><div class="field"><label>Símbolo Finnhub</label><input id="f-nsym" placeholder="igual al ticker"></div></div>`;
    let h = "";
    if (tp === "compra" || tp === "venta") {
      h = tickerSel(false) + `<div class="grid3"><div class="field"><label>Cantidad</label><input id="f-q" type="number" step="any" inputmode="decimal" value="${t ? Math.abs(t.cantidad) : ""}"></div>
        <div class="field"><label>Precio</label><input id="f-p" type="number" step="any" inputmode="decimal" value="${t ? t.precio : ""}"></div>
        <div class="field"><label>Comisión</label><input id="f-c" type="number" step="any" inputmode="decimal" value="${com ? com.toFixed(2) : ""}"></div></div>`;
    } else if (tp === "dividendo_reinvertido" || tp === "compra_reinversion") {
      h = tickerSel(false) + `<div class="grid3"><div class="field"><label>Monto dividendo</label><input id="f-m" type="number" step="any" inputmode="decimal" value="${t ? Math.abs(t.monto) : ""}"></div>
        <div class="field"><label>Acciones recibidas</label><input id="f-q" type="number" step="any" inputmode="decimal" value="${t ? t.cantidad : ""}"></div>
        <div class="field"><label>Precio</label><input id="f-p" type="number" step="any" inputmode="decimal" value="${t ? t.precio : ""}"></div></div>
        ${tp === "dividendo_reinvertido" ? `<div class="grid2">${retField(t)}</div>` : ""}`;
    } else if (tp === "dividendo") {
      h = tickerSel(false) + `<div class="grid2"><div class="field"><label>Monto recibido</label><input id="f-m" type="number" step="any" inputmode="decimal" value="${t ? t.monto : ""}"></div>${retField(t)}</div>`;
    } else if (tp === "comision") {
      h = tickerSel(true) + `<div class="field"><label>Monto de la comisión</label><input id="f-m" type="number" step="any" inputmode="decimal" value="${t ? Math.abs(t.monto) : ""}"></div>`;
    } else if (tp === "interes") {
      const f = val("f-fecha") || todayStr();
      h = `<div class="grid2"><div class="field"><label>Monto del interés</label><input id="f-m" type="number" step="any" inputmode="decimal" value="${t ? t.monto : ""}"></div>
        <div class="field"><label>Mes al que corresponde</label><input id="f-per" type="month" value="${esc(t && t.periodo ? t.periodo : prevMonthStr(f))}"></div></div>
        <div class="grid2">${retField(t)}</div>
        <div class="hint">Reemplaza la estimación automática de ese mes.</div>`;
    } else if (tp === "transferencia") {
      h = `<div class="grid2"><div class="field"><label>Dirección</label><select id="f-dir"><option value="in" ${t && t.monto < 0 ? "" : "selected"}>Entra a este broker</option><option value="out" ${t && t.monto < 0 ? "selected" : ""}>Sale de este broker</option></select></div>
        <div class="field"><label>Monto</label><input id="f-m" type="number" step="any" inputmode="decimal" value="${t ? Math.abs(t.monto) : ""}"></div></div>
        <div class="hint">Registra las dos puntas (sale de uno, entra al otro) para que no cuente como dinero nuevo.</div>`;
    } else {
      h = `<div class="field"><label>Monto</label><input id="f-m" type="number" step="any" inputmode="decimal" value="${t ? Math.abs(t.monto) : ""}"></div>`;
      if (tp === "saldo_inicial") h += `<div class="hint">El efectivo conocido en esta fecha. Los movimientos anteriores ya están dentro de este saldo; las compras anteriores se toman como dinero que entró de afuera.</div>`;
    }
    document.getElementById("f-dyn").innerHTML = h;
    const sel = document.getElementById("f-ticker");
    if (sel) sel.addEventListener("change", () => { document.getElementById("f-new").style.display = sel.value === "__new" ? "grid" : "none"; prev(); });
    document.querySelectorAll("#f-dyn input, #f-dyn select").forEach((e) => e.addEventListener("input", prev));
    prev();
  };
  const prev = () => {
    const r = buildTxFromForm(true);
    document.getElementById("f-prev").innerHTML = r.error ? `<span class="loss">${esc(r.error)}</span>`
      : r.txs.map((x) => `${esc(TIPOS[x.tipo].label)}${x.ticker ? " " + esc(x.ticker) : ""}: <b class="mono ${x.monto < 0 ? "loss" : "gain"}">${money(x.monto)}</b> sobre el efectivo`).join("<br>");
  };
  document.getElementById("f-tipo").addEventListener("change", dyn);
  document.getElementById("f-broker").addEventListener("change", dyn);
  document.getElementById("f-fecha").addEventListener("change", () => { if (val("f-tipo") === "interes" && !edit) dyn(); });
  dyn();
}

function retField(t) {
  return `<div class="field"><label>Impuesto retenido (opcional)</label><input id="f-ret" type="number" step="any" inputmode="decimal" placeholder="0.00" value="${t && t.retencion ? t.retencion : ""}"></div>`;
}

function buildTxFromForm(quiet) {
  const tp = val("f-tipo"), fecha = val("f-fecha"), nota = val("f-nota") || undefined;
  const n = (id) => { const v = val(id); return v === "" ? null : Number(v); };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: "Fecha inválida" };
  let ticker = null, newTicker = null;
  const sel = document.getElementById("f-ticker");
  if (sel) {
    if (sel.value === "__new") {
      const tk = val("f-ntk").toUpperCase();
      if (!tk) return { error: "Escribe el ticker nuevo" };
      newTicker = { ticker: tk, nombre: val("f-nnm") || tk, apiSymbol: (val("f-nsym") || tk).toUpperCase() };
      ticker = tk;
    } else ticker = sel.value || null;
  }
  const q = n("f-q"), p = n("f-p"), c = n("f-c") || 0, m = n("f-m");
  const ret = n("f-ret");
  if (ret != null && (isNaN(ret) || ret < 0)) return { error: "Impuesto retenido inválido" };
  const R = ret ? { retencion: ret } : {};
  const need = (x, msg) => (x == null || isNaN(x) || x <= 0 ? msg : null);
  let txs = [], err = null;
  if (tp === "compra" || tp === "venta") {
    err = (!ticker && "Elige un ticker") || need(q, "Cantidad inválida") || need(p, "Precio inválido");
    if (!err) txs = [tp === "compra"
      ? { tipo: "compra", ticker, cantidad: q, precio: p, monto: -(q * p + c) }
      : { tipo: "venta", ticker, cantidad: -q, precio: p, monto: q * p - c }];
  } else if (tp === "dividendo_reinvertido" || tp === "compra_reinversion") {
    err = (!ticker && "Elige un ticker") || need(m, "Monto inválido") || need(q, "Cantidad inválida") || need(p, "Precio inválido");
    if (!err) txs = tp === "compra_reinversion"
      ? [{ tipo: "compra_reinversion", ticker, cantidad: q, precio: p, monto: -m }]
      : [{ tipo: "dividendo", ticker, monto: m, ...R }, { tipo: "compra_reinversion", ticker, cantidad: q, precio: p, monto: -m }];
  } else if (tp === "dividendo") {
    err = (!ticker && "Elige un ticker") || need(m, "Monto inválido");
    if (!err) txs = [{ tipo: "dividendo", ticker, monto: m, ...R }];
  } else if (tp === "comision") {
    err = need(m, "Monto inválido");
    if (!err) txs = [{ tipo: "comision", ticker: ticker || null, monto: -m }];
  } else if (tp === "interes") {
    err = (m == null || isNaN(m) ? "Monto inválido" : null) || (!/^\d{4}-\d{2}$/.test(val("f-per")) ? "Mes inválido" : null);
    if (!err) txs = [{ tipo: "interes", monto: m, periodo: val("f-per"), ...R }];
  } else if (tp === "transferencia") {
    err = need(m, "Monto inválido");
    if (!err) txs = [{ tipo: "transferencia", monto: val("f-dir") === "out" ? -m : m }];
  } else {
    err = need(m, "Monto inválido");
    if (!err) txs = [{ tipo: tp, monto: tp === "retiro" ? -m : m }];
  }
  if (err) return { error: quiet && !val("f-q") && !val("f-m") ? "Completa los datos" : err };
  return { txs: txs.map((x) => normalizeTx({ cantidad: null, precio: null, ticker: null, ...x, fecha, ...(nota ? { nota } : {}) })), newTicker };
}

async function saveTx(btn) {
  const r = buildTxFromForm(false);
  if (r.error) { toast(r.error); return; }
  const bId = btn.dataset.b || val("f-broker");
  btn.disabled = true;
  try {
    if (r.newTicker) {
      const b = brokerById(bId);
      const tickers = { ...(b.tickers || {}), [r.newTicker.ticker]: { nombre: r.newTicker.nombre, apiSymbol: r.newTicker.apiSymbol } };
      await S.store.saveBroker(bId, { tickers });
    }
    if (btn.dataset.id) await S.store.updateTx(bId, btn.dataset.id, r.txs[0]);
    else for (const tx of r.txs) await S.store.addTx(bId, tx);
    closeSheet(); await reload(); toast("Movimiento guardado");
  } catch (e) { toast("Error: " + e.message, 4000); btn.disabled = false; }
}

function editTx(bId, id) {
  const tx = (S.txs[bId] || []).find((t) => t.id === id);
  if (!tx) return;
  txForm({ brokerId: bId, tx: normalizeTx(tx) });
}

async function delTx(bId, id) {
  const tx = (S.txs[bId] || []).find((t) => t.id === id);
  if (!tx || !confirm(`¿Borrar ${TIPOS[tx.tipo] ? TIPOS[tx.tipo].label.toLowerCase() : tx.tipo} del ${tx.fecha} por ${money(Number(tx.monto))}? No se puede deshacer.`)) return;
  try { await S.store.deleteTx(bId, id); closeSheet(); S.keepScroll = true; await reload(); toast("Movimiento borrado"); }
  catch (e) { toast("Error: " + e.message, 4000); }
}

// ---- precios manuales
function pricesForm() {
  const tks = heldTickers().sort();
  openSheet("Precios manuales", `<div class="hint" style="margin-bottom:12px">Úsalo si el proxy no trae algún ticker. El precio manual se usa hasta la próxima actualización automática exitosa.</div>
    ${tks.map((t) => `<div class="field"><label><b>${esc(t)}</b> ${esc(tickerMeta(t).nombre || "")}</label><input id="mp-${esc(t.replace(/\W/g, "_"))}" type="number" step="any" inputmode="decimal" value="${S.prices[t] ? S.prices[t].price : ""}"></div>`).join("")}
    <button class="btn primary" data-a="save-prices">Guardar precios</button>`);
}
async function savePrices() {
  const today = todayStr(), ts = Date.now();
  try {
    for (const b of S.brokers) {
      const own = new Set((S.txs[b.id] || []).filter((t) => t.ticker).map((t) => t.ticker));
      const pm = { ...(b.preciosManuales || {}) };
      let changed = false;
      for (const t of heldTickers()) {
        const v = val(`mp-${t.replace(/\W/g, "_")}`);
        if (own.has(t) && v && Number(v) > 0 && (!S.prices[t] || Number(v) !== S.prices[t].price)) { pm[t] = { price: Number(v), date: today, ts }; changed = true; }
      }
      if (changed) await S.store.saveBroker(b.id, { preciosManuales: pm });
    }
    closeSheet(); await reload(); toast("Precios guardados");
  } catch (e) { toast("Error: " + e.message, 4000); }
}

// ---- importar CSV
function importForm() {
  openSheet("Importar movimientos (CSV)", `
    <div class="hint" style="margin-bottom:10px">Columnas: <span class="mono">broker,fecha,ticker,tipo,cantidad,precio,monto</span> (opcionales: <span class="mono">periodo,nota</span>). Fecha AAAA-MM-DD. El broker debe existir (usa su id: ${S.brokers.map((b) => `<span class="mono">${esc(b.id)}</span>`).join(", ") || "ninguno aún"}).</div>
    <div class="field"><label>Archivo</label><input id="imp-file" type="file" accept=".csv,text/csv"></div>
    <div class="field"><label>…o pega el contenido</label><textarea id="imp-text" placeholder="broker,fecha,ticker,tipo,cantidad,precio,monto"></textarea></div>
    <button class="btn" data-a="imp-check">Revisar</button>
    <div id="imp-out"></div>`);
  document.getElementById("imp-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (f) document.getElementById("imp-text").value = await f.text();
  });
}
let pendingImport = null;
function importCheck() {
  const { rows, errors } = parseCsv(document.getElementById("imp-text").value);
  const by = {};
  const unknown = new Set();
  rows.forEach((r) => { if (!brokerById(r.broker)) unknown.add(r.broker); (by[r.broker] ||= []).push(r.tx); });
  unknown.forEach((u) => errors.push(`El broker "${u}" no existe. Créalo en Configuración con ese id.`));
  pendingImport = errors.length ? null : by;
  document.getElementById("imp-out").innerHTML = `<div class="preview">
    ${Object.entries(by).map(([b, l]) => `<div><b>${esc(b)}</b>: ${l.length} movimientos (${l.filter((x) => x.ticker).length} con ticker)</div>`).join("") || "Sin filas válidas."}
    ${errors.length ? `<div class="loss" style="margin-top:8px">${errors.slice(0, 15).map(esc).join("<br>")}${errors.length > 15 ? `<br>…y ${errors.length - 15} más` : ""}</div>` : ""}</div>
    ${pendingImport ? `<label class="check"><input type="checkbox" id="imp-replace"> Reemplazar los movimientos actuales de ${Object.keys(by).map(esc).join(", ")}</label>
    <div class="hint">Marca esta casilla si el archivo trae el historial completo de ese broker (por ejemplo, tu Excel de Schwab actualizado). Si no, los movimientos se agregan a los existentes.</div>
    <button class="btn primary" data-a="imp-go" style="margin-top:10px">Importar</button>` : ""}`;
}
async function importGo(btn) {
  if (!pendingImport) return;
  const replace = document.getElementById("imp-replace").checked;
  if (replace && !confirm("Se borrarán los movimientos actuales de esos brokers y se reemplazarán por el archivo. ¿Continuar?")) return;
  btn.disabled = true;
  try {
    for (const [bId, list] of Object.entries(pendingImport)) {
      const b = brokerById(bId);
      const tickers = { ...(b.tickers || {}) };
      let add = false;
      list.forEach((t) => { if (t.ticker && !tickers[t.ticker]) { tickers[t.ticker] = { nombre: t.ticker, apiSymbol: t.ticker }; add = true; } });
      if (add) await S.store.saveBroker(bId, { tickers });
    }
    await S.store.importTxs(pendingImport, replace);
    pendingImport = null; closeSheet(); await reload(); toast("Importación lista");
  } catch (e) { toast("Error: " + e.message, 5000); btn.disabled = false; }
}

// ---- configuración
async function configForm() {
  let access = [];
  try { access = (await S.store.listAccess()).filter((a) => a.rol !== "owner"); } catch {}
  const keys = [...new Set([S.access.shareKey, ...access.map((a) => a.shareKey).filter(Boolean)])];
  const cfg = { ...DEFAULT_ALERT_CONFIG, ...(S.settings.alertConfig || {}) };
  const allTk = [...new Set(S.brokers.flatMap((b) => Object.keys(b.tickers || {})))].sort();
  const kws = S.settings.newsKeywords && S.settings.newsKeywords.length ? S.settings.newsKeywords : DEFAULT_NEWS_KEYWORDS;
  const bBlock = (b) => {
    const tasas = (b.interes && b.interes.tasas) || [];
    return `<div class="card" data-broker="${esc(b.id)}">
      <div class="card-h"><b>${esc(b.nombre)}</b><span class="tiny muted mono">id: ${esc(b.id)}</span></div>
      <div class="grid2" style="margin-top:10px"><div class="field"><label>Nombre</label><input class="b-nombre" value="${esc(b.nombre)}"></div>
        <div class="field"><label>Fecha ancla (opcional)</label><input class="b-anchor" type="date" value="${esc(b.anchorDate || "")}"></div></div>
      <div class="hint" style="margin:-4px 0 8px">Ancla: solo si no tienes el historial de depósitos de este broker (como Schwab hasta ahora). Déjala vacía si importas depósitos.</div>
      <div class="grid3">${keys.map((k) => `<div class="field"><label>Participación ${esc(k)} %</label><input class="b-share" data-k="${esc(k)}" type="number" step="any" value="${b.shares && b.shares[k] != null ? +(b.shares[k] * 100).toFixed(4) : ""}"></div>`).join("")}</div>
      <div class="grid2"><div class="field"><label>Rendimiento del efectivo</label><select class="b-base"><option value="">No genera intereses</option><option value="EA" ${(b.interes && b.interes.base !== "nominal" && tasas.length) || (!b.interes && b.id === "tyba") ? "selected" : ""}>Tasa efectiva anual (EA)</option><option value="nominal" ${b.interes && b.interes.base === "nominal" ? "selected" : ""}>Tasa nominal anual</option></select></div>
        <div class="field"><label>Tasa anual en %, desde una fecha</label><textarea class="b-tasas" style="min-height:60px" placeholder="2026-01-01 = 3.5">${tasas.map((t) => `${t.desde} = ${+(t.tasa * 100).toFixed(4)}`).join("\n")}</textarea></div></div>
      <button class="btn sm" data-a="save-broker" data-id="${esc(b.id)}">Guardar ${esc(b.nombre)}</button></div>`;
  };
  openSheet("Configuración", `
    <div class="cfg"><h4>Brokers</h4>
      ${S.brokers.map(bBlock).join("")}
      <div class="grid2"><div class="field"><label>Nuevo broker</label><input id="nb-nombre" placeholder="Ej. Tyba"></div>
        <div class="field"><label>&nbsp;</label><button class="btn" data-a="new-broker">+ Crear broker</button></div></div>
      <div class="hint">El id se genera del nombre (Tyba → <span class="mono">tyba</span>) y es el que usas en el CSV.</div></div>

    <div class="cfg"><h4>Tickers</h4>
      ${allTk.length ? `<div class="scroll-x"><table class="tbl"><tr><th>Ticker</th><th>Nombre</th><th>Símbolo</th><th>PE ind.</th></tr>
      ${allTk.map((t) => { const m = tickerMeta(t); const id = t.replace(/\W/g, "_"); return `<tr><td class="mono">${esc(t)}</td>
        <td><input id="tm-n-${id}" value="${esc(m.nombre || "")}" style="width:100%;min-width:110px"></td>
        <td><input id="tm-s-${id}" value="${esc(m.apiSymbol || t)}" style="width:80px"></td>
        <td><input id="tm-p-${id}" type="number" step="any" value="${esc(m.industryPE ?? "")}" style="width:64px"></td></tr>`; }).join("")}</table></div>
      <div class="hint">Símbolo: como lo reconoce Finnhub. PE ind.: deja vacío para desactivar la alerta de valoración.</div>
      <button class="btn sm" data-a="save-tickers" style="margin-top:8px">Guardar tickers</button>` : '<div class="muted small">Aún no hay tickers.</div>'}</div>

    <div class="cfg"><h4>Alertas</h4>
      <div class="grid2">
        <div class="field"><label>PE > PE industria ×</label><input id="al-pe" type="number" step="0.05" value="${cfg.peMultiplier}"></div>
        <div class="field"><label>Cerca del máximo 52s (fracción)</label><input id="al-hi" type="number" step="0.01" value="${cfg.highProximityPct}"></div>
        <div class="field"><label>Current ratio mínimo</label><input id="al-cr" type="number" step="0.1" value="${cfg.currentRatioMin}"></div>
        <div class="field"><label>Deuda/patrimonio máximo</label><input id="al-de" type="number" step="0.1" value="${cfg.debtEquityMax}"></div>
        <div class="field"><label>Concentración máxima %</label><input id="al-co" type="number" step="1" value="${cfg.concentrationMaxPct}"></div>
      </div>
      <button class="btn sm" data-a="save-alerts">Guardar alertas</button></div>

    <div class="cfg"><h4>Noticias</h4>
      <div class="field"><label>Palabras clave (separadas por coma)</label><textarea id="kw" style="min-height:90px">${esc(kws.join(", "))}</textarea></div>
      <button class="btn sm" data-a="save-kw">Guardar palabras clave</button></div>

    <div class="cfg"><h4>Acceso de lectura</h4>
      ${access.length ? access.map((a) => `<div class="card small"><div class="card-h"><span><b>${esc(a.nombre || "")}</b> ${esc(a.email)}</span><button class="link loss small" data-a="del-access" data-id="${esc(a.email)}">Quitar</button></div>
        <div class="muted tiny" style="margin-top:4px">Ve ${(a.brokers || []).map(esc).join(", ") || "nada"}, con la clave de participación ${esc(a.shareKey)}</div></div>`).join("") : '<div class="muted small">Nadie más tiene acceso.</div>'}
      <div class="grid2" style="margin-top:8px"><div class="field"><label>Correo de Google</label><input id="ac-email" type="email" placeholder="correo@gmail.com"></div>
        <div class="field"><label>Nombre</label><input id="ac-nombre" placeholder="Ricardo"></div></div>
      <div class="field"><label>Clave de participación</label><input id="ac-key" placeholder="ricardo"><div class="hint">La misma clave que usas en la participación del broker (ej. ricardo → Schwab 50%).</div></div>
      <div class="field"><label>Brokers que puede ver (solo lectura)</label>${S.brokers.map((b) => `<label class="check"><input type="checkbox" class="ac-b" value="${esc(b.id)}"> ${esc(b.nombre)}</label>`).join("")}</div>
      <button class="btn sm" data-a="add-access">Dar acceso</button>
      <div class="hint">La restricción la aplica el servidor de Firebase: aunque alguien manipule la página, no recibe datos de los brokers que no le asignaste.</div></div>`);
}

async function saveBrokerCfg(id) {
  const card = document.querySelector(`[data-broker="${CSS.escape(id)}"]`);
  const shares = {};
  card.querySelectorAll(".b-share").forEach((i) => { if (i.value !== "") shares[i.dataset.k] = Number(i.value) / 100; });
  const sum = Object.values(shares).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.0001) { toast(`Las participaciones suman ${(sum * 100).toFixed(2)}%; deben sumar 100%`); return; }
  const base = card.querySelector(".b-base").value;
  const tasas = [];
  for (const line of card.querySelector(".b-tasas").value.split("\n").map((l) => l.trim()).filter(Boolean)) {
    // acepta "2026-01-01 = 3.5", "2026-01-01 3,5%", "2026-01-01: 3.5" o solo "3.5" (aplica desde siempre)
    const m = line.match(/^(?:(\d{4}-\d{2}-\d{2})\s*[=:]?\s*)?(\d+(?:[.,]\d+)?)\s*%?$/);
    const tasa = m ? Number(m[2].replace(",", ".")) : NaN;
    if (!m || !(tasa >= 0 && tasa < 100)) { toast(`No entendí la tasa "${line}". Escríbela así: 2026-01-01 = 3.5`); return; }
    tasas.push({ desde: m[1] || "2000-01-01", tasa: tasa / 100 });
  }
  const data = {
    nombre: card.querySelector(".b-nombre").value.trim() || id,
    anchorDate: card.querySelector(".b-anchor").value || null,
    shares,
    interes: base && tasas.length ? { base, tasas } : null,
  };
  try { await S.store.saveBroker(id, data); await reload(); toast("Broker guardado"); configForm(); }
  catch (e) { toast("Error: " + e.message, 4000); }
}

async function newBroker() {
  const nombre = val("nb-nombre");
  if (!nombre) return toast("Escribe el nombre del broker");
  const id = slug(nombre);
  if (!id || brokerById(id)) return toast("Ya existe un broker con ese id");
  try {
    await S.store.saveBroker(id, { nombre, orden: S.brokers.length + 1, shares: { [S.access.shareKey]: 1 }, tickers: {} });
    await reload(); toast(`Broker ${nombre} creado (id: ${id})`); configForm();
  } catch (e) { toast("Error: " + e.message, 4000); }
}

async function saveTickers() {
  try {
    for (const b of S.brokers) {
      const tickers = { ...(b.tickers || {}) };
      let ch = false;
      for (const t of Object.keys(tickers)) {
        const id = t.replace(/\W/g, "_");
        const pe = val(`tm-p-${id}`);
        tickers[t] = { ...tickers[t], nombre: val(`tm-n-${id}`) || t, apiSymbol: (val(`tm-s-${id}`) || t).toUpperCase(), industryPE: pe === "" ? null : Number(pe) };
        ch = true;
      }
      if (ch) await S.store.saveBroker(b.id, { tickers });
    }
    await reload(); toast("Tickers guardados");
  } catch (e) { toast("Error: " + e.message, 4000); }
}

async function saveAlerts() {
  const alertConfig = { peMultiplier: +val("al-pe"), highProximityPct: +val("al-hi"), currentRatioMin: +val("al-cr"), debtEquityMax: +val("al-de"), concentrationMaxPct: +val("al-co") };
  try { await S.store.saveSettings({ alertConfig }); await reload(); toast("Alertas guardadas"); } catch (e) { toast("Error: " + e.message, 4000); }
}
async function saveKw() {
  const newsKeywords = val("kw").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  try { await S.store.saveSettings({ newsKeywords }); S.settings.newsKeywords = newsKeywords; toast("Palabras clave guardadas"); } catch (e) { toast("Error: " + e.message, 4000); }
}
async function addAccess() {
  const email = val("ac-email").toLowerCase(), nombre = val("ac-nombre"), shareKey = slug(val("ac-key") || nombre);
  const brokers = [...document.querySelectorAll(".ac-b:checked")].map((i) => i.value);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Correo inválido");
  if (email === S.user.email) return toast("Ese es tu propio correo");
  if (!brokers.length) return toast("Elige al menos un broker");
  try { await S.store.setAccess(email, { rol: "viewer", nombre: nombre || email, shareKey, brokers }); toast("Acceso otorgado"); configForm(); }
  catch (e) { toast("Error: " + e.message, 4000); }
}
async function delAccess(email) {
  if (!confirm(`¿Quitar el acceso de ${email}?`)) return;
  try { await S.store.removeAccess(email); toast("Acceso retirado"); configForm(); } catch (e) { toast("Error: " + e.message, 4000); }
}
async function saveRec(id) {
  const v = val("rec-val");
  try {
    await S.store.saveBroker(id, { saldoReportado: v === "" ? null : { valor: Number(v), fecha: val("rec-fecha") } });
    await reload(); toast("Saldo reportado guardado");
  } catch (e) { toast("Error: " + e.message, 4000); }
}

// ---------------------------------------------------------------- eventos
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-a]");
  if (!el) return;
  const a = el.dataset.a, id = el.dataset.id;
  const go = (screen) => { S.screen = screen; render(); window.scrollTo(0, 0); };
  switch (a) {
    case "view": S.view = el.dataset.v; compute(); render(); break;
    case "tab": S.tab = el.dataset.v; go({ type: "home" }); break;
    case "home": go({ type: "home" }); break;
    case "toggle-closed": S.showClosed = !S.showClosed; S.keepScroll = true; render(); break;
    case "tx-sheet": txSheet(el.dataset.b, id); break;
    case "mov-broker": S.movFilter.broker = el.dataset.v; S.movLimit = 30; S.keepScroll = true; render(); break;
    case "mov-kind": S.movFilter.kind = S.movFilter.kind === el.dataset.v ? "" : el.dataset.v; S.movLimit = 30; S.keepScroll = true; render(); break;
    case "mov-more": S.movLimit += 50; S.keepScroll = true; render(); break;
    case "mov-ticker": S.movFilter = { broker: "", ticker: el.dataset.v, kind: "" }; S.movLimit = 30; S.tab = "movimientos"; go({ type: "home" }); break;
    case "mov-broker-go": S.movFilter = { broker: el.dataset.v, ticker: "", kind: "" }; S.movLimit = 30; S.tab = "movimientos"; go({ type: "home" }); break;
    case "open-ticker": go({ type: "ticker", id }); break;
    case "open-broker": go({ type: "broker", id }); break;
    case "refresh": refreshPrices(true); break;
    case "logout": S.store.signOut(); break;
    case "login": S.store.signIn().catch((err) => toast("No se pudo iniciar sesión: " + err.message, 5000)); break;
    case "close": closeSheet(); break;
    case "new-tx": txForm(null); break;
    case "save-tx": saveTx(el); break;
    case "edit-tx": editTx(el.dataset.b, id); break;
    case "del-tx": delTx(el.dataset.b, id); break;
    case "prices": pricesForm(); break;
    case "save-prices": savePrices(); break;
    case "import": importForm(); break;
    case "imp-check": importCheck(); break;
    case "imp-go": importGo(el); break;
    case "config": configForm(); break;
    case "tax": taxForm(); break;
    case "tax-year": taxForm(Number(el.value)); break;
    case "tax-download": taxDownload(el); break;
    case "save-broker": saveBrokerCfg(id); break;
    case "new-broker": newBroker(); break;
    case "save-tickers": saveTickers(); break;
    case "save-alerts": saveAlerts(); break;
    case "save-kw": saveKw(); break;
    case "add-access": addAccess(); break;
    case "del-access": delAccess(id); break;
    case "save-rec": saveRec(id); break;
    case "news-refresh": loadNews(id, true); break;
  }
});

// ------------------------------------------------------------------ inicio
function screenMsg(html) { $app().innerHTML = `<div class="center">${html}</div>`; }

async function boot() {
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  if (demo) {
    const { DEMO_SEED } = await import("./demo-data.js");
    S.store = createMemoryStore(DEMO_SEED, demo === "viewer" ? "viewer" : "owner");
  } else if (!firebaseConfig.projectId || firebaseConfig.projectId.startsWith("PEGA_AQUI")) {
    screenMsg(`<h1>Portafolio</h1>
      <p class="muted">Falta configurar Firebase en <span class="mono">js/config.js</span> (ver la guía de despliegue).</p>
      <p><a href="?demo=1">Ver la app con datos de ejemplo</a></p>`);
    return;
  } else {
    try { S.store = await createFirebaseStore(firebaseConfig); }
    catch (e) { screenMsg(`<p class="loss">No se pudo iniciar Firebase: ${esc(e.message)}</p>`); return; }
  }

  S.store.onAuth(async (u) => {
    S.user = u;
    if (!u) {
      screenMsg(`<h1>Portafolio</h1>
        <p class="muted" style="margin:10px 0 24px">Inicia sesión con tu cuenta de Google.</p>
        <button class="btn primary" data-a="login">Iniciar sesión con Google</button>`);
      return;
    }
    screenMsg(`<div class="muted">Cargando portafolio…</div>`);
    try {
      S.access = await S.store.getAccess();
      if (!S.access) {
        screenMsg(`<h1>Acceso no autorizado</h1>
          <p class="muted">La cuenta ${esc(u.email)} no tiene acceso a este portafolio.</p>
          <button class="btn" data-a="logout">Usar otra cuenta</button>`);
        return;
      }
      S.isOwner = S.access.rol === "owner";
      await reload();
      if (proxyReady() && pricesStale()) refreshPrices(false);
    } catch (e) {
      screenMsg(`<p class="loss">Error cargando datos: ${esc(e.message)}</p><button class="btn" data-a="logout">Salir</button>`);
    }
  });
}

boot();

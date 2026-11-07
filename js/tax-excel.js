// =====================================================================
// tax-excel.js — arma el Excel del resumen fiscal en el navegador.
// La librería ExcelJS (vendor/exceljs.min.js) se carga solo al descargar.
// Las cifras en COP son fórmulas sobre la TRM: si la TRM cambia, basta
// con cambiar esa celda.
// =====================================================================

const USD = '#,##0.00_);(#,##0.00);"-"_)';
const COP = '#,##0_);(#,##0);"-"_)';
const PCT = '0%';
const DATE = 'yyyy-mm-dd';
const INK = "FF17242B", LINE = "FFDAE1DC", HEAD = "FFE9EEF0", INPUT = "FFFFF4CC", MUTED = "FF5F6D74";

let loading = null;
function loadExcelJS(base) {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!loading) {
    loading = new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = new URL("../vendor/exceljs.min.js", base).href;
      s.onload = () => ok(window.ExcelJS);
      s.onerror = () => { loading = null; fail(new Error("No se pudo cargar el generador de Excel")); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

const d = (s) => { if (!s) return null; const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
const TIPO_INGRESO = { dividendo: "Dividendo", interes: "Interés", interes_estimado: "Interés estimado" };

function header(ws, rowIdx, labels, widths) {
  const r = ws.getRow(rowIdx);
  labels.forEach((l, i) => {
    const c = r.getCell(i + 1);
    c.value = l;
    c.font = { bold: true, color: { argb: INK } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } };
    c.alignment = { vertical: "middle", wrapText: true };
    c.border = { bottom: { style: "thin", color: { argb: LINE } } };
  });
  r.height = 30;
  if (widths) widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
}
function fmtCols(ws, map, from, to) {
  for (const [col, fmt] of Object.entries(map)) for (let r = from; r <= to; r++) ws.getCell(`${col}${r}`).numFmt = fmt;
}
// strict: columnas que quedan vacías si alguna fila está vacía (p. ej. falta un precio)
function totalRow(ws, r, label, cols, from, to, strict = []) {
  ws.getCell(`A${r}`).value = label;
  ws.getRow(r).font = { bold: true };
  for (const c of cols) {
    const rg = `${c}${from}:${c}${to}`;
    ws.getCell(`${c}${r}`).value = { formula: strict.includes(c) ? `IF(COUNTBLANK(${rg})>0,"",SUM(${rg}))` : `SUM(${rg})` };
  }
  ws.getRow(r).eachCell((c) => (c.border = { top: { style: "thin", color: { argb: INK } } }));
}

/**
 * report: resultado de buildTaxReport
 * opts: { trm, personas: {clave: nombre}, quien: nombre del usuario, base: import.meta.url }
 */
export async function downloadTaxExcel(report, opts) {
  const ExcelJS = await loadExcelJS(opts.base);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Portafolio";
  wb.created = new Date();
  const Y = report.year;
  const corte = report.cierre;
  const quien = opts.quien || "Tú";
  const KNOWN = { andres: "Andrés", ricardo: "Ricardo" };
  const nom = (k) => (opts.personas && opts.personas[k]) || KNOWN[k] || (k ? k[0].toUpperCase() + k.slice(1) : k);

  // ------------------------------------------------------------- Resumen
  const ws = wb.addWorksheet("Resumen", { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 30 }, { width: 17 }, { width: 17 }, { width: 15 }, { width: 17 }, { width: 19 }, { width: 10 }, { width: 70 }];
  ws.getCell("A1").value = `Resumen inversiones ${Y}`;
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: INK } };
  ws.getCell("A2").value = `${report.parcial ? `Corte parcial al ${corte} (el año no ha terminado)` : `Corte al ${corte}`}. Valores en dólares (USD). Generado el ${new Date().toISOString().slice(0, 10)} para ${quien}.`;
  ws.getCell("A2").font = { color: { argb: MUTED } };
  ws.getCell("A4").value = `TRM al ${corte}`;
  ws.getCell("A4").font = { bold: true };
  const trmCell = ws.getCell("B4");
  trmCell.value = opts.trm ? Number(opts.trm) : null;
  trmCell.numFmt = '#,##0.00';
  trmCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
  ws.getCell("C4").value = opts.trm ? "Las cifras en COP se calculan con esta TRM." : "Escribe aquí la TRM y se llenan las cifras en COP.";
  ws.getCell("C4").font = { italic: true, color: { argb: MUTED } };

  let r = 6;
  ws.getCell(`A${r}`).value = "Estados Unidos (USD): acciones y efectivo";
  ws.getCell(`A${r}`).font = { bold: true, size: 13 };
  r += 1;
  header(ws, r, ["Broker", "Valor de mercado", "Costo fiscal de las acciones", "Efectivo", "Total a valor de mercado", "Total en COP", "% tuyo"]);
  const comments = [];
  const b0 = r + 1;
  for (const b of report.brokers) {
    r += 1;
    const notes = [];
    if (b.shares && Object.keys(b.shares).length > 1) notes.push(Object.entries(b.shares).map(([k, v]) => `${Math.round(v * 100)}% de ${nom(k)}`).join(" y ") + " (ver detalle por persona).");
    if (b.faltanPrecios.length) notes.push(`Falta el precio de cierre de ${b.faltanPrecios.join(", ")}: usa el valor del certificado del broker.`);
    if (b.efectivoNota) notes.push(b.efectivoNota + ".");
    if (b.efectivo == null) notes.push("Efectivo sin calcular: usa el certificado.");
    if (b.interesesEst > 0.005) notes.push("Incluye intereses estimados por la app que faltan por confirmar.");
    ws.getRow(r).values = [b.broker, b.valorMercado, b.costoAcciones, b.efectivo, null, null, b.factor];
    if (notes.length) comments.push(`${b.broker}: ${notes.join(" ")}`);
    ws.getCell(`E${r}`).value = { formula: `IF(OR(B${r}="",D${r}=""),"",B${r}+D${r})` };
    ws.getCell(`F${r}`).value = { formula: `IF(OR($B$4="",E${r}=""),"",E${r}*$B$4)` };
  }
  const b1 = r;
  r += 1; totalRow(ws, r, "Total", ["B", "C", "D", "E", "F"], b0, b1, ["B", "D", "E", "F"]);
  const rTot = r;
  r += 1;
  ws.getCell(`A${r}`).value = `Tu parte (${quien})`;
  ws.getRow(r).font = { bold: true, color: { argb: "FF3346B8" } };
  for (const c of ["B", "C", "D", "E", "F"]) {
    const sp = `SUMPRODUCT(${c}${b0}:${c}${b1},$G$${b0}:$G$${b1})`;
    ws.getCell(`${c}${r}`).value = { formula: c === "C" ? sp : `IF(${c}${rTot}="","",${sp})` };
  }
  fmtCols(ws, { B: USD, C: USD, D: USD, E: USD, F: COP, G: PCT }, b0, r);
  for (const c of comments) { r += 1; ws.getCell(`A${r}`).value = c; ws.getCell(`A${r}`).font = { italic: true, color: { argb: MUTED } }; }

  // detalle por persona (brokers compartidos)
  const shared = report.brokers.filter((b) => b.shares && Object.keys(b.shares).length > 1);
  for (const b of shared) {
    r += 2;
    ws.getCell(`A${r}`).value = `Detalle ${b.broker} por persona`;
    ws.getCell(`A${r}`).font = { bold: true, size: 13 };
    r += 1;
    header(ws, r, ["Persona", "Valor de mercado", "Costo fiscal de las acciones", "Efectivo", "Total a valor de mercado", "Total en COP", "%"]);
    const src = b0 + report.brokers.indexOf(b);
    const p0 = r + 1;
    for (const [k, v] of Object.entries(b.shares)) {
      r += 1;
      ws.getCell(`A${r}`).value = nom(k);
      ws.getCell(`G${r}`).value = v;
      for (const c of ["B", "C", "D", "E", "F"]) ws.getCell(`${c}${r}`).value = { formula: `IF(${c}$${src}="","",${c}$${src}*$G${r})` };
    }
    r += 1; totalRow(ws, r, "Total", ["B", "C", "D", "E", "F", "G"], p0, r - 1, ["B", "D", "E", "F"]);
    fmtCols(ws, { B: USD, C: USD, D: USD, E: USD, F: COP, G: PCT }, p0, r);
  }

  // ingresos del año
  r += 2;
  ws.getCell(`A${r}`).value = `Ingresos y movimientos de ${Y}${report.parcial ? ` (hasta ${corte})` : ""}`;
  ws.getCell(`A${r}`).font = { bold: true, size: 13 };
  r += 1;
  const ws2cols = ["Broker", "Dividendos netos", "Impuesto retenido", "Dividendos + intereses brutos", "Intereses", "Ventas: valor recibido", "Ventas: costo fiscal", "Ventas: utilidad", "Comisiones sueltas", "Depósitos", "Retiros", "% tuyo"];
  header(ws, r, ws2cols);
  const i0 = r + 1;
  for (const b of report.brokers) {
    r += 1;
    ws.getRow(r).values = [b.broker, b.dividendos, b.retencion, null, b.intereses + b.interesesEst, b.ventasValor, b.ventasCosto, null, b.comisionesSueltas, b.depositos, b.retiros, b.factor];
    ws.getCell(`D${r}`).value = { formula: `B${r}+C${r}+E${r}` };
    ws.getCell(`H${r}`).value = { formula: `F${r}-G${r}` };
  }
  const i1 = r;
  r += 1; totalRow(ws, r, "Total", ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K"], i0, i1);
  r += 1;
  ws.getCell(`A${r}`).value = `Tu parte (${quien})`;
  ws.getRow(r).font = { bold: true, color: { argb: "FF3346B8" } };
  for (const c of ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]) ws.getCell(`${c}${r}`).value = { formula: `SUMPRODUCT(${c}${i0}:${c}${i1},$L$${i0}:$L$${i1})` };
  fmtCols(ws, { B: USD, C: USD, D: USD, E: USD, F: USD, G: USD, H: USD, I: USD, J: USD, K: USD, L: PCT }, i0, r);
  // los anchos de la tabla de ingresos mandan en la hoja
  [30, 15, 15, 17, 13, 16, 16, 15, 14, 13, 13, 9].forEach((w, i) => (ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width || 0, w)));

  if (report.warnings.length) {
    r += 2;
    ws.getCell(`A${r}`).value = "Revisar";
    ws.getCell(`A${r}`).font = { bold: true, color: { argb: "FF9A6400" } };
    for (const w of report.warnings) { r += 1; ws.getCell(`A${r}`).value = w; }
  }

  // ------------------------------------------------------ Posiciones
  const wp = wb.addWorksheet(`Posiciones ${corte}`.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  header(wp, 1, ["Broker", "Acción", "Nombre", "Acciones", "Primera compra", "Costo promedio", "Costo fiscal", "Precio de cierre", "Valor de mercado", "% tuyo", "Costo fiscal tuyo", "Valor de mercado tuyo"],
    [12, 9, 26, 12, 13, 13, 14, 13, 15, 8, 15, 15]);
  report.positions.forEach((p, i) => {
    const row = i + 2;
    wp.getRow(row).values = [p.broker, p.ticker, p.nombre, p.cantidad, d(p.primeraCompra), p.costoPromedio, p.costo, p.precioCierre, null, p.factor, null, null];
    wp.getCell(`I${row}`).value = { formula: `IF(H${row}="","",D${row}*H${row})` };
    wp.getCell(`K${row}`).value = { formula: `G${row}*J${row}` };
    wp.getCell(`L${row}`).value = { formula: `IF(I${row}="","",I${row}*J${row})` };
    if (p.precioCierre == null) wp.getCell(`H${row}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
  });
  const pn = report.positions.length + 1;
  totalRow(wp, pn + 1, "Total", ["G", "I", "K", "L"], 2, pn, ["I", "L"]);
  fmtCols(wp, { D: "#,##0.0000", E: DATE, F: USD, G: USD, H: USD, I: USD, J: PCT, K: USD, L: USD }, 2, pn + 1);
  if (pn > 1) wp.autoFilter = { from: "A1", to: `L${pn}` };

  // ---------------------------------------------------------- Ventas
  const wv = wb.addWorksheet("Ventas", { views: [{ state: "frozen", ySplit: 1 }] });
  header(wv, 1, ["Broker", "Acción", "Fecha de compra (lote)", "Fecha de venta", "Días de tenencia", "Años", "2 años o más", "Cantidad", "Precio de venta", "Valor recibido", "Costo fiscal (FIFO)", "Utilidad", "% tuyo", "Utilidad tuya", "TRM fecha de venta", "Utilidad tuya en COP"],
    [11, 9, 14, 13, 10, 7, 9, 11, 12, 13, 13, 12, 8, 13, 12, 15]);
  report.sales.forEach((s, i) => {
    const row = i + 2;
    wv.getRow(row).values = [s.broker, s.ticker, d(s.fechaCompra), d(s.fechaVenta), s.dias, null, null, s.cantidad, s.precioVenta, s.valorVenta, s.costo, null, s.factor, null, null, null];
    wv.getCell(`F${row}`).value = { formula: `E${row}/365` };
    wv.getCell(`G${row}`).value = { formula: `IF(E${row}>=730,"Sí","No")` };
    wv.getCell(`L${row}`).value = { formula: `J${row}-K${row}` };
    wv.getCell(`N${row}`).value = { formula: `L${row}*M${row}` };
    wv.getCell(`O${row}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
    wv.getCell(`P${row}`).value = { formula: `IF(O${row}="","",N${row}*O${row})` };
  });
  const sn = report.sales.length + 1;
  if (report.sales.length) {
    totalRow(wv, sn + 1, "Total", ["J", "K", "L", "N", "P"], 2, sn, ["P"]);
    fmtCols(wv, { C: DATE, D: DATE, F: "0.0", H: "#,##0.0000", I: USD, J: USD, K: USD, L: USD, M: PCT, N: USD, O: '#,##0.00', P: COP }, 2, sn + 1);
    wv.autoFilter = { from: "A1", to: `P${sn}` };
  } else wv.getCell("A2").value = `Sin ventas en ${Y}.`;
  const vNote = sn + 3;
  wv.getCell(`A${vNote}`).value = "Cada venta se divide por lote de compra (método FIFO: las primeras acciones compradas son las primeras vendidas). La comisión de compra suma al costo; la de venta resta del valor recibido.";
  wv.getCell(`A${vNote}`).font = { italic: true, color: { argb: MUTED } };

  // --------------------------------------------- Dividendos e intereses
  const wd = wb.addWorksheet("Dividendos e intereses", { views: [{ state: "frozen", ySplit: 1 }] });
  header(wd, 1, ["Fecha", "Broker", "Tipo", "Acción", "Neto recibido", "Impuesto retenido", "Bruto", "% tuyo", "Bruto tuyo", "Retención tuya", "TRM de la fecha", "Bruto tuyo en COP", "Nota"],
    [12, 11, 16, 9, 13, 13, 12, 8, 12, 13, 12, 15, 50]);
  report.income.forEach((x, i) => {
    const row = i + 2;
    wd.getRow(row).values = [d(x.fecha), x.broker, TIPO_INGRESO[x.tipo] || x.tipo, x.ticker || "", x.neto, x.retencion, null, x.factor, null, null, null, null,
      x.retencion == null && x.tipo === "dividendo" ? (x.nota ? x.nota + ". " : "") + "Retención no registrada" : x.nota];
    wd.getCell(`G${row}`).value = { formula: `E${row}+N(F${row})` };
    wd.getCell(`I${row}`).value = { formula: `G${row}*H${row}` };
    wd.getCell(`J${row}`).value = { formula: `N(F${row})*H${row}` };
    wd.getCell(`K${row}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INPUT } };
    wd.getCell(`L${row}`).value = { formula: `IF(K${row}="","",I${row}*K${row})` };
    if (x.tipo === "interes_estimado") wd.getRow(row).font = { italic: true, color: { argb: MUTED } };
  });
  const dn = report.income.length + 1;
  if (report.income.length) {
    totalRow(wd, dn + 1, "Total", ["E", "F", "G", "I", "J", "L"], 2, dn, ["L"]);
    fmtCols(wd, { A: DATE, E: USD, F: USD, G: USD, H: PCT, I: USD, J: USD, K: '#,##0.00', L: COP }, 2, dn + 1);
    wd.autoFilter = { from: "A1", to: `M${dn}` };
  } else wd.getCell("A2").value = `Sin dividendos ni intereses en ${Y}.`;

  // ------------------------------------------------------ Movimientos
  const wm = wb.addWorksheet("Movimientos", { views: [{ state: "frozen", ySplit: 1 }] });
  header(wm, 1, ["Fecha", "Broker", "Tipo", "Acción", "Cantidad", "Precio", "Efecto en el efectivo", "Impuesto retenido", "% tuyo", "Nota"], [12, 11, 24, 9, 12, 12, 15, 13, 8, 50]);
  report.movements.forEach((m, i) => {
    wm.getRow(i + 2).values = [d(m.fecha), m.broker, m.tipo, m.ticker || "", m.cantidad, m.precio, m.monto, m.retencion, m.factor, m.nota];
  });
  fmtCols(wm, { A: DATE, E: "#,##0.0000", F: USD, G: USD, H: USD, I: PCT }, 2, report.movements.length + 1);
  if (report.movements.length) wm.autoFilter = { from: "A1", to: `J${report.movements.length + 1}` };

  // ------------------------------------------------------------ Notas
  const wn = wb.addWorksheet("Notas", { views: [{ showGridLines: false }] });
  wn.getColumn(1).width = 110;
  [
    ["Cómo se calculó este resumen", true],
    ["Costo fiscal: lo pagado por las acciones que siguen abiertas, incluidas las comisiones de compra y los dividendos reinvertidos (cada reinversión es una compra)."],
    ["Ventas: método FIFO. Cada venta aparece dividida por lote de compra, con su fecha y los días de tenencia, para poder separar lo que se tuvo 2 años o más."],
    ["Dividendos e intereses: el neto es lo que llegó a la cuenta. El impuesto retenido solo aparece si se registró en la app; si dice \"Retención no registrada\", tómalo del certificado del broker."],
    ["Valor de mercado: precio de cierre que se escribió al descargar, multiplicado por las acciones al corte. Si falta un precio, la celda queda amarilla para completarla."],
    ["Efectivo: calculado con los movimientos registrados. Compáralo con el certificado del broker."],
    ["Participación: \"% tuyo\" es la parte de cada cuenta que le corresponde a quien descargó el resumen. En las cuentas compartidas, la hoja Resumen trae el detalle por persona."],
    ["COP: las celdas amarillas de TRM se pueden llenar; las cifras en pesos se calculan solas."],
    [""],
    ["Este archivo organiza la información de tus inversiones; no es una asesoría tributaria. La clasificación de cada ingreso y el tratamiento de los impuestos pagados en el exterior los define tu contador(a)."],
  ].forEach(([t, bold], i) => {
    const c = wn.getCell(`A${i + 1}`);
    c.value = t; c.alignment = { wrapText: true, vertical: "top" };
    if (bold) c.font = { bold: true, size: 13 };
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const name = `Resumen_fiscal_${Y}${report.parcial ? "_parcial" : ""}.xlsx`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return name;
}

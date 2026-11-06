// Datos 100% ficticios para el modo demo (?demo=1). No son tus posiciones.
export const DEMO_SEED = {
  brokers: [
    { id: "schwab", nombre: "Schwab", orden: 1, shares: { andres: 0.5, ricardo: 0.5 },
      tickers: { AAA: { nombre: "Alfa Corp.", apiSymbol: "AAA", industryPE: 18 }, IDX: { nombre: "Índice Demo ETF", apiSymbol: "IDX" } },
      saldoReportado: { valor: 6450, fecha: "2026-10-09" },
      preciosManuales: { AAA: { price: 168.4, date: "2026-10-09", ts: 1 }, IDX: { price: 702.5, date: "2026-10-09", ts: 1 } } },
    { id: "hapi", nombre: "Hapi", orden: 2, shares: { andres: 1 },
      tickers: { BBB: { nombre: "Beta Industries", apiSymbol: "BBB", industryPE: 22 }, AAA: { nombre: "Alfa Corp.", apiSymbol: "AAA", industryPE: 18 } },
      preciosManuales: { AAA: { price: 168.4, date: "2026-10-09", ts: 1 }, BBB: { price: 198.1, date: "2026-10-09", ts: 1 } } },
    { id: "tyba", nombre: "Tyba", orden: 3, shares: { andres: 1 },
      interes: { base: "EA", tasas: [{ desde: "2026-01-01", tasa: 0.035 }] }, tickers: { IDX: { nombre: "Índice Demo ETF", apiSymbol: "IDX" } },
      preciosManuales: { IDX: { price: 702.5, date: "2026-10-09", ts: 1 } } },
  ],
  txs: {
    schwab: [
      { id: "s1", fecha: "2023-02-01", tipo: "deposito", monto: 4000 },
      { id: "s2", fecha: "2023-02-02", ticker: "AAA", tipo: "compra", cantidad: 20, precio: 100, monto: -2000 },
      { id: "s3", fecha: "2023-02-02", ticker: "IDX", tipo: "compra", cantidad: 5, precio: 380, monto: -1900 },
      { id: "s4", fecha: "2024-06-30", ticker: "IDX", tipo: "dividendo", monto: 30 },
      { id: "s5", fecha: "2024-06-30", ticker: "IDX", tipo: "compra_reinversion", cantidad: 0.06, precio: 500, monto: -30 },
      { id: "s6", fecha: "2025-06-30", ticker: "IDX", tipo: "dividendo", monto: 32 },
      { id: "s7", fecha: "2025-06-30", ticker: "IDX", tipo: "compra_reinversion", cantidad: 0.055, precio: 580, monto: -32 },
    ],
    hapi: [
      { id: "h1", fecha: "2025-03-10", tipo: "deposito", monto: 3000 },
      { id: "h2", fecha: "2025-03-11", ticker: "BBB", tipo: "compra", cantidad: 10, precio: 210, monto: -2100.99 },
      { id: "h3", fecha: "2025-03-11", ticker: "AAA", tipo: "compra", cantidad: 5, precio: 150, monto: -750.99 },
      { id: "h4", fecha: "2026-02-15", ticker: "BBB", tipo: "dividendo", monto: 12 },
    ],
    tyba: [
      { id: "t1", fecha: "2026-01-05", tipo: "deposito", monto: 5000 },
      { id: "t2", fecha: "2026-02-01", ticker: "IDX", tipo: "compra", cantidad: 3, precio: 640, monto: -1920 },
      { id: "t3", fecha: "2026-03-02", tipo: "interes", periodo: "2026-02", monto: 11.4 },
    ],
  },
  settings: {},
  access: [{ email: "papa@ejemplo.com", rol: "viewer", shareKey: "ricardo", nombre: "Ricardo", brokers: ["schwab"] }],
};

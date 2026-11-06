// =====================================================================
// Configuración pública de la app. Nada de esto es secreto:
//  - firebaseConfig identifica tu proyecto de Firebase; la seguridad de
//    los datos la dan las reglas de Firestore, no esta configuración.
//  - proxyUrl es tu Apps Script de precios: solo entrega precios y
//    noticias públicas del mercado, nunca datos de tu portafolio.
// Reemplaza los valores PEGA_AQUI siguiendo la guía de despliegue.
// =====================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyApufsbRHLbWHv0Xw0ICksBpaTSvc29gVY",
  authDomain: "investment-portfolio-3a054.firebaseapp.com",
  projectId: "investment-portfolio-3a054",
  appId: "1:164531902058:web:23219162f069c71fb95c13",
};

export const proxyUrl = "https://script.google.com/macros/s/AKfycbwVjM0yvdLxjI2KmDQrC4YiusFjQwGG4EV1tA3g-JIaxrJ6lbvFBarr0jM8icImdtBI7A/exec";

# Portafolio

Seguimiento personal de inversiones: TIR (XIRR) y NPV por acción, por broker y del portafolio completo, con conciliación contra el saldo de cada broker.

- Interfaz estática (esta carpeta), publicada con GitHub Pages.
- Datos e inicio de sesión: Firebase (Firestore + Google Sign-In). El acceso lo controlan reglas del servidor, no este código.
- Precios, métricas y noticias: Finnhub, a través de un proxy en Google Apps Script.

Este repositorio no contiene datos de inversiones. `?demo=1` muestra la app con datos ficticios.

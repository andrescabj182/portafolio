// =====================================================================
// data.js — capa de datos. Dos implementaciones con la misma interfaz:
//  - createFirebaseStore: datos reales en Firestore, login con Google.
//    La seguridad la imponen las reglas de Firestore en el servidor,
//    no este código (que es público en GitHub).
//  - createMemoryStore: datos de ejemplo en memoria (?demo=1). Nunca
//    contiene datos reales.
// =====================================================================


export async function createFirebaseStore(config) {
  const fb = await import("../vendor/firebase.js");
  const app = fb.initializeApp(config);
  const auth = fb.getAuth(app);
  await fb.setPersistence(auth, fb.browserLocalPersistence);
  const db = fb.getFirestore(app);
  let user = null;

  const txCol = (b) => fb.collection(db, "brokers", b, "txs");

  return {
    mode: "firebase",

    onAuth(cb) {
      fb.getRedirectResult(auth).catch(() => {});
      return fb.onAuthStateChanged(auth, (u) => {
        user = u;
        cb(u ? { email: (u.email || "").toLowerCase(), nombre: u.displayName || u.email } : null);
      });
    },

    async signIn() {
      const p = new fb.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      try {
        await fb.signInWithPopup(auth, p);
      } catch (e) {
        const redirectCodes = ["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"];
        if (redirectCodes.includes(e.code)) await fb.signInWithRedirect(auth, p);
        else throw e;
      }
    },

    signOut: () => fb.signOut(auth),

    /** Devuelve el registro de acceso del usuario, o null si no tiene acceso. */
    async getAccess() {
      const email = (user.email || "").toLowerCase();
      const ref = fb.doc(db, "access", email);
      let snap;
      try {
        snap = await fb.getDoc(ref);
      } catch (e) {
        if (e.code === "permission-denied") return null;
        throw e;
      }
      if (snap.exists()) return snap.data();
      // Primer ingreso del dueño: las reglas solo le permiten crear este
      // registro a él. Para cualquier otra persona esta escritura falla.
      try {
        const d = { rol: "owner", shareKey: "andres", nombre: (user.displayName || "Dueño").split(" ")[0], brokers: [] };
        await fb.setDoc(ref, d);
        return d;
      } catch {
        return null;
      }
    },

    async loadAll(access) {
      let brokerDocs = [];
      if (access.rol === "owner") {
        const s = await fb.getDocs(fb.collection(db, "brokers"));
        brokerDocs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      } else {
        for (const id of access.brokers || []) {
          const s = await fb.getDoc(fb.doc(db, "brokers", id));
          if (s.exists()) brokerDocs.push({ id: s.id, ...s.data() });
        }
      }
      const txs = {};
      await Promise.all(
        brokerDocs.map(async (b) => {
          const s = await fb.getDocs(txCol(b.id));
          txs[b.id] = s.docs.map((d) => ({ ...d.data(), id: d.id }));
        })
      );
      let settings = {};
      if (access.rol === "owner") {
        const s = await fb.getDoc(fb.doc(db, "settings", "owner"));
        settings = s.exists() ? s.data() : {};
      }
      brokerDocs.sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99));
      return { brokers: brokerDocs, txs, settings };
    },

    async addTx(brokerId, tx) {
      const ref = fb.doc(txCol(brokerId));
      const clean = stripUndefined({ ...tx, id: undefined });
      await fb.setDoc(ref, clean);
      return ref.id;
    },
    updateTx: (brokerId, id, tx) => fb.setDoc(fb.doc(db, "brokers", brokerId, "txs", id), stripUndefined({ ...tx, id: undefined })),
    deleteTx: (brokerId, id) => fb.deleteDoc(fb.doc(db, "brokers", brokerId, "txs", id)),
    saveBroker: (id, data) => fb.setDoc(fb.doc(db, "brokers", id), stripUndefined(data), { merge: true }),
    saveSettings: (data) => fb.setDoc(fb.doc(db, "settings", "owner"), stripUndefined(data), { merge: true }),

    /** rowsByBroker: {brokerId: [tx]}; replace: borra antes los movimientos de esos brokers */
    async importTxs(rowsByBroker, replace) {
      const ops = [];
      for (const [b, rows] of Object.entries(rowsByBroker)) {
        if (replace) {
          const s = await fb.getDocs(txCol(b));
          s.docs.forEach((d) => ops.push({ del: d.ref }));
        }
        rows.forEach((tx) => ops.push({ set: fb.doc(txCol(b)), data: stripUndefined({ ...tx, id: undefined }) }));
      }
      for (let i = 0; i < ops.length; i += 400) {
        const batch = fb.writeBatch(db);
        ops.slice(i, i + 400).forEach((o) => (o.del ? batch.delete(o.del) : batch.set(o.set, o.data)));
        await batch.commit();
      }
    },

    async listAccess() {
      const s = await fb.getDocs(fb.collection(db, "access"));
      return s.docs.map((d) => ({ email: d.id, ...d.data() }));
    },
    setAccess: (email, data) => fb.setDoc(fb.doc(db, "access", email.toLowerCase().trim()), stripUndefined(data)),
    removeAccess: (email) => fb.deleteDoc(fb.doc(db, "access", email)),
  };
}

function stripUndefined(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// --------------------------------------------------------------------
// Modo demo: datos ficticios, en memoria. Útil para ver la app sin
// configurar Firebase. ?demo=1 entra como dueño; ?demo=viewer como lector.
// --------------------------------------------------------------------
export function createMemoryStore(seed, role = "owner") {
  const data = JSON.parse(JSON.stringify(seed));
  let n = 1000;
  const access = role === "owner"
    ? { rol: "owner", shareKey: "andres", nombre: "Andrés", brokers: [] }
    : { rol: "viewer", shareKey: "ricardo", nombre: "Ricardo", brokers: ["schwab"] };
  return {
    mode: "demo",
    onAuth(cb) { setTimeout(() => cb({ email: "demo@ejemplo.com", nombre: access.nombre }), 0); return () => {}; },
    signIn: async () => {},
    signOut: async () => location.assign(location.pathname),
    getAccess: async () => access,
    async loadAll(acc) {
      const brokers = data.brokers.filter((b) => acc.rol === "owner" || acc.brokers.includes(b.id));
      const txs = {};
      brokers.forEach((b) => (txs[b.id] = (data.txs[b.id] || []).map((t) => ({ ...t }))));
      return { brokers: JSON.parse(JSON.stringify(brokers)), txs, settings: acc.rol === "owner" ? { ...data.settings } : {} };
    },
    async addTx(b, tx) { const id = "d" + n++; (data.txs[b] ||= []).push({ ...tx, id }); return id; },
    async updateTx(b, id, tx) { const i = data.txs[b].findIndex((t) => t.id === id); data.txs[b][i] = { ...tx, id }; },
    async deleteTx(b, id) { data.txs[b] = data.txs[b].filter((t) => t.id !== id); },
    async saveBroker(id, d) {
      const i = data.brokers.findIndex((b) => b.id === id);
      if (i < 0) data.brokers.push({ id, ...d }); else data.brokers[i] = { ...data.brokers[i], ...d };
    },
    async saveSettings(d) { data.settings = { ...data.settings, ...d }; },
    async importTxs(rows, replace) {
      for (const [b, list] of Object.entries(rows)) {
        if (replace) data.txs[b] = [];
        list.forEach((tx) => (data.txs[b] ||= []).push({ ...tx, id: "d" + n++ }));
      }
    },
    async listAccess() { return data.access || []; },
    async setAccess(email, d) { data.access = (data.access || []).filter((a) => a.email !== email).concat({ email, ...d }); },
    async removeAccess(email) { data.access = (data.access || []).filter((a) => a.email !== email); },
  };
}


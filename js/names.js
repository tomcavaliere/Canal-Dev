// Annuaire des noms affichés (names/{uid}), tenu par l'administrateur.
// C'est la seule source fiable du nom d'un auteur : les règles réservent l'écriture à l'admin,
// alors que `authorName` (messages) est saisi librement par l'auteur lui-même.
import {
  collection, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ADMIN_UID } from "./firebase.js?v=8";

const names = new Map(); // uid -> nom, ou null si absent de l'annuaire (pas d'entrée = pas encore chargé)
const subs = new Map(); // non-admin : uid -> unsubscribe (une écoute par personne affichée)
let unsubAll = null; // admin : écoute de tout l'annuaire
let loadedAll = false; // admin : annuaire complet chargé
let notify = () => {};

export function startNames({ isAdmin, onChange }) {
  stopNames();
  notify = onChange;
  if (!isAdmin) return;
  unsubAll = onSnapshot(collection(db, "names"), (snap) => {
    names.clear();
    for (const d of snap.docs) names.set(d.id, d.data().name);
    loadedAll = true;
    notify();
  }, (err) => console.error("Lecture de l'annuaire impossible", err));
}

export function stopNames() {
  unsubAll?.();
  unsubAll = null;
  loadedAll = false;
  subs.forEach((unsub) => unsub());
  subs.clear();
  names.clear();
  notify = () => {};
}

// Non-admin : n'écoute que les noms des personnes à afficher (lecture par UID uniquement).
export function watchNames(uids) {
  if (unsubAll) return; // l'admin écoute déjà tout l'annuaire
  for (const [uid, unsub] of subs) {
    if (uids.has(uid)) continue;
    unsub();
    subs.delete(uid);
    names.delete(uid);
  }
  for (const uid of uids) {
    if (typeof uid !== "string" || !uid || uid.includes("/") || subs.has(uid)) continue;
    subs.set(uid, onSnapshot(doc(db, "names", uid), (snap) => {
      names.set(uid, snap.exists() ? snap.data().name : null);
      notify();
    }, (err) => {
      console.error("Lecture d'un nom impossible", err);
      names.set(uid, null);
      notify();
    }));
  }
}

// Nom de l'annuaire, null s'il n'y figure pas, undefined tant qu'il n'est pas chargé.
export function nameOf(uid) {
  if (names.has(uid)) return names.get(uid);
  return loadedAll ? null : undefined;
}

export function namesLoaded() {
  return loadedAll;
}

// Un autre UID porte-t-il déjà ce nom (sans tenir compte de la casse) ?
export function isNameTaken(name, uid) {
  const key = name.trim().toLocaleLowerCase("fr");
  for (const [other, n] of names) {
    if (other !== uid && typeof n === "string" && n.trim().toLocaleLowerCase("fr") === key) return true;
  }
  return false;
}

// Nom à afficher pour un auteur. `claimed` est le nom qu'il a lui-même enregistré (non fiable) :
// utilisé tant que l'annuaire n'est pas chargé, puis marqué « non vérifié » s'il n'y figure pas.
// L'admin est reconnu à son UID (badge « Admin ») : son nom n'a pas besoin de cette marque.
export function displayName(uid, claimed) {
  const n = nameOf(uid);
  if (typeof n === "string") return { name: n, unverified: false };
  return { name: claimed || "?", unverified: n === null && uid !== ADMIN_UID };
}

// Variante texte (notifications, citations, « Vu par … », textes alternatifs).
export function displayText(uid, claimed) {
  const { name, unverified } = displayName(uid, claimed);
  return unverified ? `${name} (non vérifié)` : name;
}

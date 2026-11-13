// Présence « en ligne » (Firebase Realtime Database, région UE).
//
// Chaque onglet ouvert et visible écrit status/{uid}/{connexion} = true. Le serveur efface cette
// entrée tout seul quand la connexion se coupe (onDisconnect : onglet fermé, réseau perdu, appareil
// en veille) ; l'onglet l'efface lui-même quand il passe en arrière-plan. Une personne est « en ligne »
// tant qu'elle a au moins une entrée. Aucune date ni historique n'est conservé (minimisation RGPD).
//
// Lecture : une entrée par UID (comme l'annuaire des noms), jamais la liste complète (database.rules.json).
// Réglage « Masquer ma présence » (profil, noPresence) : plus rien n'est écrit.
import {
  onDisconnect, onValue, ref, remove, set,
} from "./sdk/firebase-database.js";
import { rtdb } from "./firebase.js";

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const connId = crypto.randomUUID(); // identifiant de cet onglet

let myRef = null; // status/{uid}/{connId}
let hidden = false; // réglage noPresence
let connected = false;
let published = false; // entrée de cet onglet écrite sur le serveur
let unsubConnected = null;
const watched = new Map(); // uid -> unsubscribe
const online = new Set();
let notify = () => {};
// Réglage « Masquer ma présence » transmis aux autres onglets de ce navigateur.
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("canal-dev.presence") : null;
channel?.addEventListener("message", (e) => {
  if (myRef && typeof e.data?.hide === "boolean") {
    hidden = e.data.hide;
    publish();
  }
});

/**
 * @param {string} uid
 * @param {{ hide: boolean, onChange: () => void }} options
 */
export function startPresence(uid, { hide, onChange }) {
  stopPresence();
  if (!UID_RE.test(uid)) return;
  notify = onChange;
  hidden = hide;
  myRef = ref(rtdb, `status/${uid}/${connId}`);
  unsubConnected = onValue(ref(rtdb, ".info/connected"), (snap) => {
    connected = snap.val() === true;
    // Après une coupure, le serveur a déjà effacé l'entrée : il faut la réécrire.
    published = false;
    publish();
  });
  document.addEventListener("visibilitychange", publish);
}

// Retire sa présence et coupe toutes les écoutes. À attendre AVANT la déconnexion
// (une fois déconnecté, les règles refusent l'effacement ; onDisconnect le ferait plus tard).
export async function stopPresence() {
  unsubConnected?.();
  unsubConnected = null;
  document.removeEventListener("visibilitychange", publish);
  watched.forEach((unsub) => unsub());
  watched.clear();
  online.clear();
  notify = () => {};
  const target = myRef;
  const wasPublished = published;
  myRef = null;
  published = false;
  connected = false;
  if (target && wasPublished) {
    try {
      await onDisconnect(target).cancel();
      await remove(target);
    } catch (err) {
      console.warn("Retrait de la présence impossible", err);
    }
  }
}

// Réglage « Masquer ma présence ».
/** @param {boolean} hide */
export function setPresenceHidden(hide) {
  hidden = hide;
  channel?.postMessage({ hide });
  return publish();
}

async function publish() {
  const target = myRef;
  if (!target || !connected) return;
  const want = !hidden && !document.hidden;
  if (want === published) return;
  published = want;
  try {
    if (want) {
      // onDisconnect d'abord : l'entrée ne peut pas survivre à une coupure.
      await onDisconnect(target).remove();
      await set(target, true);
    } else {
      await onDisconnect(target).cancel();
      await remove(target);
    }
  } catch (err) {
    console.error("Mise à jour de la présence impossible", err);
    if (target === myRef) published = !want; // réessayé au prochain changement
  }
}

// Personnes dont on suit la présence (membres de ses conversations).
/** @param {Set<string>} uids */
export function watchPresence(uids) {
  if (!myRef) return;
  for (const [uid, unsub] of watched) {
    if (uids.has(uid)) continue;
    unsub();
    watched.delete(uid);
    if (online.delete(uid)) notify();
  }
  for (const uid of uids) {
    if (typeof uid !== "string" || !UID_RE.test(uid) || watched.has(uid)) continue;
    watched.set(uid, onValue(ref(rtdb, `status/${uid}`), (snap) => {
      const was = online.has(uid);
      if (snap.exists()) online.add(uid);
      else online.delete(uid);
      if (was !== online.has(uid)) notify();
    }, (err) => console.error("Lecture de la présence impossible", err)));
  }
}

/** @param {string} uid */
export function isOnline(uid) {
  return online.has(uid);
}

// Droit à l'effacement : retire toutes les entrées de présence d'une personne (elle-même ou l'admin).
/** @param {string} uid */
export async function purgePresence(uid) {
  if (!rtdb || !UID_RE.test(uid)) return;
  await remove(ref(rtdb, `status/${uid}`));
}

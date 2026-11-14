// Notifications push (application fermée) : abonnement Web Push de cet appareil, enregistré dans
// users/{uid}/push/{empreinte de l'adresse}. La Cloud Function (functions/index.js) y envoie
// chaque nouveau message ; le service worker (sw.js) l'affiche.

import { deleteDoc, doc, serverTimestamp, setDoc } from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { VAPID_PUBLIC_KEY } from "./firebase-config.js";

export const pushSupported = Boolean(VAPID_PUBLIC_KEY)
  && "serviceWorker" in navigator && "PushManager" in window;

/** @param {string} b64 base64url */
function bytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const serverKey = bytes(VAPID_PUBLIC_KEY || "");

/** @param {ArrayBuffer | null} key */
function sameKey(key) {
  if (!key) return false;
  const k = new Uint8Array(key);
  return k.length === serverKey.length && k.every((b, i) => b === serverKey[i]);
}

/** @param {string} endpoint */
async function subId(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Abonne cet appareil (ou reprend son abonnement) et l'enregistre pour `uid`.
 * @param {ServiceWorkerRegistration} reg
 * @param {string} uid
 */
export async function subscribePush(reg, uid) {
  let sub = await reg.pushManager.getSubscription();
  // Abonnement créé avec une autre clé (clé changée) : on le refait.
  if (sub && !sameKey(sub.options.applicationServerKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  const { endpoint, keys } = sub.toJSON();
  await setDoc(doc(db, "users", uid, "push", await subId(endpoint)), {
    endpoint, p256dh: keys.p256dh, auth: keys.auth, updatedAt: serverTimestamp(),
  });
}

/**
 * Désabonne cet appareil et retire son abonnement de `uid` (désactivation, déconnexion).
 * @param {ServiceWorkerRegistration} reg
 * @param {string} uid
 */
export async function unsubscribePush(reg, uid) {
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await deleteDoc(doc(db, "users", uid, "push", await subId(sub.endpoint)));
  await sub.unsubscribe();
}

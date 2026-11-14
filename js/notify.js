// Notifications système (bannière du système d'exploitation) pour les nouveaux messages.
// Désactivées par défaut ; le navigateur demande l'autorisation au premier clic sur le bouton.
// Deux sources :
//  - l'application ouverte (onglet ou application installée) les affiche elle-même ;
//  - si le navigateur le permet, l'appareil s'abonne aussi aux notifications push (push.js) :
//    la Cloud Function les envoie même application fermée, et le service worker les affiche.

import { pushSupported, subscribePush, unsubscribePush } from "./push.js";

const KEY = "canal-dev.notifications";
/** @type {Promise<ServiceWorkerRegistration | null>} service worker (voir registerServiceWorker) */
let registration = Promise.resolve(null);
const supported = "Notification" in window;
let wanted = (() => {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
})();

function save() {
  try { localStorage.setItem(KEY, wanted ? "on" : "off"); } catch { /* ignoré */ }
}

function enabled() {
  return supported && wanted && Notification.permission === "granted";
}

// "unsupported" | "denied" | "on" | "off"
export function notificationState() {
  if (!supported) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return enabled() ? "on" : "off";
}

// À appeler depuis un clic (le navigateur exige une action de l'utilisateur pour demander l'autorisation).
export async function toggleNotifications() {
  if (!supported) return;
  if (enabled()) {
    wanted = false;
    save();
    await stopPush();
  } else {
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    wanted = perm === "granted";
    save();
    await syncPush();
  }
}

/* ---------- Notifications push (application fermée) ---------- */

let pushUid = null; // compte connecté
let pushOn = false; // cet appareil est abonné pour ce compte

// Notifications push actives sur cet appareil : le service worker affiche alors les nouveaux
// messages quand l'application n'est pas au premier plan.
export function pushActive() {
  return pushOn && enabled();
}

// (Ré)abonne cet appareil si les notifications sont activées : à la connexion (l'abonnement peut
// avoir été renouvelé par le navigateur) et à l'activation. Sans push : notifications locales seules.
async function syncPush() {
  if (!pushSupported || !pushUid || !enabled()) return;
  const uid = pushUid;
  try {
    if (!(await registration)) return;
    // S'abonner exige un service worker actif (à la toute première visite, il s'installe encore).
    await subscribePush(await navigator.serviceWorker.ready, uid);
    pushOn = uid === pushUid;
  } catch (err) {
    console.warn("Notifications push indisponibles", err);
    pushOn = false;
  }
}

// Retire l'abonnement de cet appareil (désactivation, déconnexion) : sans quoi le compte suivant
// connecté sur ce navigateur recevrait les messages du précédent.
async function stopPush() {
  const uid = pushUid;
  pushOn = false;
  if (!pushSupported || !uid) return;
  try {
    const reg = await registration;
    if (reg) await unsubscribePush(reg, uid);
  } catch (err) {
    console.warn("Désabonnement des notifications push impossible", err);
  }
}

/** @param {string} uid compte connecté */
export function startPush(uid) {
  pushUid = uid;
  pushOn = false;
  return syncPush();
}

// À appeler avant la déconnexion (ensuite, les règles refuseraient l'effacement).
export async function endPush() {
  await stopPush();
  pushUid = null;
}

// Service worker (sw.js) : installation de l'application et notifications sur Android.
// Pas sur l'ancienne adresse GitHub Pages, qui redirige aussitôt.
/** @param {(convId: string) => void} onOpenConversation */
export function registerServiceWorker(onOpenConversation) {
  if (!("serviceWorker" in navigator) || location.hostname.endsWith("github.io")) return;
  registration = navigator.serviceWorker.register("sw.js").catch((err) => {
    console.warn("Service worker indisponible", err);
    return null;
  });
  // Clic sur une notification alors que l'application est déjà ouverte.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "open-conversation" && typeof event.data.id === "string") {
      onOpenConversation(event.data.id);
    }
  });
}

// `tag` : une seule notification par conversation (la nouvelle remplace l'ancienne).
// Le clic est géré par le service worker s'il est actif (ouvre la conversation `conv`), sinon ici.
/**
 * @param {object} n
 * @param {string} n.title
 * @param {string} n.body
 * @param {string} n.tag
 * @param {string} [n.conv] conversation à ouvrir au clic
 * @param {() => void} [n.onClick] clic, quand le service worker n'est pas actif
 */
export async function showNotification({ title, body, tag, conv, onClick }) {
  if (!enabled()) return;
  const options = { body, tag, lang: "fr", icon: "icons/icon-192.png", data: { conv } };
  try {
    const reg = await registration;
    if (reg?.active) {
      await reg.showNotification(title, options);
      return;
    }
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch (err) {
    console.warn("Notification impossible", err);
  }
}

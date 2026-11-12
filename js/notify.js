// Notifications système (bannière du système d'exploitation) pour les nouveaux messages,
// tant que l'onglet est ouvert. Rien n'est envoyé à un serveur : tout reste dans le navigateur.
// Désactivées par défaut ; le navigateur demande l'autorisation au premier clic sur le bouton.

const KEY = "canal-dev.notifications";
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
  } else {
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    wanted = perm === "granted";
  }
  save();
}

// Service worker (sw.js) : installation de l'application et notifications sur Android.
// Pas sur l'ancienne adresse GitHub Pages, qui redirige aussitôt.
let registration = Promise.resolve(null);
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

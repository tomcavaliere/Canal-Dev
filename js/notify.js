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

// `tag` : une seule notification par conversation (la nouvelle remplace l'ancienne).
export function showNotification({ title, body, tag, onClick }) {
  if (!enabled()) return;
  try {
    const n = new Notification(title, { body, tag, lang: "fr" });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch (err) {
    // Chrome Android n'accepte que les notifications passant par un service worker.
    console.warn("Notification impossible", err);
  }
}

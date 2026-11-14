// Service worker minimal : il rend l'application installable et affiche les notifications
// (Chrome sur Android n'accepte que celles qui passent par un service worker), y compris les
// notifications push envoyées par la Cloud Function quand l'application est fermée.
// Rien n'est mis en cache et aucune requête n'est interceptée : tout passe par le réseau.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Safari (iOS, macOS) retire l'abonnement d'un site qui reçoit des push sans rien afficher.
const mustShow = /AppleWebKit/.test(self.navigator.userAgent) && !/Chrome|Chromium|Android/.test(self.navigator.userAgent);

// Nouveau message (notification push) : { title, body, conv }. Si l'application est au premier
// plan, elle prévient déjà elle-même (son, compteur, notification) : rien de plus, sauf sur Safari.
self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data?.json() ?? {}; } catch { /* contenu illisible : notification générique */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!mustShow && windows.some((w) => w.focused)) return;
    const conv = typeof msg.conv === "string" ? msg.conv : undefined;
    await self.registration.showNotification(typeof msg.title === "string" ? msg.title : "Canal Dev", {
      body: typeof msg.body === "string" ? msg.body : "Nouveau message",
      tag: conv || "canal-dev",
      lang: "fr",
      icon: "icons/icon-192.png",
      data: { conv },
    });
  })());
});

// Clic sur une notification : ouvre (ou ramène au premier plan) l'application sur la conversation.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conv = event.notification.data?.conv;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (conv) win.postMessage({ type: "open-conversation", id: conv });
      return;
    }
    // L'identifiant de conversation (aléatoire) passe dans le fragment : il n'est pas envoyé au serveur.
    await self.clients.openWindow(conv ? `./#c=${encodeURIComponent(conv)}` : "./");
  })());
});

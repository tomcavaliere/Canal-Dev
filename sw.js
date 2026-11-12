// Service worker minimal : il rend l'application installable et affiche les notifications
// (Chrome sur Android n'accepte que celles qui passent par un service worker).
// Rien n'est mis en cache et aucune requête n'est interceptée : tout passe par le réseau.
// Pas de notification « push » : elles ne s'affichent que tant que l'application est ouverte.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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

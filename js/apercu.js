// Aperçu d'une page HTML déposée (apercu.html, dans un cadre sandbox sans allow-same-origin).
// Script classique (pas un module) : un module serait bloqué, l'origine du cadre étant opaque.
// Annonce qu'il est prêt, reçoit UNE fois le contenu de la fenêtre parente (js/files.js), puis
// remplace le document par la page déposée.
(function () {
  "use strict";
  if (window.parent === window) return; // ouvert hors du cadre : rien à afficher
  let done = false;
  window.addEventListener("message", (e) => {
    if (done || e.source !== window.parent || !e.data || typeof e.data.html !== "string") return;
    done = true;
    document.open();
    document.write(e.data.html);
    document.close();
  });
  window.parent.postMessage("apercu-pret", "*");
})();

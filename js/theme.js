// Thème clair / sombre choisi par l'utilisateur (« Mon compte »), gardé dans ce navigateur.
// Script classique chargé dans <head>, avant la feuille de style : le thème est posé
// avant le premier affichage, sans flash. Sans choix (« auto »), le CSS suit le système.
(() => {
  const KEY = "canal-dev.theme";
  const apply = (value) => {
    if (value === "light" || value === "dark") document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  };
  try { apply(localStorage.getItem(KEY)); } catch { /* stockage indisponible */ }
  // Changement fait dans un autre onglet : on suit.
  window.addEventListener("storage", (e) => { if (e.key === KEY || e.key === null) apply(e.newValue); });
})();

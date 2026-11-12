// Petits utilitaires d'affichage partagés par app.js, admin.js et account.js.

// Initiales à partir d'un nom (ou d'une adresse email).
export function initials(name) {
  const base = String(name || "?").split("@")[0].trim();
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]);
  return (letters.join("") || "?").toUpperCase();
}

// Avatar sans photo (minimisation RGPD : aucune image chargée depuis Google).
export function avatarEl(name) {
  const el = document.createElement("span");
  el.className = "avatar";
  el.setAttribute("aria-hidden", "true");
  el.textContent = initials(name);
  return el;
}

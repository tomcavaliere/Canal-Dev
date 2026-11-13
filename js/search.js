// Recherche dans les messages chargés (filtre local, rien n'est envoyé au serveur).

import { displayText } from "./names.js";
import { $ } from "./ui.js";
import { state } from "./state.js";

/* ---------- Recherche dans les messages chargés ---------- */

// Filtre l'affichage (rien n'est envoyé au serveur) : texte et nom de l'auteur, sans tenir
// compte des majuscules ni des accents. « Charger les messages précédents » élargit la recherche.
function normalize(text) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("fr");
}

export function applySearch() {
  const list = $("messages");
  const terms = normalize($("search-bar").hidden ? "" : $("search-input").value).split(/\s+/).filter(Boolean);
  let shown = 0;
  let total = 0;
  let sep = null; // séparateur du jour en cours : caché si aucun message de ce jour ne correspond
  let sepUsed = false;
  const closeDay = () => { if (sep) sep.hidden = !sepUsed; };
  for (const el of list.children) {
    if (el.classList.contains("day-sep")) {
      closeDay();
      sep = el;
      sepUsed = false;
      continue;
    }
    // Annonces (« X a rejoint / a quitté la conversation ») : masquées pendant une recherche.
    if (el.classList.contains("msg-event")) { el.hidden = terms.length > 0; continue; }
    if (!el.classList.contains("msg")) continue;
    const m = state.msgById.get(el.id.slice(4));
    const hay = normalize(`${m?.text || ""} ${m ? displayText(m.authorUid, m.authorName) : ""}`);
    const match = terms.every((t) => hay.includes(t));
    el.hidden = !match;
    total++;
    if (match) { shown++; sepUsed = true; }
  }
  closeDay();
  list.classList.toggle("searching", terms.length > 0);
  $("search-count").textContent = terms.length
    ? `${shown} sur ${total} message${total > 1 ? "s" : ""} chargé${total > 1 ? "s" : ""}`
    : "";
}

function openSearch() {
  $("search-bar").hidden = false;
  $("btn-search").setAttribute("aria-expanded", "true");
  $("search-input").focus();
  $("search-input").select();
}

export function closeSearch() {
  if ($("search-bar").hidden) return;
  $("search-bar").hidden = true;
  $("btn-search").setAttribute("aria-expanded", "false");
  $("search-input").value = "";
  applySearch();
}

$("btn-search").addEventListener("click", () => ($("search-bar").hidden ? openSearch() : closeSearch()));
$("btn-search-close").addEventListener("click", () => {
  closeSearch();
  $("btn-search").focus();
});
$("search-input").addEventListener("input", applySearch);
$("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
    $("btn-search").focus();
  }
});

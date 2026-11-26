// Suggestions de mention dans la zone de saisie : « @m » propose les membres de la conversation
// dont le nom commence par « m » (prénom ou nom de famille), et le choix complète « @Marc Du Bois ».
// Seule une mention en tête de message cible la notification (js/mentions.js) ; ailleurs, le nom
// est simplement écrit en entier.

import { nameOf } from "./names.js";
import { state } from "./state.js";

const MAX = 6; // suggestions affichées au plus
const MAX_QUERY = 40; // au-delà, ce n'est plus un nom en cours de saisie

// Comparaison sans tenir compte de la casse ni des accents (comme js/mentions.js).
/** @param {string} s */
const fold = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");

/** @type {HTMLTextAreaElement} */
let input;
/** @type {HTMLUListElement} */
let list;
let items = []; // noms proposés
let active = 0; // suggestion surlignée
let start = -1; // position du « @ » dans le texte (-1 : menu fermé)

/** @param {HTMLTextAreaElement} textarea */
export function initMentionPicker(textarea) {
  input = textarea;
  list = document.createElement("ul");
  list.id = "mention-list";
  list.className = "mention-menu";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Membres à mentionner");
  list.hidden = true;
  document.body.append(list);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");

  input.addEventListener("input", update);
  input.addEventListener("click", update); // curseur déplacé dans le texte
  input.addEventListener("blur", close);
  window.addEventListener("resize", close);
  // Le clic ne doit pas retirer le focus de la zone de saisie (sinon blur ferme le menu).
  list.addEventListener("pointerdown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = /** @type {HTMLElement} */ (e.target).closest("li");
    if (li) pick(Number(li.dataset.i));
  });
}

// Touche pressée dans la zone de saisie : true si le menu l'a prise en charge.
/** @param {KeyboardEvent} e */
export function handleMentionKey(e) {
  if (start < 0 || e.isComposing) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    render();
  } else if (e.key === "Enter" || e.key === "Tab") {
    pick(active);
  } else if (e.key === "Escape") {
    close();
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

export function closeMentionPicker() {
  close();
}

// Noms des autres membres de la conversation ouverte (annuaire uniquement).
function candidates() {
  const c = state.conversations.get(state.selectedId);
  const names = new Set();
  for (const uid of c?.members || []) {
    if (uid === state.user?.uid) continue;
    const n = nameOf(uid);
    if (typeof n === "string" && n.trim()) names.add(n.trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b, "fr"));
}

// « @… » juste avant le curseur, en début de texte ou après une espace : position du « @ »
// et texte tapé depuis (qui peut contenir des espaces : « @marc du »).
function query() {
  if (input.selectionStart !== input.selectionEnd) return null;
  const before = input.value.slice(0, input.selectionStart);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const q = before.slice(at + 1);
  if (q.length > MAX_QUERY || /[\n@]/.test(q) || q.startsWith(" ")) return null;
  return { at, q: fold(q) };
}

function update() {
  const found = query();
  if (!found) return close();
  // Le nom entier ou l'un de ses mots commence par ce qui est tapé.
  const matches = candidates().filter((name) => {
    const f = fold(name);
    return f.startsWith(found.q) || f.split(/\s+/).some((w) => w.startsWith(found.q));
  }).slice(0, MAX);
  // Rien à proposer, ou le nom est déjà écrit en entier.
  if (!matches.length || (matches.length === 1 && fold(matches[0]) === found.q)) return close();
  const sameList = start === found.at && matches.join("\n") === items.join("\n");
  start = found.at;
  items = matches;
  if (!sameList) active = 0;
  render();
}

function render() {
  list.replaceChildren(...items.map((name, i) => {
    const li = document.createElement("li");
    li.id = "mention-opt-" + i;
    li.className = "mention-opt";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === active));
    li.dataset.i = String(i);
    li.textContent = "@" + name;
    return li;
  }));
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", "mention-opt-" + active);
  // Au-dessus de la zone de saisie, aligné sur sa gauche.
  const r = input.getBoundingClientRect();
  list.style.left = Math.max(8, r.left) + "px";
  list.style.bottom = (window.innerHeight - r.top + 6) + "px";
  list.style.width = Math.min(r.width, 320) + "px";
}

function close() {
  if (start < 0) return;
  start = -1;
  items = [];
  list.hidden = true;
  list.replaceChildren();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

/** @param {number} i */
function pick(i) {
  const name = items[i];
  if (!name || start < 0) return;
  const end = input.selectionStart;
  const after = input.value.slice(end);
  const text = "@" + name + (after.startsWith(" ") ? "" : " ");
  const from = start;
  close();
  if (input.value.length - (end - from) + text.length > input.maxLength) return;
  input.setRangeText(text, from, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

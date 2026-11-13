// Messages épinglés : l'admin met des messages importants en avant. Ils sont listés dans une
// barre en haut de la conversation et marqués « Épinglé » dans le fil.
// Stockés dans le champ `pinned` de la conversation (identifiants seulement : le contenu est
// toujours lu dans le message lui-même, donc un message modifié ou supprimé l'est aussi ici).
import { arrayRemove, arrayUnion, doc, getDoc, updateDoc } from "./sdk/firebase-firestore.js";
import { toast } from "./dialogs.js";
import { db } from "./firebase.js";
import { displayText } from "./names.js";
import { excerpt, renderMessages, revealMessage } from "./messages.js";
import { state } from "./state.js";
import { $ } from "./ui.js";

export const MAX_PINNED = 10; // même limite que firestore.rules

// Messages épinglés hors de la fenêtre chargée, lus une fois : id -> data, ou null (supprimé).
let fetched = new Map();
let fetchedConv = null;
let lastKey = ""; // épingles affichées dans le fil

/**
 * Identifiants épinglés de la conversation ouverte, le plus récemment épinglé en premier.
 * @returns {string[]}
 */
function pinnedIds() {
  const list = state.conversations.get(state.selectedId)?.pinned;
  if (!Array.isArray(list)) return [];
  return list.filter((id) => typeof id === "string" && /^[A-Za-z0-9]{1,128}$/.test(id)).reverse();
}

export function isPinned(id) {
  return pinnedIds().includes(id);
}

// Date du plus ancien message chargé : un message plus récent absent de la fenêtre a été supprimé.
function windowStart() {
  if (!state.hasMore) return -Infinity;
  const first = state.msgDocs?.[0];
  return first ? state.msgById.get(first.id)?.createdAt?.toMillis?.() ?? Infinity : Infinity;
}

/**
 * Contenu d'un message épinglé : chargé (à jour), lu à part, ou undefined pendant la lecture.
 * @param {string} id
 */
function pinnedMessage(id) {
  const live = state.msgById.get(id);
  if (live) return live;
  if (!state.msgDocs) return undefined; // fenêtre pas encore reçue
  if (fetched.has(id)) {
    const known = fetched.get(id);
    if (!known) return known; // null : supprimé ; undefined : lecture en cours
    return (known.createdAt?.toMillis?.() ?? 0) >= windowStart() ? null : known;
  }
  fetched.set(id, undefined);
  const convId = state.selectedId;
  getDoc(doc(db, "conversations", convId, "messages", id))
    .then((snap) => {
      if (fetchedConv !== convId) return;
      fetched.set(id, snap.exists() ? snap.data() : null);
      renderPinned();
    })
    .catch((err) => {
      console.error(err);
      if (fetchedConv === convId) fetched.delete(id);
    });
  return undefined;
}

export function renderPinned() {
  const bar = $("chat-pinned");
  if (fetchedConv !== state.selectedId) {
    fetched = new Map();
    fetchedConv = state.selectedId;
    lastKey = "";
    bar.classList.remove("expanded");
    $("btn-pinned-toggle").setAttribute("aria-expanded", "false");
  }
  // Épingles changées : le fil est redessiné pour la mention « Épinglé » (rendu incrémental,
  // seuls les messages concernés sont reconstruits ; renderMessages rappelle renderPinned).
  const key = pinnedIds().join();
  if (key !== lastKey) {
    lastKey = key;
    if (state.msgDocs) renderMessages(state.msgDocs, false);
  }
  const items = [];
  for (const id of pinnedIds()) {
    const m = pinnedMessage(id);
    if (m === null || m?.event) continue; // supprimé, ou annonce (« a rejoint ») et non message
    const li = document.createElement("li");
    li.className = "pin";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "pin-open";
    if (m) {
      const who = document.createElement("strong");
      who.textContent = displayText(m.authorUid, m.authorName);
      const txt = document.createElement("span");
      txt.textContent = excerpt(m);
      open.append(who, txt);
      open.title = "Voir le message dans la conversation";
      open.addEventListener("click", () => revealMessage(id));
    } else {
      open.disabled = true;
      open.textContent = "Chargement…";
    }
    li.append(open);
    if (state.isAdmin) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "pin-del";
      del.textContent = "✕";
      del.title = "Retirer l'épingle";
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", () => togglePin(id));
      li.append(del);
    }
    items.push(li);
  }
  $("pinned-list").replaceChildren(...items);
  const toggle = $("btn-pinned-toggle");
  $("pinned-count").textContent = items.length > 1 ? String(items.length) : "";
  toggle.disabled = items.length < 2;
  toggle.title = items.length < 2 ? "Message épinglé"
    : bar.classList.contains("expanded") ? "Réduire" : `Afficher les ${items.length} messages épinglés`;
  toggle.setAttribute("aria-label", toggle.title);
  bar.hidden = !items.length;
}

$("btn-pinned-toggle").addEventListener("click", () => {
  const bar = $("chat-pinned");
  const open = !bar.classList.contains("expanded");
  bar.classList.toggle("expanded", open);
  $("btn-pinned-toggle").setAttribute("aria-expanded", String(open));
  renderPinned();
});

/**
 * Épingle ou désépingle un message de la conversation ouverte (admin).
 * @param {string} id
 */
export async function togglePin(id) {
  const convId = state.selectedId;
  if (!state.isAdmin || !convId) return;
  const pinned = isPinned(id);
  if (!pinned && pinnedIds().length >= MAX_PINNED) {
    toast(`${MAX_PINNED} messages épinglés au plus : retire d'abord une épingle.`, { error: true });
    return;
  }
  try {
    await updateDoc(doc(db, "conversations", convId), { pinned: pinned ? arrayRemove(id) : arrayUnion(id) });
  } catch (err) {
    console.error(err);
    toast((pinned ? "Impossible de retirer l'épingle : " : "Épinglage impossible : ") + err.message, { error: true });
  }
}

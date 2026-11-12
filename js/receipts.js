// Accusés de lecture : « Vu par … » sous son dernier message, et enregistrement de sa propre lecture.

import { doc, serverTimestamp, setDoc } from "./sdk/firebase-firestore.js";
import { ADMIN_UID, db } from "./firebase.js";
import { displayText } from "./names.js";
import { $ } from "./ui.js";
import { isViewing, state } from "./state.js";

/* ---------- Accusés de lecture ---------- */

// Chaque membre enregistre la date à laquelle il a vu la conversation pour la dernière fois ;
// « Vu par … » est affiché sous son propre dernier message uniquement.
function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.slice(0, -1).join(", ") + " et " + names.at(-1);
  return `${names.slice(0, 2).join(", ")} et ${names.length - 2} autres`;
}

export function renderReceipt() {
  const list = $("messages");
  list.querySelector(".receipt")?.remove();
  if (!state.reads) return;

  let last = null;
  for (const [id, m] of state.msgById) if (m.authorUid === state.user.uid) last = [id, m];
  if (!last) return;
  const li = document.getElementById("msg-" + last[0]);
  if (!li) return;

  const t = last[1].createdAt?.toMillis?.() ?? 0;
  const c = state.conversations.get(state.selectedId);
  const participants = new Set([...(c?.members || []), ADMIN_UID]); // anciens membres exclus
  const names = [...state.reads]
    .filter(([uid, r]) => uid !== state.user.uid && participants.has(uid) && r.t >= t)
    .map(([uid, r]) => displayText(uid, r.name)); // r.name : anciens accusés uniquement

  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const p = document.createElement("p");
  p.className = "receipt";
  if (state.pending.has(last[0])) {
    p.textContent = "Envoi…";
    p.title = "Pas encore reçu par le serveur : il partira dès le retour du réseau. Ne ferme pas la page d'ici là.";
  } else {
    p.textContent = names.length ? "Vu par " + listNames(names) : "Envoyé";
    if (names.length > 3) p.title = names.join(", ");
  }
  li.append(p);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// Enregistre qu'on a vu le dernier message des autres, si ce n'est pas déjà fait.
export function syncMyRead() {
  const id = state.selectedId;
  if (!id || !state.reads || !isViewing(id)) return;
  let latest = 0;
  for (const m of state.msgById.values()) {
    if (m.authorUid !== state.user.uid) latest = Math.max(latest, m.createdAt?.toMillis?.() ?? 0);
  }
  const mine = state.reads.get(state.user.uid)?.t ?? 0;
  if (!latest || latest <= mine || latest <= state.readWrite) return;
  state.readWrite = latest;
  // Pas de nom : les autres membres le lisent dans l'annuaire.
  setDoc(doc(db, "conversations", id, "reads", state.user.uid), {
    uid: state.user.uid,
    lastRead: serverTimestamp(),
  }).catch((err) => console.error("Accusé de lecture impossible", err)); // réessayé au prochain message
}

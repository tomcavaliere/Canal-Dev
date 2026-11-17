// Conversation ouverte : écoute paginée des messages, rendu, réponses, modification, photos.

import {
  arrayRemove, collection, deleteField, doc, getCountFromServer, getDoc, limitToLast, onSnapshot, orderBy, query, serverTimestamp, where, writeBatch,
} from "./sdk/firebase-firestore.js";
import { confirmDialog, toast } from "./dialogs.js";
import { ADMIN_UID, db } from "./firebase.js";
import { displayName, displayText, nameOf } from "./names.js";
import { renderRichText } from "./richtext.js";
import { $, avatarEl, enterSends } from "./ui.js";
import { syncNames } from "./app.js";
import { renderReceipt, syncMyRead } from "./receipts.js";
import { applySearch } from "./search.js";
import { isMobile, state } from "./state.js";
import { bumpRate, rateWait } from "./rate.js";
import { isPinned, renderPinned, togglePin } from "./pinned.js";
import { REACTIONS, isJumbo, toggleEmojiMenu } from "./emoji.js";

/* ---------- Annonces « X a rejoint / a quitté la conversation » ---------- */

// Ajoutée au batch qui ajoute `uid` aux membres (« join ») ou l'en retire (« leave ») : les
// règles l'exigent. `authorUid` est la personne concernée : l'export et la suppression de ses
// données la couvrent ainsi.
export function addMemberEvent(batch, convId, uid, event) {
  batch.set(doc(collection(db, "conversations", convId, "messages")), {
    event, authorUid: uid, createdAt: serverTimestamp(),
  });
}

/* ---------- Fenêtre de messages (pagination) ---------- */

// Une seule écoute en temps réel couvre les `msgLimit` derniers messages. « Charger les messages
// précédents » l'agrandit de PAGE : tout ce qui est affiché reste à jour (suppressions comprises).
export const PAGE = 100;

export function listenMessages(id) {
  const q = query(collection(db, "conversations", id, "messages"), orderBy("createdAt"), limitToLast(state.msgLimit));
  const previous = state.unsubMessages;
  let first = !previous; // première ouverture : on descend en bas de la conversation
  // includeMetadataChanges : on est prévenu quand un message envoyé est confirmé par le serveur.
  state.unsubMessages = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    if (state.selectedId !== id) return;
    const full = snap.size >= state.msgLimit;
    // Fenêtre agrandie : le premier instantané vient du cache et n'a pas encore les anciens messages.
    if (state.loadingMore && (!snap.metadata.fromCache || full)) state.loadingMore = false;
    state.hasMore = full;
    state.msgDocs = snap.docs;
    renderMessages(snap.docs, first);
    first = false;
    if (state.revealId && !state.loadingMore) {
      const target = state.revealId;
      state.revealId = null;
      flashMessage(target);
    }
  }, (err) => {
    console.error(err);
  });
  // L'ancienne écoute est arrêtée après le branchement de la nouvelle : les messages déjà
  // reçus restent dans le cache et ne sont pas relus.
  previous?.();
}

function loadMore(extra = PAGE) {
  if (!state.selectedId || state.loadingMore) return;
  state.msgLimit += extra;
  state.loadingMore = true;
  renderLoadMore();
  listenMessages(state.selectedId);
}

function loadMoreItem() {
  const li = document.createElement("li");
  li.className = "load-more";
  if (state.loadingMore) {
    li.textContent = "Chargement…";
  } else if (state.hasMore) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small";
    b.textContent = "Charger les messages précédents";
    b.addEventListener("click", () => loadMore());
    li.append(b);
  } else {
    li.textContent = "Début de la conversation";
  }
  return li;
}

function renderLoadMore() {
  if (state.msgDocs) renderMessages(state.msgDocs, false);
}

// Montre un message cité (défilement + surbrillance), en agrandissant la fenêtre s'il est trop ancien.
export async function revealMessage(targetId) {
  if (state.msgById.has(targetId)) {
    flashMessage(targetId);
    return;
  }
  const convId = state.selectedId;
  try {
    const ref = collection(db, "conversations", convId, "messages");
    const target = await getDoc(doc(ref, targetId));
    if (state.selectedId !== convId) return;
    if (!target.exists()) {
      toast("Ce message a été supprimé.");
      return;
    }
    // Nombre de messages depuis le message cité (requête d'agrégation : 1 lecture par tranche de 1000).
    const count = await getCountFromServer(query(ref, where("createdAt", ">=", target.data().createdAt)));
    if (state.selectedId !== convId) return;
    const needed = Math.ceil((count.data().count + 1) / PAGE) * PAGE;
    if (needed <= state.msgLimit) return;
    state.revealId = targetId;
    loadMore(needed - state.msgLimit);
  } catch (err) {
    console.error(err);
    toast("Impossible d'afficher ce message : " + err.message, { error: true });
  }
}

function flashMessage(targetId) {
  const el = document.getElementById("msg-" + targetId);
  if (!el) return;
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth; // relance l'animation
  el.classList.add("flash");
}

// Premier élément visible en haut de la liste et sa position : le restaurer après un nouveau
// rendu évite que l'affichage saute quand des messages sont ajoutés au-dessus.
function scrollAnchor(list) {
  const top = list.getBoundingClientRect().top;
  for (const el of list.children) {
    if (!el.id) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return { id: el.id, offset: r.top - top };
  }
  return null;
}

function restoreAnchor(list, anchor) {
  const el = anchor && document.getElementById(anchor.id);
  if (!el) return;
  list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
}

/* ---------- Messages ---------- */

const timeFmt = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });
const fullFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const dayYearFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return "Aujourd'hui";
  if (dayKey(date) === dayKey(yesterday)) return "Hier";
  const label = (date.getFullYear() === today.getFullYear() ? dayFmt : dayYearFmt).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function daySeparator(date) {
  const li = document.createElement("li");
  li.className = "day-sep";
  li.setAttribute("role", "separator");
  const span = document.createElement("span");
  span.textContent = dayLabel(date);
  li.append(span);
  return li;
}

// Messages précédés d'un séparateur à chaque changement de jour.
/* ---------- Rendu incrémental ---------- */

// Éléments affichés, par clé, avec l'empreinte du contenu qui a servi à les construire.
// Un élément dont l'empreinte n'a pas changé est réutilisé tel quel : un nouveau message ne
// recrée pas les autres (focus clavier, photo chargée, modification en cours conservés).
let rendered = new Map(); // clé -> { el, sig }
let next = new Map();

function keyed(key, sig, build) {
  const prev = rendered.get(key);
  const entry = prev && prev.sig === sig ? prev : { el: build(), sig };
  entry.el.dataset.key = key;
  next.set(key, entry);
  return entry.el;
}

const millis = (t) => t?.toMillis?.() ?? null;

// Tout ce dont dépend l'affichage d'un message.
function messageSig(id, m) {
  const target = m.replyTo ? state.msgById.get(m.replyTo) : null;
  return JSON.stringify([
    m.text, m.image?.w, m.image?.h, m.image?.thumb, m.replyTo, millis(m.createdAt), millis(m.editedAt),
    displayText(m.authorUid, m.authorName),
    target ? [displayText(target.authorUid, target.authorName), excerpt(target)] : state.hasMore,
    state.pending.has(id), state.editing?.id === id, isPinned(id),
    reactionGroups(m).map(([e, uids]) => [e, uids.map((u) => displayText(u))]),
  ]);
}

function messageItems(docs) {
  const items = [keyed("load-more", JSON.stringify([state.loadingMore, state.hasMore]), loadMoreItem)];
  let day = null;
  for (const d of docs) {
    const m = state.msgById.get(d.id);
    const date = m.createdAt?.toDate?.();
    if (date && dayKey(date) !== day) {
      day = dayKey(date);
      items.push(keyed("day-" + day, dayLabel(date), () => daySeparator(date)));
    }
    if (m.event) {
      const sig = JSON.stringify([eventText(m), millis(m.createdAt), state.pending.has(d.id)]);
      items.push(keyed("msg-" + d.id, sig, () => renderEvent(d.id, m)));
    } else {
      items.push(keyed("msg-" + d.id, messageSig(d.id, m), () => renderMessage(d.id, m)));
    }
  }
  return items;
}

// Met la liste dans l'ordre voulu en ne déplaçant que les éléments nouveaux ou remplacés
// (déplacer un élément lui ferait perdre le focus).
function patchList(list, nodes) {
  const keep = new Set(nodes);
  for (const el of [...list.children]) if (!keep.has(el)) el.remove();
  nodes.forEach((node, i) => {
    const cur = list.children[i];
    if (cur !== node) list.insertBefore(node, cur ?? null);
  });
}

export function renderMessages(docs, forceScroll) {
  const list = $("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const anchor = forceScroll || nearBottom ? null : scrollAnchor(list);
  // Liste vidée (autre conversation) : plus rien à réutiliser.
  if (!list.firstElementChild) rendered = new Map();

  state.msgById = new Map(docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
  // Messages écrits localement mais pas encore confirmés par le serveur (hors ligne, réseau lent).
  state.pending = new Set(docs.filter((d) => d.metadata.hasPendingWrites).map((d) => d.id));
  syncNames();
  // Le message auquel on répondait a été supprimé : on abandonne la réponse.
  if (state.replyTo && !state.msgById.has(state.replyTo)) clearReply();
  if (state.editing && !state.msgById.has(state.editing.id)) state.editing = null;

  if (docs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Aucun message pour l'instant.";
    list.replaceChildren(li);
    rendered = new Map();
    renderPinned();
    return;
  }

  next = new Map();
  patchList(list, messageItems(docs));
  rendered = next;
  markGroups(list);
  renderPinned();
  renderReceipt();
  if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
  else restoreAnchor(list, anchor);
  applySearch();
  syncMyRead();
}

// Messages consécutifs d'un même auteur (moins de 5 min d'écart) : une seule série de bulles,
// avec le nom au début et l'avatar à la fin (affichage mobile). Posé après coup sur les éléments,
// réutilisés ou non : l'arrivée d'un message change la place du précédent dans sa série.
const GROUP_GAP = 5 * 60 * 1000;
function markGroups(list) {
  let prev = null; // { el, uid, t }
  for (const el of list.children) {
    if (!el.classList.contains("msg")) {
      prev?.el.classList.add("grp-end");
      prev = null;
      continue;
    }
    const m = state.msgById.get(el.id.slice(4));
    const uid = m?.authorUid;
    const t = millis(m?.createdAt) ?? 0;
    const joined = !!prev && prev.uid === uid && t - prev.t < GROUP_GAP;
    el.classList.toggle("grp-start", !joined);
    prev?.el.classList.toggle("grp-end", !joined);
    prev = { el, uid, t };
  }
  prev?.el.classList.add("grp-end");
}

function tag(className, text, title) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  s.title = title;
  return s;
}

// Annonce (« X a rejoint / a quitté la conversation ») : une ligne centrée, sans réponse ni modification.
const EVENT_TEXT = { join: "a rejoint la conversation", leave: "a quitté la conversation" };
export function eventText(m) {
  // Personne absente de l'annuaire (compte supprimé, nom pas encore chargé) : pas de nom inventé.
  const n = nameOf(m.authorUid);
  const what = EVENT_TEXT[m.event];
  return what ? `${typeof n === "string" ? n : "Un membre"} ${what}` : "";
}

function renderEvent(id, m) {
  const li = document.createElement("li");
  li.className = "msg-event" + (state.pending.has(id) ? " pending" : "");
  li.id = "msg-" + id;
  const span = document.createElement("span");
  span.textContent = eventText(m);
  const date = m.createdAt?.toDate?.();
  if (date) span.title = fullFmt.format(date);
  li.append(span);
  return li;
}

function renderMessage(id, m) {
  const mine = m.authorUid === state.user.uid;
  const pinned = isPinned(id);
  const li = document.createElement("li");
  li.className = "msg" + (mine ? " mine" : "") + (state.pending.has(id) ? " pending" : "") + (pinned ? " pinned" : "");
  li.id = "msg-" + id;

  // Nom tiré de l'annuaire (authorName n'est pas fiable : saisi par l'auteur).
  const who = displayName(m.authorUid, m.authorName);
  const avatar = avatarEl(who.name);

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const head = document.createElement("div");
  head.className = "msg-head";
  const name = document.createElement("strong");
  name.textContent = who.name;
  head.append(name);
  // L'UID de l'auteur est garanti par les règles : ce badge ne peut pas être imité.
  if (m.authorUid === ADMIN_UID) head.append(tag("badge", "Admin", "Administrateur du canal"));
  if (who.unverified) {
    head.append(tag("unverified", "non vérifié",
      "Ce nom ne figure pas dans l'annuaire tenu par l'administrateur : il a été saisi par l'auteur du message."));
  }
  const time = document.createElement("time");
  const date = m.createdAt?.toDate?.();
  if (date) {
    time.dateTime = date.toISOString();
    time.textContent = timeFmt.format(date);
    time.title = fullFmt.format(date);
  }
  head.append(time);
  const edited = m.editedAt?.toDate?.();
  if (edited) head.append(tag("edited", "modifié", "Modifié le " + fullFmt.format(edited)));
  if (pinned) head.append(tag("pin-tag", "📌 Épinglé", "Message mis en avant par l'administrateur"));

  // Barre d'actions qui apparaît au survol de la bulle (ordinateur) : réagir, répondre, et « ⋯ »
  // pour le reste (copier, épingler, modifier, supprimer). Sur écran tactile : appui long.
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  // Réagir : pas sur un message encore en attente d'envoi (il n'existe pas encore sur le serveur).
  if (!state.pending.has(id)) {
    const react = actionButton("😊", "Réagir avec un emoji");
    react.setAttribute("aria-haspopup", "dialog");
    react.setAttribute("aria-expanded", "false");
    react.addEventListener("click", () => toggleEmojiMenu(react, {
      emojis: REACTIONS, label: "Réactions", onPick: (e) => toggleReaction(id, e),
    }));
    actions.append(react);
  }
  const reply = actionButton("↩", "Répondre");
  reply.addEventListener("click", () => startReply(id));
  const more = actionButton("⋯", "Plus d'actions");
  more.setAttribute("aria-haspopup", "dialog");
  more.setAttribute("aria-expanded", "false");
  more.addEventListener("click", () => openMsgSheet(id, more));
  actions.append(reply, more);

  bubble.append(head);
  if (m.replyTo) bubble.append(renderQuote(m.replyTo));
  if (m.image) bubble.append(renderImage(id, m));
  if (state.editing?.id === id) {
    bubble.append(renderEditor(id, m));
  } else if (m.text) {
    const text = document.createElement("div");
    text.className = "msg-text" + (isJumbo(m.text) && !m.image ? " jumbo" : "");
    if (date) text.title = fullFmt.format(date); // heure au survol, comme dans les messageries
    text.append(renderRichText(m.text));
    bubble.append(text);
  }
  const reactions = renderReactions(id, m);
  if (reactions) bubble.append(reactions);
  // Ses propres messages sont à droite, sans avatar (la barre d'actions passe à gauche, en CSS).
  if (mine) li.append(bubble, actions);
  else li.append(avatar, bubble, actions);
  return li;
}

function actionButton(icon, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

async function deleteMessage(id, m) {
  if (!await confirmDialog("Supprimer ce message ?", { ok: "Supprimer", danger: true })) return;
  try {
    // La photo éventuelle est supprimée en même temps que le message.
    const batch = writeBatch(db);
    batch.delete(doc(db, "conversations", state.selectedId, "messages", id));
    if (m.image) batch.delete(doc(db, "conversations", state.selectedId, "images", id));
    if (m.image?.thumb) batch.delete(doc(db, "conversations", state.selectedId, "thumbs", id));
    // Épingle retirée en même temps (l'admin seul peut modifier la conversation ; une épingle
    // orpheline laissée par un membre est simplement ignorée à l'affichage).
    if (state.isAdmin && isPinned(id)) {
      batch.update(doc(db, "conversations", state.selectedId), { pinned: arrayRemove(id) });
    }
    await batch.commit();
  } catch (err) {
    console.error(err);
    toast("Suppression impossible : " + err.message, { error: true });
  }
}

/* ---------- Réactions ---------- */

// `reactions` : { uid: emoji }, une réaction par membre (les règles n'acceptent que REACTIONS).
// Groupées par emoji, dans l'ordre de REACTIONS : [[emoji, [uid…]]…].
function reactionGroups(m) {
  const by = new Map();
  for (const [uid, e] of Object.entries(m.reactions || {})) {
    if (!REACTIONS.includes(e)) continue;
    if (!by.has(e)) by.set(e, []);
    by.get(e).push(uid);
  }
  return REACTIONS.filter((e) => by.has(e)).map((e) => [e, by.get(e).sort()]);
}

function reactorName(uid) {
  if (uid === state.user.uid) return "toi";
  const n = nameOf(uid);
  return typeof n === "string" ? n : "un ancien membre";
}

function renderReactions(id, m) {
  const groups = reactionGroups(m);
  if (!groups.length) return null;
  const box = document.createElement("div");
  box.className = "reactions";
  for (const [emoji, uids] of groups) {
    const mine = uids.includes(state.user.uid);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "reaction" + (mine ? " mine" : "");
    b.setAttribute("aria-pressed", String(mine));
    const names = uids.map(reactorName).join(", ");
    b.title = `${emoji} ${names}` + (mine ? " (cliquer pour retirer)" : "");
    b.setAttribute("aria-label", `${emoji} ${uids.length} : ${names}`);
    const e = document.createElement("span");
    e.textContent = emoji;
    const n = document.createElement("span");
    n.className = "reaction-count";
    n.textContent = String(uids.length);
    b.append(e, n);
    b.addEventListener("click", () => toggleReaction(id, emoji));
    box.append(b);
  }
  return box;
}

// Choisir l'emoji déjà mis le retire ; un autre le remplace.
function toggleReaction(id, emoji) {
  const m = state.msgById.get(id);
  if (!m || m.event || !state.selectedId) return;
  const uid = state.user.uid;
  const remove = m.reactions?.[uid] === emoji;
  const batch = writeBatch(db);
  const ref = doc(db, "conversations", state.selectedId, "messages", id);
  if (remove) {
    batch.update(ref, { [`reactions.${uid}`]: deleteField() });
  } else {
    const wait = rateWait();
    if (wait) {
      toast(`Tu as envoyé beaucoup de messages en une minute : réessaie dans ${wait} s.`, { error: true });
      return;
    }
    batch.update(ref, { [`reactions.${uid}`]: emoji });
    bumpRate(batch); // ajout ou changement : limitation anti-abus, exigée par les règles
  }
  batch.commit().catch((err) => {
    console.error(err);
    toast("Réaction impossible : " + err.message, { error: true });
  });
}

/* ---------- Modification de ses messages ---------- */

// Le brouillon est gardé dans `state.editing` : un nouveau rendu (message reçu, nom mis à jour)
// recrée l'éditeur sans perdre la saisie.
function startEdit(id) {
  const m = state.msgById.get(id);
  if (!m || m.authorUid !== state.user.uid) return;
  state.editing = { id, draft: m.text || "" };
  renderMessages(state.msgDocs, false);
  const ta = $("messages").querySelector(".msg-edit textarea");
  if (!ta) return;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function cancelEdit() {
  state.editing = null;
  renderMessages(state.msgDocs, false);
}

function renderEditor(id, m) {
  const form = document.createElement("form");
  form.className = "msg-edit";
  const ta = document.createElement("textarea");
  ta.maxLength = 4000;
  ta.value = state.editing.draft;
  ta.rows = Math.min(8, Math.max(2, ta.value.split("\n").length));
  ta.setAttribute("aria-label", "Modifier le message");
  ta.addEventListener("input", () => { if (state.editing) state.editing.draft = ta.value; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && enterSends()) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const row = document.createElement("div");
  row.className = "row end";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn small";
  cancel.textContent = "Annuler";
  cancel.addEventListener("click", cancelEdit);
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn small primary";
  save.textContent = "Enregistrer";
  row.append(cancel, save);
  form.append(ta, row);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveEdit(id, m);
  });
  return form;
}

function saveEdit(id, m) {
  const text = (state.editing?.draft ?? "").trim();
  if (!text && !m.image) {
    toast("Un message sans photo ne peut pas être vide : supprime-le plutôt.", { error: true });
    return;
  }
  const convId = state.selectedId;
  if (text !== (m.text || "") && rateWait()) {
    toast(`Tu as envoyé beaucoup de messages en une minute : réessaie dans ${rateWait()} s.`, { error: true });
    return;
  }
  state.editing = null;
  if (text !== (m.text || "")) {
    // Comme pour l'envoi : affiché aussitôt, confirmé par le serveur ensuite.
    const batch = writeBatch(db);
    batch.update(doc(db, "conversations", convId, "messages", id), { text, editedAt: serverTimestamp() });
    bumpRate(batch);
    batch.commit()
      .catch((err) => {
        console.error(err);
        toast("Modification impossible : " + err.message, { error: true });
        if (state.selectedId === convId && !state.editing && state.msgById.has(id)) {
          state.editing = { id, draft: text };
          renderMessages(state.msgDocs, false);
        }
      });
  }
  renderMessages(state.msgDocs, false);
}

/* ---------- Réponses ---------- */

// Seul l'identifiant du message cité est enregistré : si l'original est supprimé,
// son contenu disparaît aussi de la citation.
export function excerpt(m) {
  if (m.event) return eventText(m);
  const t = (m.text || "").replace(/\s+/g, " ").trim();
  if (t) return t.length > 140 ? t.slice(0, 140) + "…" : t;
  return m.image ? "📷 Photo" : "";
}

function renderQuote(targetId) {
  const target = state.msgById.get(targetId);
  const q = document.createElement("button");
  q.type = "button";
  q.className = "msg-quote";
  if (!target) {
    // Pas dans la fenêtre chargée : supprimé, ou plus ancien (s'il reste des messages à charger).
    if (state.hasMore) {
      q.textContent = "Message plus ancien : cliquer pour l'afficher";
      q.addEventListener("click", () => revealMessage(targetId));
    } else {
      q.disabled = true;
      q.textContent = "Message supprimé";
    }
    return q;
  }
  const who = document.createElement("strong");
  who.textContent = displayText(target.authorUid, target.authorName);
  const txt = document.createElement("span");
  txt.textContent = excerpt(target);
  q.append(who, txt);
  q.title = "Voir le message d'origine";
  q.addEventListener("click", () => flashMessage(targetId));
  return q;
}

export function startReply(id) {
  const m = state.msgById.get(id);
  if (!m) return;
  state.replyTo = id;
  $("reply-author").textContent = displayText(m.authorUid, m.authorName);
  $("reply-excerpt").textContent = excerpt(m);
  $("reply-preview").hidden = false;
  $("msg-input").focus();
}

export function clearReply() {
  state.replyTo = null;
  $("reply-preview").hidden = true;
  $("reply-author").textContent = "";
  $("reply-excerpt").textContent = "";
}

$("btn-reply-cancel").addEventListener("click", () => {
  clearReply();
  $("msg-input").focus();
});

/* ---------- Photos : affichage ---------- */

// Les photos sont chargées à la demande (quand elles approchent de l'écran)
// et gardées en mémoire tant que la conversation reste ouverte.
export const images = { cache: new Map(), observer: null };

export function resetImages() {
  images.observer?.disconnect();
  images.observer = null;
  images.cache = new Map();
}

// Photo d'origine (`images`) ou miniature (`thumbs`, clé « t:<id> » dans le cache).
function loadImage(id, thumb = false) {
  const key = thumb ? "t:" + id : id;
  if (!images.cache.has(key)) {
    const convId = state.selectedId;
    images.cache.set(key, getDoc(doc(db, "conversations", convId, thumb ? "thumbs" : "images", id))
      .then((snap) => (snap.exists() ? snap.data().data : null))
      .catch((err) => { console.error(err); images.cache.delete(key); return null; }));
  }
  return images.cache.get(key);
}

function observeImage(img) {
  if (!images.observer) {
    images.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        images.observer.unobserve(e.target);
        showImage(e.target);
      }
    }, { root: $("messages"), rootMargin: "400px 0px" });
  }
  images.observer.observe(img);
}

async function showImage(img) {
  const data = await loadImage(img.dataset.id, img.dataset.thumb === "1");
  if (data) img.src = data;
  else img.closest(".msg-img-btn").classList.add("missing");
}

function renderImage(id, m) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-img-btn";
  const author = displayText(m.authorUid, m.authorName);
  btn.setAttribute("aria-label", `Agrandir la photo envoyée par ${author}`);
  const img = document.createElement("img");
  img.className = "msg-img";
  img.alt = `Photo envoyée par ${author}`;
  img.width = m.image.w;
  img.height = m.image.h;
  img.dataset.id = id;
  // Fil : la miniature (anciens messages sans miniature : l'original).
  const thumb = !!m.image.thumb;
  img.dataset.thumb = thumb ? "1" : "";
  btn.append(img);
  btn.addEventListener("click", async () => {
    if (!img.src) return;
    const viewer = $("viewer-img");
    viewer.src = img.src; // la miniature tout de suite, l'original dès qu'il est chargé
    viewer.alt = img.alt;
    $("dlg-image").showModal();
    if (!thumb) return;
    $("dlg-image").classList.add("loading");
    const data = await loadImage(id);
    $("dlg-image").classList.remove("loading");
    if (data && $("dlg-image").open && viewer.src === img.src) viewer.src = data;
  });
  // Déjà chargée : affichage immédiat (évite un clignotement à chaque mise à jour).
  const cached = images.cache.get(thumb ? "t:" + id : id);
  if (cached) cached.then((data) => { if (data) img.src = data; });
  else queueMicrotask(() => observeImage(img));
  return btn;
}

$("dlg-image").addEventListener("close", () => { $("viewer-img").removeAttribute("src"); });

/* ---------- Écran tactile : appui long, glisser pour répondre, heure au toucher ---------- */

// Comme dans les messageries : un appui long sur un message ouvre ses actions (réactions,
// répondre, copier, modifier…), un glissement vers le centre y répond, un toucher montre l'heure.
const LONG_PRESS_MS = 450;
const SWIPE_REPLY = 56; // px
let gesture = null; // { id, li, x, y, dir, dx, swiping, pointerId, timer }

function endGesture() {
  const g = gesture;
  if (!g) return;
  gesture = null;
  clearTimeout(g.timer);
  g.li.classList.remove("swiping", "swipe-ready");
  g.li.style.transform = "";
}

function longPress() {
  const g = gesture;
  endGesture();
  if (g && g.li.isConnected) openMsgSheet(g.id);
}

$("messages").addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" || gesture || !e.isPrimary) return;
  const target = /** @type {Element} */ (e.target);
  const li = target.closest(".msg");
  if (!li || target.closest(".msg-edit")) return;
  gesture = {
    id: li.id.slice(4), li, x: e.clientX, y: e.clientY, dir: li.classList.contains("mine") ? -1 : 1,
    dx: 0, swiping: false, pointerId: e.pointerId, timer: setTimeout(longPress, LONG_PRESS_MS),
  };
});

$("messages").addEventListener("pointermove", (e) => {
  const g = gesture;
  if (!g || e.pointerId !== g.pointerId) return;
  const dx = (e.clientX - g.x) * g.dir;
  const dy = e.clientY - g.y;
  if (!g.swiping) {
    if (dx > 12 && dx > Math.abs(dy) * 1.5) {
      g.swiping = true;
      clearTimeout(g.timer);
      g.li.classList.add("swiping");
    } else if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      endGesture(); // défilement ou geste dans l'autre sens
      return;
    } else {
      return;
    }
  }
  g.dx = Math.max(0, Math.min(80, dx - 12));
  g.li.style.transform = `translateX(${g.dx * g.dir}px)`;
  g.li.classList.toggle("swipe-ready", g.dx >= SWIPE_REPLY);
});

$("messages").addEventListener("pointerup", (e) => {
  const g = gesture;
  if (!g || e.pointerId !== g.pointerId) return;
  const reply = g.swiping && g.dx >= SWIPE_REPLY;
  endGesture();
  if (reply) startReply(g.id);
});
$("messages").addEventListener("pointercancel", (e) => {
  if (gesture && e.pointerId === gesture.pointerId) endGesture();
});

// Menu natif de l'appui long (Android) : remplacé par la feuille d'actions.
$("messages").addEventListener("contextmenu", (e) => {
  if (!gesture || gesture.swiping) return;
  e.preventDefault();
  longPress();
});

// Toucher un message : affiche (ou masque) son heure et ses mentions (modifié, épinglé).
$("messages").addEventListener("click", (e) => {
  if (!isMobile()) return;
  const target = /** @type {Element} */ (e.target);
  if (target.closest("a, button, textarea, input, form")) return;
  target.closest(".msg")?.classList.toggle("show-meta");
});

/* ---------- Feuille d'actions d'un message ---------- */

const sheet = $("dlg-msg-sheet");
// Le doigt qui a déclenché l'appui long se relève sur la feuille : ce « clic » ne doit pas la fermer.
let sheetGuardUntil = 0;

function sheetButton(label, icon, run, danger = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sheet-action" + (danger ? " danger" : "");
  const i = document.createElement("span");
  i.className = "sheet-icon";
  i.setAttribute("aria-hidden", "true");
  i.textContent = icon;
  b.append(i, label);
  b.addEventListener("click", () => {
    sheet.close();
    run();
  });
  return b;
}

/**
 * Actions d'un message : feuille en bas de l'écran (appui long), ou petit menu sous le bouton
 * « ⋯ » de la barre d'actions (`anchor`, ordinateur), sans les réactions qui ont leur bouton.
 * @param {string} id
 * @param {HTMLElement} [anchor]
 */
function openMsgSheet(id, anchor) {
  const m = state.msgById.get(id);
  if (!m || m.event || sheet.open) return;
  const pending = state.pending.has(id);
  const mine = m.authorUid === state.user.uid;

  const reactions = $("sheet-reactions");
  reactions.replaceChildren();
  reactions.hidden = pending; // pas encore sur le serveur
  if (!pending) {
    for (const emoji of REACTIONS) {
      const chosen = m.reactions?.[state.user.uid] === emoji;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-btn" + (chosen ? " mine" : "");
      b.textContent = emoji;
      b.setAttribute("aria-pressed", String(chosen));
      b.setAttribute("aria-label", chosen ? `Retirer la réaction ${emoji}` : `Réagir avec ${emoji}`);
      b.addEventListener("click", () => {
        sheet.close();
        toggleReaction(id, emoji);
      });
      reactions.append(b);
    }
  }

  const actions = [sheetButton("Répondre", "↩️", () => startReply(id))];
  if (m.text) {
    actions.push(sheetButton("Copier le texte", "📋", () => {
      navigator.clipboard?.writeText(m.text)
        .then(() => toast("Texte copié."), () => toast("Copie impossible.", { error: true }));
    }));
  }
  if (state.isAdmin && !pending) {
    const pinned = isPinned(id);
    actions.push(sheetButton(pinned ? "Désépingler" : "Épingler", "📌", () => togglePin(id)));
  }
  if (mine) actions.push(sheetButton("Modifier", "✏️", () => startEdit(id)));
  if (mine || state.isAdmin) actions.push(sheetButton("Supprimer", "🗑️", () => deleteMessage(id, m), true));
  $("sheet-actions").replaceChildren(...actions);

  if (anchor) {
    sheetAnchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    sheet.classList.add("popover");
    sheet.showModal();
    // Sous le bouton (au-dessus s'il manque de place), sans sortir de la fenêtre.
    const r = anchor.getBoundingClientRect();
    const w = sheet.offsetWidth;
    const h = sheet.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const top = r.bottom + 4 + h <= innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - h);
    sheet.style.left = left + "px";
    sheet.style.top = top + "px";
    return;
  }
  sheetGuardUntil = Date.now() + 700;
  navigator.vibrate?.(10);
  sheet.showModal();
}

let sheetAnchor = null; // bouton « ⋯ » qui a ouvert le menu
sheet.addEventListener("close", () => {
  sheet.classList.remove("popover");
  sheet.style.left = sheet.style.top = "";
  sheetAnchor?.setAttribute("aria-expanded", "false");
  sheetAnchor = null;
});

// Toucher le fond (hors de la feuille) la ferme.
sheet.addEventListener("click", (e) => {
  if (e.target !== sheet || Date.now() < sheetGuardUntil) return;
  sheet.close();
});
// Nouveau toucher après l'appui long : le garde ne sert plus.
sheet.addEventListener("pointerdown", () => { sheetGuardUntil = 0; });

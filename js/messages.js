// Conversation ouverte : écoute paginée des messages, rendu, réponses, modification, photos.

import {
  collection, doc, getCountFromServer, getDoc, limitToLast, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where, writeBatch,
} from "./sdk/firebase-firestore.js";
import { confirmDialog, toast } from "./dialogs.js";
import { ADMIN_UID, db } from "./firebase.js";
import { displayName, displayText } from "./names.js";
import { renderRichText } from "./richtext.js";
import { $, avatarEl } from "./ui.js";
import { syncNames } from "./app.js";
import { renderReceipt, syncMyRead } from "./receipts.js";
import { applySearch } from "./search.js";
import { state } from "./state.js";

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
  $("messages").querySelector(".load-more")?.replaceWith(loadMoreItem());
}

// Montre un message cité (défilement + surbrillance), en agrandissant la fenêtre s'il est trop ancien.
async function revealMessage(targetId) {
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
  el.scrollIntoView({ behavior: "smooth", block: "center" });
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
function messageItems(docs) {
  const items = [];
  let day = null;
  for (const d of docs) {
    const m = state.msgById.get(d.id);
    const date = m.createdAt?.toDate?.();
    if (date && dayKey(date) !== day) {
      day = dayKey(date);
      items.push(daySeparator(date));
    }
    items.push(renderMessage(d.id, m));
  }
  return items;
}

export function renderMessages(docs, forceScroll) {
  const list = $("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const anchor = forceScroll || nearBottom ? null : scrollAnchor(list);
  // Modification en cours : le curseur est remis en place après le nouveau rendu.
  const editor = list.querySelector(".msg-edit textarea");
  const caret = editor && document.activeElement === editor ? [editor.selectionStart, editor.selectionEnd] : null;

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
    return;
  }

  list.replaceChildren(loadMoreItem(), ...messageItems(docs));
  renderReceipt();
  if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
  else restoreAnchor(list, anchor);
  applySearch();
  if (caret) {
    const ta = list.querySelector(".msg-edit textarea");
    ta?.focus({ preventScroll: true });
    ta?.setSelectionRange(...caret);
  }
  syncMyRead();
}

function tag(className, text, title) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  s.title = title;
  return s;
}

function renderMessage(id, m) {
  const mine = m.authorUid === state.user.uid;
  const li = document.createElement("li");
  li.className = "msg" + (mine ? " mine" : "") + (state.pending.has(id) ? " pending" : "");
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

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const reply = document.createElement("button");
  reply.type = "button";
  reply.textContent = "Répondre";
  reply.addEventListener("click", () => startReply(id));
  actions.append(reply);
  head.append(actions);

  if (mine) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Modifier";
    edit.addEventListener("click", () => startEdit(id));
    actions.append(edit);
  }
  if (mine || state.isAdmin) {
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "Supprimer";
    del.addEventListener("click", async () => {
      if (!await confirmDialog("Supprimer ce message ?", { ok: "Supprimer", danger: true })) return;
      try {
        // La photo éventuelle est supprimée en même temps que le message.
        const batch = writeBatch(db);
        batch.delete(doc(db, "conversations", state.selectedId, "messages", id));
        if (m.image) batch.delete(doc(db, "conversations", state.selectedId, "images", id));
        await batch.commit();
      } catch (err) {
        console.error(err);
        toast("Suppression impossible : " + err.message, { error: true });
      }
    });
    actions.append(del);
  }

  bubble.append(head);
  if (m.replyTo) bubble.append(renderQuote(m.replyTo));
  if (m.image) bubble.append(renderImage(id, m));
  if (state.editing?.id === id) {
    bubble.append(renderEditor(id, m));
  } else if (m.text) {
    const text = document.createElement("div");
    text.className = "msg-text";
    text.append(renderRichText(m.text));
    bubble.append(text);
  }
  // Ses propres messages sont à droite, sans avatar.
  if (mine) li.append(bubble);
  else li.append(avatar, bubble);
  return li;
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
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
  state.editing = null;
  if (text !== (m.text || "")) {
    // Comme pour l'envoi : affiché aussitôt, confirmé par le serveur ensuite.
    updateDoc(doc(db, "conversations", convId, "messages", id), { text, editedAt: serverTimestamp() })
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

function loadImage(id) {
  if (!images.cache.has(id)) {
    const convId = state.selectedId;
    images.cache.set(id, getDoc(doc(db, "conversations", convId, "images", id))
      .then((snap) => (snap.exists() ? snap.data().data : null))
      .catch((err) => { console.error(err); images.cache.delete(id); return null; }));
  }
  return images.cache.get(id);
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
  const data = await loadImage(img.dataset.id);
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
  btn.append(img);
  btn.addEventListener("click", () => {
    if (!img.src) return;
    $("viewer-img").src = img.src;
    $("viewer-img").alt = img.alt;
    $("dlg-image").showModal();
  });
  // Déjà chargée : affichage immédiat (évite un clignotement à chaque mise à jour).
  const cached = images.cache.get(id);
  if (cached) cached.then((data) => { if (data) img.src = data; });
  else queueMicrotask(() => observeImage(img));
  return btn;
}

$("dlg-image").addEventListener("close", () => { $("viewer-img").removeAttribute("src"); });

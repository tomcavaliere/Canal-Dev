// Messages non lus : date de dernière lecture (synchronisée entre appareils), écoute des
// nouveaux messages de chaque conversation, son, notifications et compteurs.

import {
  collection, collectionGroup, limitToLast, onSnapshot, orderBy, query, Timestamp, where,
} from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { displayText } from "./names.js";
import { showNotification } from "./notify.js";
import { playMessageSound } from "./sound.js";
import { $, announce } from "./ui.js";
import { selectConversation } from "./app.js";
import { excerpt } from "./messages.js";
import { syncMyRead } from "./receipts.js";
import { renderConversationList } from "./sidebar.js";
import { isViewing, state } from "./state.js";

/* ---------- Nouveaux messages : son et notifications ---------- */

// Écoute des messages postérieurs à la dernière lecture de chacune de ses conversations
// (une lecture Firestore par message reçu) : compteur de non-lus, son et notification,
// même quand la conversation n'est pas ouverte.
export function syncMessageWatchers() {
  for (const [id, unsub] of state.msgWatchers) {
    if (state.conversations.has(id)) continue;
    unsub();
    state.msgWatchers.delete(id);
    state.recent.delete(id);
    state.unread.delete(id);
  }
  for (const id of state.conversations.keys()) {
    if (state.msgWatchers.has(id)) continue;
    // Chargement initial tant qu'aucun instantané n'est venu du serveur : au démarrage hors
    // ligne, le premier vient du cache et tout ce qui arrive au retour du réseau n'est pas « nouveau ».
    let first = true;
    let latest = 0; // date du message le plus récent déjà vu
    const since = Timestamp.fromMillis(lastReadOf(id));
    const q = query(collection(db, "conversations", id, "messages"),
      where("createdAt", ">", since), orderBy("createdAt"), limitToLast(100));
    // includeMetadataChanges : être prévenu du passage « cache → serveur » même sans nouveau message.
    state.msgWatchers.set(id, onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type !== "added") continue;
        const m = ch.doc.data({ serverTimestamps: "estimate" });
        const t = m.createdAt?.toMillis?.() ?? 0;
        // Ni au chargement, ni pour ses propres messages, ni pour un ancien message
        // qui redevient visible après une suppression.
        if (!first && t > latest && m.authorUid !== state.user.uid) onIncomingMessage(id, m);
        latest = Math.max(latest, t);
      }
      if (!snap.metadata.fromCache) first = false;
      state.recent.set(id, snap.docs.map((d) => {
        const m = d.data({ serverTimestamps: "estimate" });
        return { t: m.createdAt?.toMillis?.() ?? 0, authorUid: m.authorUid, authorName: m.authorName, excerpt: excerpt(m) };
      }));
      if (isViewing(id)) markRead(id);
      else updateUnread(id);
    }, (err) => console.error("Écoute des nouveaux messages impossible", err)));
  }
}

function onIncomingMessage(convId, m) {
  playMessageSound();
  const who = displayText(m.authorUid, m.authorName);
  const c = state.conversations.get(convId);
  // Seuls les messages qui arrivent sont annoncés (pas le chargement d'une conversation).
  if (isViewing(convId)) {
    announce(`${who} : ${excerpt(m)}`);
    return;
  }
  announce(`Nouveau message de ${who} dans « ${c?.title || "une conversation"} »`);
  showNotification({
    title: `${who} · ${c?.title || "Canal Dev"}`,
    body: excerpt(m),
    tag: convId,
    conv: convId,
    onClick: () => selectConversation(convId),
  });
}

/* ---------- Messages non lus ---------- */

// Date de dernière lecture, par conversation. Deux sources :
//  - ses accusés de lecture (conversations/{id}/reads/{uid}), écrits dès qu'on voit un nouveau
//    message : ils synchronisent les non-lus entre ses appareils ;
//  - ce navigateur (une clé par compte), à jour immédiatement, y compris hors ligne.
// La plus récente des deux l'emporte. Une conversation inconnue des deux est considérée comme lue
// jusqu'à maintenant la toute première fois (pas de rafale de non-lus à la mise en service),
// puis entièrement non lue ensuite (nouvelle conversation à laquelle on vient d'être ajouté).
const read = { key: null, map: {} };

// Les écoutes des nouveaux messages attendent ces dates pour savoir à partir d'où compter.
export function listenMyReads() {
  const q = query(collectionGroup(db, "reads"), where("uid", "==", state.user.uid));
  const apply = (map) => {
    const first = !state.myReads;
    state.myReads = map;
    if (first && state.convsLoaded) {
      syncMessageWatchers();
      pruneLastRead();
    }
    for (const id of state.recent.keys()) updateUnread(id);
  };
  state.unsubMyReads = onSnapshot(q, (snap) => {
    apply(new Map(snap.docs.map((d) => [
      d.ref.parent.parent.id,
      d.data({ serverTimestamps: "estimate" }).lastRead?.toMillis?.() ?? 0,
    ])));
  }, (err) => {
    // Sans cette écoute, les non-lus restent propres à ce navigateur.
    console.error("Lecture de ses accusés de lecture impossible", err);
    if (!state.myReads) apply(new Map());
  });
}

export function loadLastRead(uid) {
  read.key = "canal-dev.lastRead." + uid;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(read.key)); } catch { /* ignoré */ }
  read.map = stored && typeof stored === "object" ? stored : { "*": Date.now() };
}

function saveLastRead() {
  try { localStorage.setItem(read.key, JSON.stringify(read.map)); } catch { /* ignoré */ }
}

function lastReadOf(id) {
  const synced = state.myReads?.get(id);
  if (!(id in read.map)) {
    if (synced != null) return synced; // déjà lue sur un autre appareil
    read.map[id] = read.map["*"] ?? 0;
    saveLastRead();
  }
  return Math.max(read.map[id], synced ?? 0);
}

// Oublie les conversations auxquelles on n'a plus accès.
export function pruneLastRead() {
  let changed = false;
  for (const id of Object.keys(read.map)) {
    if (id !== "*" && !state.conversations.has(id)) { delete read.map[id]; changed = true; }
  }
  // Après le premier chargement, une conversation inconnue est entièrement non lue.
  if (read.map["*"]) { read.map["*"] = 0; changed = true; }
  if (changed) saveLastRead();
}

export function unreadMessages(id) {
  const since = lastReadOf(id);
  return (state.recent.get(id) || []).filter((m) => m.t > since && m.authorUid !== state.user.uid);
}

function updateUnread(id) {
  const n = unreadMessages(id).length;
  // Le nombre ne change pas, mais l'aperçu du dernier message non lu, si.
  if (n && (state.unread.get(id) || 0) === n) { renderConversationList(); return; }
  if ((state.unread.get(id) || 0) === n) return;
  if (n) state.unread.set(id, n); else state.unread.delete(id);
  renderConversationList();
  renderUnreadTotal();
}

export function markRead(id) {
  const latest = Math.max(lastReadOf(id), ...(state.recent.get(id) || []).map((m) => m.t));
  if (latest > (read.map[id] ?? 0)) {
    read.map[id] = latest;
    saveLastRead();
  }
  updateUnread(id);
}

export function markViewedRead() {
  if (state.selectedId && isViewing(state.selectedId)) markRead(state.selectedId);
  syncMyRead();
}
document.addEventListener("visibilitychange", markViewedRead);

function formatCount(n) {
  return n > 99 ? "99+" : String(n);
}

export function unreadBadge(n, label) {
  const b = document.createElement("span");
  b.className = "unread";
  b.textContent = formatCount(n);
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

export function unreadLabel(n) {
  return `${n} message${n > 1 ? "s" : ""} non lu${n > 1 ? "s" : ""}`;
}

// Total dans le titre de l'onglet, le bouton retour (mobile) et l'icône de l'app installée.
export function renderUnreadTotal() {
  let total = 0;
  for (const n of state.unread.values()) total += n;
  document.title = total ? `(${formatCount(total)}) Canal Dev` : "Canal Dev";
  $("btn-back").textContent = total ? `← ${formatCount(total)}` : "←";
  $("btn-back").setAttribute("aria-label", "Retour aux conversations" + (total ? ` (${unreadLabel(total)})` : ""));
  try {
    if (total) navigator.setAppBadge?.(total)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch { /* non pris en charge */ }
}

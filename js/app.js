import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, deleteUser,
} from "./sdk/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, writeBatch,
  orderBy, limitToLast, onSnapshot, serverTimestamp, deleteField, Timestamp,
} from "./sdk/firebase-firestore.js";
import { auth, db, isConfigured, ADMIN_UID, GMAIL_RE } from "./firebase.js";
import { initAccount } from "./account.js";
import { avatarEl, initials } from "./ui.js";
import { prepareImage } from "./images.js";
import { isSoundEnabled, setSoundEnabled, playMessageSound } from "./sound.js";
import { notificationState, toggleNotifications, showNotification } from "./notify.js";
import { startNames, stopNames, watchNames, displayName, displayText } from "./names.js";
import { renderRichText } from "./richtext.js";

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  isAdmin: false,
  conversations: new Map(), // id -> data
  projects: new Map(), // id -> data (null si le projet n'existe plus)
  selectedId: null,
  unsubConvs: null,
  unsubProjects: null, // admin : écoute de toute la collection
  projectSubs: new Map(), // non-admin : id -> unsubscribe (un écouteur par projet visible)
  unsubMessages: null,
  unsubReads: null,
  reads: null, // conversation ouverte : uid -> { name, t } (null tant que non chargé)
  readWrite: 0, // date du dernier message dont on a déjà envoyé l'accusé de lecture
  msgWatchers: new Map(), // id de conversation -> unsubscribe (écoute des messages non lus)
  recent: new Map(), // id de conversation -> [{ t, authorUid }] messages reçus depuis la dernière lecture
  unread: new Map(), // id de conversation -> nombre de messages non lus
  msgById: new Map(), // messages chargés de la conversation ouverte : id -> data
  msgDocs: null, // derniers documents affichés (pour réafficher quand l'annuaire des noms change)
  pending: new Set(), // identifiants des messages de la conversation ouverte pas encore confirmés par le serveur
  replyTo: null, // identifiant du message auquel on répond
  admin: null, // API renvoyée par admin.js
};

/* ---------- Écrans ---------- */

const SCREENS = ["screen-loading", "screen-login", "screen-pending", "screen-app"];
function show(screenId) {
  for (const id of SCREENS) $(id).hidden = id !== screenId;
}

function showLoginError(msg) {
  $("login-error").textContent = msg;
  $("login-error").hidden = !msg;
}

/* ---------- Authentification ---------- */

if (!isConfigured) {
  show("screen-login");
  $("btn-login").disabled = true;
  showLoginError("Firebase n'est pas encore configuré : renseigne js/firebase-config.js (voir README).");
} else {
  $("btn-login").addEventListener("click", login);
  document.querySelectorAll(".btn-logout").forEach((b) => b.addEventListener("click", () => signOut(auth)));
  initAccount();
  onAuthStateChanged(auth, onAuth);
}

document.querySelectorAll("dialog [data-close]").forEach((b) => {
  b.addEventListener("click", () => b.closest("dialog").close());
});

async function login() {
  showLoginError("");
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      console.error(err);
      showLoginError("Connexion impossible : " + (err.message || err.code));
    }
  }
}

// Numéro de la session en cours : une session remplacée pendant son démarrage (déconnexion
// ou changement de compte pendant un `await`) s'arrête au lieu de brancher ses écoutes.
let sessionId = 0;
class StaleSession extends Error {}

// Une erreur au démarrage ne doit jamais laisser la page bloquée sur « Chargement… ».
async function onAuth(user) {
  const id = ++sessionId;
  try {
    await startSession(user, id);
  } catch (err) {
    if (err instanceof StaleSession || id !== sessionId) return; // une autre session a pris la main
    console.error(err);
    $("pending-error").textContent = "Erreur de chargement : " + (err.message || err)
      + ". Recharge la page (Cmd/Ctrl + Maj + R).";
    $("pending-error").hidden = false;
    show("screen-pending");
  }
}

async function startSession(user, id) {
  const current = () => { if (id !== sessionId) throw new StaleSession(); };
  teardown();
  if (!user) {
    show("screen-login");
    return;
  }
  if (!user.email || !GMAIL_RE.test(user.email) || !user.emailVerified) {
    await refuseAccount(user);
    showLoginError("Seules les adresses Gmail (@gmail.com) sont acceptées.");
    return;
  }

  state.user = user;
  state.isAdmin = user.uid === ADMIN_UID;
  loadLastRead(user.uid);
  startNames({ isAdmin: state.isAdmin, onChange: scheduleNamesRender });
  show("screen-loading");

  await upsertUser(user);
  current();
  fillUserHeader(user);

  if (state.isAdmin) {
    const { setupAdmin } = await import("./admin.js");
    current();
    state.admin = setupAdmin({
      getConversations: () => state.conversations,
      getProjects: () => state.projects,
      getSelected: () => (state.selectedId ? { id: state.selectedId, ...state.conversations.get(state.selectedId) } : null),
      selectConversation,
    });
  }
  if (state.isAdmin) listenAllProjects();
  listenConversations();
}

// Connexion refusée. Firebase Authentication a déjà créé un compte (email, nom, photo) :
// pour une adresse non Gmail, il est supprimé aussitôt (minimisation RGPD) ; la connexion
// vient d'avoir lieu, donc aucune réauthentification n'est nécessaire.
async function refuseAccount(user) {
  if (user.email && GMAIL_RE.test(user.email)) {
    await signOut(auth); // Gmail à l'adresse non vérifiée : simple déconnexion
    return;
  }
  try {
    await deleteUser(user);
  } catch (err) {
    console.warn("Suppression du compte refusé impossible", err);
    await signOut(auth);
  }
}

function teardown() {
  state.unsubConvs?.();
  state.unsubProjects?.();
  state.projectSubs.forEach((unsub) => unsub());
  state.unsubMessages?.();
  state.unsubReads?.();
  state.msgWatchers.forEach((unsub) => unsub());
  state.admin?.teardown();
  stopNames();
  resetImages();
  clearAttachment();
  clearReply();
  Object.assign(state, {
    user: null, isAdmin: false, conversations: new Map(), projects: new Map(), selectedId: null,
    unsubConvs: null, unsubProjects: null, projectSubs: new Map(), unsubMessages: null, msgWatchers: new Map(), admin: null,
    unsubReads: null, reads: null, readWrite: 0,
    recent: new Map(), unread: new Map(),
    msgById: new Map(), msgDocs: null, pending: new Set(),
  });
  $("conv-list").replaceChildren();
  $("messages").replaceChildren();
  renderUnreadTotal();
  $("chat-view").hidden = true;
  $("chat-empty").hidden = false;
}

async function upsertUser(user) {
  // Minimisation RGPD : seuls l'email, le nom et les dates sont conservés.
  const ref = doc(db, "users", user.uid);
  const data = {
    email: user.email,
    displayName: user.displayName || user.email,
    lastLogin: serverTimestamp(),
  };
  try {
    const snap = await getDoc(ref);
    // deleteField retire la photo des profils créés avant la mise en conformité.
    if (snap.exists()) await updateDoc(ref, { ...data, photoURL: deleteField() });
    else await setDoc(ref, { ...data, createdAt: serverTimestamp() });
  } catch (err) {
    console.error("Enregistrement du profil impossible", err);
  }
}

function fillUserHeader(user) {
  $("user-avatar").textContent = initials(user.displayName || user.email);
  $("user-name").textContent = user.displayName || user.email;
  $("admin-badge").hidden = !state.isAdmin;
  $("sidebar-admin-actions").hidden = !state.isAdmin;
  $("admin-users").hidden = !state.isAdmin;
  $("pending-email").textContent = user.email;
  $("pending-uid").textContent = user.uid;
}

/* ---------- Conversations ---------- */

function listenConversations() {
  const ref = collection(db, "conversations");
  const q = state.isAdmin ? query(ref) : query(ref, where("members", "array-contains", state.user.uid));

  state.unsubConvs = onSnapshot(q, (snap) => {
    state.conversations = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));

    if (!state.isAdmin && state.conversations.size === 0) {
      show("screen-pending");
    } else {
      show("screen-app");
    }

    if (state.selectedId && !state.conversations.has(state.selectedId)) {
      closeConversation();
    }
    if (!state.selectedId && state.conversations.size > 0 && !isMobile()) {
      selectConversation(sortedConversations()[0][0]);
    }
    if (!state.isAdmin) syncProjectListeners();
    syncNames();
    syncMessageWatchers();
    pruneLastRead();
    renderConversationList();
    if (state.selectedId) renderChatHeader();
    state.admin?.onConversationsChanged();
  }, (err) => {
    console.error(err);
    $("pending-error").textContent = "Erreur de lecture : " + err.message;
    $("pending-error").hidden = false;
    show("screen-pending");
  });
}

function byCreatedDesc(a, b) {
  return (b[1].createdAt?.toMillis?.() ?? 0) - (a[1].createdAt?.toMillis?.() ?? 0);
}

function sortedConversations() {
  return [...state.conversations.entries()].sort(byCreatedDesc);
}

/* ---------- Projets ---------- */

// Admin : tous les projets (même vides).
function listenAllProjects() {
  state.unsubProjects = onSnapshot(collection(db, "projects"), (snap) => {
    state.projects = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
    renderConversationList();
    if (state.selectedId) renderChatHeader();
    state.admin?.onProjectsChanged();
  }, (err) => console.error("Lecture des projets impossible", err));
}

// Non-admin : uniquement les projets de ses conversations, lus un par un.
function syncProjectListeners() {
  const needed = new Set();
  for (const c of state.conversations.values()) if (c.projectId) needed.add(c.projectId);

  for (const [id, unsub] of state.projectSubs) {
    if (needed.has(id)) continue;
    unsub();
    state.projectSubs.delete(id);
    state.projects.delete(id);
  }
  for (const id of needed) {
    if (state.projectSubs.has(id)) continue;
    state.projectSubs.set(id, onSnapshot(doc(db, "projects", id), (snap) => {
      state.projects.set(id, snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : null);
      renderConversationList();
      if (state.selectedId) renderChatHeader();
    }, (err) => console.error("Lecture du projet impossible", err)));
  }
}

// Projet réel d'une conversation, ou null si elle n'en a pas (ou s'il a disparu).
function projectOf(c) {
  return c.projectId && state.projects.get(c.projectId) ? c.projectId : null;
}

/* ---------- Annuaire des noms ---------- */

// Noms à suivre : membres de ses conversations, l'admin, et les auteurs des messages
// affichés (y compris d'anciens membres). L'admin, lui, écoute tout l'annuaire.
function syncNames() {
  if (state.isAdmin || !state.user) return;
  const uids = new Set([ADMIN_UID]);
  for (const c of state.conversations.values()) for (const uid of c.members || []) uids.add(uid);
  for (const m of state.msgById.values()) uids.add(m.authorUid);
  watchNames(uids);
}

// Les noms arrivent après les messages : on réaffiche quand l'annuaire change
// (une seule fois par image, même si plusieurs noms arrivent ensemble).
let namesFrame = 0;
function scheduleNamesRender() {
  if (namesFrame) return;
  namesFrame = requestAnimationFrame(() => {
    namesFrame = 0;
    if (state.selectedId && state.msgDocs) renderMessages(state.msgDocs, false);
    const replied = state.replyTo && state.msgById.get(state.replyTo);
    if (replied) $("reply-author").textContent = displayText(replied.authorUid, replied.authorName);
    state.admin?.onNamesChanged();
  });
}

// Projets repliés dans la barre latérale (préférence locale, sans importance si perdue).
const COLLAPSED_KEY = "canal-dev.collapsedProjects";
const collapsed = new Set((() => {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; }
})());
function toggleCollapsed(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* ignoré */ }
  renderConversationList();
}

/* ---------- Nouveaux messages : son et notifications ---------- */

// Écoute des messages postérieurs à la dernière lecture de chacune de ses conversations
// (une lecture Firestore par message reçu) : compteur de non-lus, son et notification,
// même quand la conversation n'est pas ouverte.
function syncMessageWatchers() {
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
        return { t: m.createdAt?.toMillis?.() ?? 0, authorUid: m.authorUid };
      }));
      if (isViewing(id)) markRead(id);
      else updateUnread(id);
    }, (err) => console.error("Écoute des nouveaux messages impossible", err)));
  }
}

function isViewing(convId) {
  return !document.hidden && convId === state.selectedId
    && (!isMobile() || $("screen-app").classList.contains("show-chat"));
}

function onIncomingMessage(convId, m) {
  playMessageSound();
  if (isViewing(convId)) return;
  const c = state.conversations.get(convId);
  showNotification({
    title: `${displayText(m.authorUid, m.authorName)} · ${c?.title || "Canal Dev"}`,
    body: excerpt(m),
    tag: convId,
    onClick: () => selectConversation(convId),
  });
}

/* ---------- Messages non lus ---------- */

// Date du dernier message lu, par conversation, gardée dans ce navigateur (une clé par compte).
// Une conversation inconnue est considérée comme lue jusqu'à maintenant la toute première fois
// (pas de rafale de non-lus à la mise en service), puis entièrement non lue ensuite
// (nouvelle conversation à laquelle on vient d'être ajouté).
const read = { key: null, map: {} };

function loadLastRead(uid) {
  read.key = "canal-dev.lastRead." + uid;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(read.key)); } catch { /* ignoré */ }
  read.map = stored && typeof stored === "object" ? stored : { "*": Date.now() };
}

function saveLastRead() {
  try { localStorage.setItem(read.key, JSON.stringify(read.map)); } catch { /* ignoré */ }
}

function lastReadOf(id) {
  if (!(id in read.map)) {
    read.map[id] = read.map["*"] ?? 0;
    saveLastRead();
  }
  return read.map[id];
}

// Oublie les conversations auxquelles on n'a plus accès.
function pruneLastRead() {
  let changed = false;
  for (const id of Object.keys(read.map)) {
    if (id !== "*" && !state.conversations.has(id)) { delete read.map[id]; changed = true; }
  }
  // Après le premier chargement, une conversation inconnue est entièrement non lue.
  if (read.map["*"]) { read.map["*"] = 0; changed = true; }
  if (changed) saveLastRead();
}

function updateUnread(id) {
  const since = lastReadOf(id);
  const n = (state.recent.get(id) || []).filter((m) => m.t > since && m.authorUid !== state.user.uid).length;
  if ((state.unread.get(id) || 0) === n) return;
  if (n) state.unread.set(id, n); else state.unread.delete(id);
  renderConversationList();
  renderUnreadTotal();
}

function markRead(id) {
  const latest = Math.max(lastReadOf(id), ...(state.recent.get(id) || []).map((m) => m.t));
  if (latest > read.map[id]) {
    read.map[id] = latest;
    saveLastRead();
  }
  updateUnread(id);
}

function markViewedRead() {
  if (state.selectedId && isViewing(state.selectedId)) markRead(state.selectedId);
  syncMyRead();
}
document.addEventListener("visibilitychange", markViewedRead);

function formatCount(n) {
  return n > 99 ? "99+" : String(n);
}

function unreadBadge(n, label) {
  const b = document.createElement("span");
  b.className = "unread";
  b.textContent = formatCount(n);
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

function unreadLabel(n) {
  return `${n} message${n > 1 ? "s" : ""} non lu${n > 1 ? "s" : ""}`;
}

// Total dans le titre de l'onglet, le bouton retour (mobile) et l'icône de l'app installée.
function renderUnreadTotal() {
  let total = 0;
  for (const n of state.unread.values()) total += n;
  document.title = total ? `(${formatCount(total)}) Canal Dev` : "Canal Dev";
  $("btn-back").textContent = total ? `← ${formatCount(total)}` : "←";
  try {
    if (total) navigator.setAppBadge?.(total)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch { /* non pris en charge */ }
}

/* ---------- Barre latérale ---------- */

function conversationItem(id, c) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  const unread = state.unread.get(id) || 0;
  btn.className = "item" + (id === state.selectedId ? " active" : "") + (unread ? " has-unread" : "");
  btn.addEventListener("click", () => selectConversation(id));

  const row = document.createElement("span");
  row.className = "item-row";
  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = c.title || "(sans titre)";
  row.append(title);
  if (unread) row.append(unreadBadge(unread, unreadLabel(unread)));
  btn.append(row);

  if (state.isAdmin) {
    const sub = document.createElement("span");
    sub.className = "item-sub";
    const n = c.members?.length ?? 0;
    sub.textContent = n === 0 ? "Aucun membre" : `${n} membre${n > 1 ? "s" : ""}`;
    btn.append(sub);
  } else if (c.description) {
    const sub = document.createElement("span");
    sub.className = "item-sub";
    sub.textContent = c.description;
    btn.append(sub);
  }
  li.append(btn);
  return li;
}

function emptyItem(text) {
  const li = document.createElement("li");
  li.className = "muted small list-empty";
  li.textContent = text;
  return li;
}

function smallButton(text, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "group-btn";
  b.textContent = text;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

// Un groupe repliable : en-tête (titre du projet) + liste de ses conversations.
function projectGroup(projectId, title, convs) {
  const li = document.createElement("li");
  li.className = "group";
  const isOpen = !collapsed.has(projectId);

  const head = document.createElement("div");
  head.className = "group-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "group-toggle";
  toggle.setAttribute("aria-expanded", String(isOpen));
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = isOpen ? "▾" : "▸";
  const name = document.createElement("span");
  name.className = "group-title";
  name.textContent = title;
  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(convs.length);
  toggle.append(caret, name, count);
  // Projet replié : ses non-lus restent visibles sur l'en-tête.
  const groupUnread = isOpen ? 0 : convs.reduce((sum, [id]) => sum + (state.unread.get(id) || 0), 0);
  if (groupUnread) toggle.append(unreadBadge(groupUnread, unreadLabel(groupUnread)));
  toggle.addEventListener("click", () => toggleCollapsed(projectId));
  head.append(toggle);

  if (state.isAdmin && projectId) {
    head.append(
      smallButton("+", `Nouvelle conversation dans « ${title} »`, () => state.admin?.newConversation(projectId)),
      smallButton("✎", `Renommer ou supprimer le projet « ${title} »`, () => state.admin?.editProject(projectId)),
    );
  }
  li.append(head);

  if (isOpen) {
    const ul = document.createElement("ul");
    ul.className = "list group-items";
    const items = convs.map(([id, c]) => conversationItem(id, c));
    if (items.length === 0) items.push(emptyItem("Aucune conversation."));
    ul.replaceChildren(...items);
    li.append(ul);
  }
  return li;
}

function renderConversationList() {
  const convs = sortedConversations();
  const byProject = new Map(); // projectId -> [[id, c], ...]
  const loose = [];
  for (const entry of convs) {
    const pid = projectOf(entry[1]);
    if (!pid) { loose.push(entry); continue; }
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(entry);
  }
  // L'admin voit aussi les projets vides.
  if (state.isAdmin) for (const pid of state.projects.keys()) if (!byProject.has(pid)) byProject.set(pid, []);

  const projects = [...byProject.keys()]
    .map((pid) => [pid, state.projects.get(pid)])
    .sort((a, b) => (a[1].title || "").localeCompare(b[1].title || "", "fr"));

  const items = projects.map(([pid, p]) => projectGroup(pid, p.title || "(sans titre)", byProject.get(pid)));

  if (projects.length === 0) {
    // Pas de projet : liste simple, comme avant.
    items.push(...loose.map(([id, c]) => conversationItem(id, c)));
    if (loose.length === 0 && state.isAdmin) items.push(emptyItem("Aucune conversation. Crée-en une."));
  } else if (loose.length > 0 || state.isAdmin) {
    items.push(projectGroup("", "Sans projet", loose));
  }
  $("conv-list").replaceChildren(...items);
}

function selectConversation(id) {
  if (!state.conversations.has(id)) return;
  $("screen-app").classList.add("show-chat");
  if (state.selectedId === id) {
    markViewedRead(); // mobile : retour sur la conversation déjà sélectionnée
    return;
  }

  state.unsubMessages?.();
  state.unsubReads?.();
  resetImages();
  clearAttachment();
  clearReply();
  state.msgById = new Map();
  state.msgDocs = null;
  state.pending = new Set();
  state.reads = null;
  state.readWrite = 0;
  state.selectedId = id;
  $("chat-empty").hidden = true;
  $("chat-view").hidden = false;
  $("chat-admin-actions").hidden = !state.isAdmin;
  $("messages").replaceChildren();
  renderChatHeader();
  if (state.recent.has(id)) markRead(id);
  renderConversationList();

  let first = true;
  const q = query(collection(db, "conversations", id, "messages"), orderBy("createdAt"), limitToLast(300));
  // includeMetadataChanges : on est prévenu quand un message envoyé est confirmé par le serveur.
  state.unsubMessages = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    state.msgDocs = snap.docs;
    renderMessages(snap.docs, first);
    first = false;
  }, (err) => {
    console.error(err);
  });
  state.unsubReads = onSnapshot(collection(db, "conversations", id, "reads"), (snap) => {
    state.reads = new Map(snap.docs.map((d) => {
      const r = d.data({ serverTimestamps: "estimate" });
      return [d.id, { name: r.name, t: r.lastRead?.toMillis?.() ?? 0 }];
    }));
    renderReceipt();
    syncMyRead();
  }, (err) => console.error("Lecture des accusés de lecture impossible", err));
}

function closeConversation() {
  state.unsubMessages?.();
  state.unsubMessages = null;
  state.unsubReads?.();
  state.unsubReads = null;
  state.reads = null;
  resetImages();
  clearAttachment();
  clearReply();
  state.msgById = new Map();
  state.msgDocs = null;
  state.pending = new Set();
  state.selectedId = null;
  $("chat-view").hidden = true;
  $("chat-empty").hidden = false;
  $("screen-app").classList.remove("show-chat");
}

function renderChatHeader() {
  const c = state.conversations.get(state.selectedId);
  if (!c) return;
  const pid = projectOf(c);
  $("chat-project").textContent = pid ? state.projects.get(pid).title || "" : "";
  $("chat-project").hidden = !pid;
  $("chat-title").textContent = c.title || "(sans titre)";
  $("chat-desc").textContent = c.description || "";
  $("chat-desc").hidden = !c.description;
}

$("btn-back").addEventListener("click", () => $("screen-app").classList.remove("show-chat"));

function renderSoundButton() {
  const on = isSoundEnabled();
  const b = $("btn-sound");
  b.textContent = on ? "🔊" : "🔇";
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Son des nouveaux messages activé (cliquer pour couper)" : "Son des nouveaux messages coupé (cliquer pour activer)";
  b.setAttribute("aria-label", b.title);
}
$("btn-sound").addEventListener("click", () => {
  setSoundEnabled(!isSoundEnabled());
  renderSoundButton();
});
renderSoundButton();

const NOTIF_TITLES = {
  on: "Notifications activées (cliquer pour les couper)",
  off: "Notifications coupées (cliquer pour les activer)",
  denied: "Notifications bloquées : autorise-les dans les réglages du site de ton navigateur",
};
function renderNotifButton() {
  const st = notificationState();
  const b = $("btn-notif");
  b.hidden = st === "unsupported";
  b.textContent = st === "on" ? "🔔" : "🔕";
  b.setAttribute("aria-pressed", String(st === "on"));
  b.title = NOTIF_TITLES[st] || "";
  b.setAttribute("aria-label", b.title);
}
$("btn-notif").addEventListener("click", async () => {
  await toggleNotifications();
  renderNotifButton();
});
renderNotifButton();

function isMobile() {
  return window.matchMedia("(max-width: 720px)").matches;
}

/* ---------- Messages ---------- */

const timeFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

function renderMessages(docs, forceScroll) {
  const list = $("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;

  state.msgById = new Map(docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
  // Messages écrits localement mais pas encore confirmés par le serveur (hors ligne, réseau lent).
  state.pending = new Set(docs.filter((d) => d.metadata.hasPendingWrites).map((d) => d.id));
  syncNames();
  // Le message auquel on répondait a été supprimé : on abandonne la réponse.
  if (state.replyTo && !state.msgById.has(state.replyTo)) clearReply();

  if (docs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Aucun message pour l'instant.";
    list.replaceChildren(li);
    return;
  }

  list.replaceChildren(...docs.map((d) => renderMessage(d.id, state.msgById.get(d.id))));
  renderReceipt();
  if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
  syncMyRead();
}

/* ---------- Accusés de lecture ---------- */

// Chaque membre enregistre la date à laquelle il a vu la conversation pour la dernière fois ;
// « Vu par … » est affiché sous son propre dernier message uniquement.
function listNames(names) {
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.slice(0, -1).join(", ") + " et " + names.at(-1);
  return `${names.slice(0, 2).join(", ")} et ${names.length - 2} autres`;
}

function renderReceipt() {
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
function syncMyRead() {
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
  }
  head.append(time);

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const reply = document.createElement("button");
  reply.type = "button";
  reply.textContent = "Répondre";
  reply.addEventListener("click", () => startReply(id));
  actions.append(reply);
  head.append(actions);

  if (mine || state.isAdmin) {
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "Supprimer";
    del.addEventListener("click", async () => {
      if (!confirm("Supprimer ce message ?")) return;
      try {
        // La photo éventuelle est supprimée en même temps que le message.
        const batch = writeBatch(db);
        batch.delete(doc(db, "conversations", state.selectedId, "messages", id));
        if (m.image) batch.delete(doc(db, "conversations", state.selectedId, "images", id));
        await batch.commit();
      } catch (err) {
        console.error(err);
        alert("Suppression impossible : " + err.message);
      }
    });
    actions.append(del);
  }

  bubble.append(head);
  if (m.replyTo) bubble.append(renderQuote(m.replyTo));
  if (m.image) bubble.append(renderImage(id, m));
  if (m.text) {
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

/* ---------- Réponses ---------- */

// Seul l'identifiant du message cité est enregistré : si l'original est supprimé,
// son contenu disparaît aussi de la citation.
function excerpt(m) {
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
    q.disabled = true;
    q.textContent = "Message supprimé ou trop ancien";
    return q;
  }
  const who = document.createElement("strong");
  who.textContent = displayText(target.authorUid, target.authorName);
  const txt = document.createElement("span");
  txt.textContent = excerpt(target);
  q.append(who, txt);
  q.title = "Voir le message d'origine";
  q.addEventListener("click", () => {
    const el = document.getElementById("msg-" + targetId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth; // relance l'animation
    el.classList.add("flash");
  });
  return q;
}

function startReply(id) {
  const m = state.msgById.get(id);
  if (!m) return;
  state.replyTo = id;
  $("reply-author").textContent = displayText(m.authorUid, m.authorName);
  $("reply-excerpt").textContent = excerpt(m);
  $("reply-preview").hidden = false;
  $("msg-input").focus();
}

function clearReply() {
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
const images = { cache: new Map(), observer: null };

function resetImages() {
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

/* ---------- Photos : pièce jointe ---------- */

let attachment = null; // { data, w, h } prête à l'envoi

function clearAttachment() {
  attachment = null;
  $("file-input").value = "";
  $("attach-preview").hidden = true;
  $("attach-img").removeAttribute("src");
  $("attach-error").hidden = true;
}

function setAttachment(image) {
  attachment = image;
  $("attach-img").src = image.data;
  $("attach-preview").hidden = false;
}

async function attachFile(file) {
  if (!file || !state.selectedId) return;
  $("attach-error").hidden = true;
  $("btn-attach").disabled = true;
  try {
    setAttachment(await prepareImage(file));
    $("msg-input").focus();
  } catch (err) {
    clearAttachment();
    $("attach-error").textContent = err.message;
    $("attach-error").hidden = false;
  } finally {
    $("btn-attach").disabled = false;
  }
}

$("btn-attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", () => attachFile($("file-input").files[0]));
$("btn-attach-remove").addEventListener("click", clearAttachment);
$("msg-input").addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) {
    e.preventDefault();
    attachFile(file);
  }
});

/* ---------- Envoi ---------- */

// Le message s'affiche aussitôt (« Envoi… ») et la saisie est libérée sans attendre le serveur :
// hors ligne, Firestore le garde et l'envoie au retour du réseau. En cas de refus, le texte,
// la photo et la réponse sont rendus pour pouvoir réessayer.
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("msg-input");
  const text = input.value.trim();
  const image = attachment;
  const replyTo = state.replyTo;
  if ((!text && !image) || !state.selectedId) return;

  const convId = state.selectedId;
  const msgRef = doc(collection(db, "conversations", convId, "messages"));
  const batch = writeBatch(db);
  batch.set(msgRef, {
    text,
    authorUid: state.user.uid,
    authorName: state.user.displayName || state.user.email,
    createdAt: serverTimestamp(),
    ...(image ? { image: { w: image.w, h: image.h } } : {}),
    ...(replyTo ? { replyTo } : {}),
  });
  if (image) {
    // La photo est rangée à part (même identifiant) pour ne pas alourdir la liste des messages.
    batch.set(doc(db, "conversations", convId, "images", msgRef.id), {
      data: image.data,
      authorUid: state.user.uid,
      createdAt: serverTimestamp(),
    });
    images.cache.set(msgRef.id, Promise.resolve(image.data));
  }
  input.value = "";
  if (image) clearAttachment();
  if (replyTo) clearReply();

  batch.commit().catch((err) => {
    console.error(err);
    images.cache.delete(msgRef.id);
    if (state.selectedId === convId) {
      if (!input.value.trim()) input.value = text;
      if (image && !attachment) setAttachment(image);
      if (replyTo && !state.replyTo) startReply(replyTo);
    }
    alert("Envoi impossible : " + err.message);
  });
});

// Bandeau « hors ligne » : les messages restent en attente jusqu'au retour du réseau.
function renderOnline() {
  $("offline-banner").hidden = navigator.onLine;
}
window.addEventListener("online", renderOnline);
window.addEventListener("offline", renderOnline);
renderOnline();

$("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.replyTo) {
    e.preventDefault();
    clearReply();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

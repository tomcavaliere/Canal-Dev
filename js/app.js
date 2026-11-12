// Point d'entrée : connexion, session, liste des conversations et projets, ouverture d'une
// conversation. Le reste est réparti dans les modules importés ci-dessous.
import {
  deleteUser, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "./sdk/firebase-auth.js";
import {
  arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from "./sdk/firebase-firestore.js";
import { initAccount } from "./account.js";
import { ADMIN_UID, auth, db, GMAIL_RE, isConfigured } from "./firebase.js";
import { displayText, startNames, stopNames, watchNames } from "./names.js";
import { notificationState, registerServiceWorker, toggleNotifications } from "./notify.js";
import { isSoundEnabled, setSoundEnabled } from "./sound.js";
import { $, initials } from "./ui.js";
import { clearAttachment } from "./composer.js";
import { clearReply, listenMessages, PAGE, renderMessages, resetImages } from "./messages.js";
import { renderReceipt, syncMyRead } from "./receipts.js";
import { closeSearch } from "./search.js";
import { projectOf, renderConversationList, sortedConversations } from "./sidebar.js";
import { isMobile, state } from "./state.js";
import {
  listenMyReads, loadLastRead, markRead, markViewedRead, pruneLastRead, renderUnreadTotal, syncMessageWatchers,
} from "./unread.js";

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
  registerServiceWorker(openFromNotification);
  onAuthStateChanged(auth, onAuth);
}

// Conversation à ouvrir dès qu'elle sera chargée : clic sur une notification
// (application déjà ouverte, ou ouverte par ce clic avec #c=<id>).
let requestedConv = (() => {
  const id = new URLSearchParams(location.hash.slice(1)).get("c");
  if (id) history.replaceState(null, "", location.pathname + location.search);
  return id;
})();

function openFromNotification(id) {
  if (state.conversations.has(id)) selectConversation(id);
  else requestedConv = id;
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
  else listenInvite(user);
  listenMyReads();
  listenConversations();
}

/* ---------- Invitation ---------- */

// L'admin peut inviter une adresse Gmail avant sa première connexion (invites/{email}).
// À la connexion, la personne enregistre le nom prévu dans l'annuaire, puis rejoint les
// conversations une par une, en retirant chacune de l'invitation dans le même batch (règles).
// L'écoute couvre aussi une invitation reçue pendant qu'on attend sur l'écran « Accès en attente ».
function listenInvite(user) {
  const ref = doc(db, "invites", user.email.toLowerCase());
  const tried = new Set(); // conversations déjà tentées dans cette session (pas de boucle en cas d'échec)
  let latest = null;
  let busy = false;
  let named = false;

  async function joinOne(inv) {
    const convId = inv.convIds.find((id) => !tried.has(id));
    if (!convId) return;
    tried.add(convId);
    if (!named) {
      named = true;
      try {
        // Nom choisi par l'admin : ses messages ne seront jamais marqués « non vérifié ».
        const mine = await getDoc(doc(db, "names", user.uid));
        if (!mine.exists()) await setDoc(doc(db, "names", user.uid), { name: inv.name, updatedAt: serverTimestamp() });
      } catch (err) {
        console.warn("Nom de l'invitation non enregistré", err);
      }
    }
    const last = inv.convIds.length === 1;
    const batch = writeBatch(db);
    batch.update(doc(db, "conversations", convId), { members: arrayUnion(user.uid) });
    if (last) batch.delete(ref);
    else batch.update(ref, { convIds: arrayRemove(convId) });
    try {
      await batch.commit();
    } catch (err) {
      // Conversation supprimée entre-temps, ou déjà membre : on la retire seulement de l'invitation.
      console.warn("Invitation : conversation ignorée", convId, err);
      await (last ? deleteDoc(ref) : updateDoc(ref, { convIds: arrayRemove(convId) })).catch(() => {});
    }
  }

  async function process() {
    if (busy) return;
    busy = true;
    try {
      while (latest?.convIds?.some((id) => !tried.has(id))) {
        const inv = latest;
        latest = null;
        await joinOne(inv);
      }
    } finally {
      busy = false;
    }
  }

  state.unsubInvite = onSnapshot(ref, (snap) => {
    latest = snap.exists() ? snap.data() : null;
    process();
  }, (err) => console.error("Lecture de l'invitation impossible", err));
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
  state.unsubMyReads?.();
  state.unsubInvite?.();
  state.msgWatchers.forEach((unsub) => unsub());
  state.admin?.teardown();
  stopNames();
  resetImages();
  clearAttachment();
  clearReply();
  Object.assign(state, {
    user: null, isAdmin: false, conversations: new Map(), convsLoaded: false, projects: new Map(), selectedId: null,
    unsubConvs: null, unsubProjects: null, projectSubs: new Map(), unsubMessages: null, msgWatchers: new Map(), admin: null,
    unsubReads: null, reads: null, readWrite: 0, myReads: null, unsubMyReads: null, unsubInvite: null,
    recent: new Map(), unread: new Map(),
    msgById: new Map(), msgDocs: null, pending: new Set(),
    msgLimit: 0, hasMore: false, loadingMore: false, revealId: null, editing: null,
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

  // includeMetadataChanges : être prévenu quand le serveur confirme une écriture locale.
  state.unsubConvs = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    // Une conversation rejointe par soi-même (invitation) apparaît d'abord localement : on attend
    // que le serveur confirme l'ajout, sinon ses messages seraient demandés avant d'y avoir droit.
    const docs = snap.docs.filter((d) => !d.metadata.hasPendingWrites || state.conversations.has(d.id));
    state.conversations = new Map(docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
    state.convsLoaded = true;

    if (!state.isAdmin && state.conversations.size === 0) {
      show("screen-pending");
    } else {
      show("screen-app");
    }

    if (state.selectedId && !state.conversations.has(state.selectedId)) {
      closeConversation();
    }
    if (requestedConv && state.conversations.has(requestedConv)) {
      selectConversation(requestedConv);
      requestedConv = null;
    }
    if (!state.selectedId && state.conversations.size > 0 && !isMobile()) {
      selectConversation(sortedConversations()[0][0]);
    }
    if (!state.isAdmin) syncProjectListeners();
    syncNames();
    if (state.myReads) {
      syncMessageWatchers();
      pruneLastRead();
    }
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

/* ---------- Annuaire des noms ---------- */

// Noms à suivre : membres de ses conversations, l'admin, et les auteurs des messages
// affichés (y compris d'anciens membres). L'admin, lui, écoute tout l'annuaire.
export function syncNames() {
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

export function selectConversation(id) {
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
  state.unsubMessages = null;
  state.msgLimit = PAGE;
  state.hasMore = false;
  state.loadingMore = false;
  state.revealId = null;
  state.editing = null;
  closeSearch();
  state.selectedId = id;
  $("chat-empty").hidden = true;
  $("chat-view").hidden = false;
  $("chat-admin-actions").hidden = !state.isAdmin;
  $("messages").replaceChildren();
  renderChatHeader();
  if (state.recent.has(id)) markRead(id);
  renderConversationList();

  listenMessages(id);
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
  state.editing = null;
  closeSearch();
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

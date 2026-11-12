import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, writeBatch,
  orderBy, limitToLast, onSnapshot, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isConfigured, ADMIN_UID, GMAIL_RE } from "./firebase.js?v=4";
import { initAccount } from "./account.js?v=4";
import { avatarEl, initials } from "./ui.js?v=4";
import { prepareImage } from "./images.js?v=4";

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

// Une erreur au démarrage ne doit jamais laisser la page bloquée sur « Chargement… ».
async function onAuth(user) {
  try {
    await startSession(user);
  } catch (err) {
    console.error(err);
    $("pending-error").textContent = "Erreur de chargement : " + (err.message || err)
      + ". Recharge la page (Cmd/Ctrl + Maj + R).";
    $("pending-error").hidden = false;
    show("screen-pending");
  }
}

async function startSession(user) {
  teardown();
  if (!user) {
    show("screen-login");
    return;
  }
  if (!user.email || !GMAIL_RE.test(user.email) || !user.emailVerified) {
    await signOut(auth);
    showLoginError("Seules les adresses Gmail (@gmail.com) sont acceptées.");
    return;
  }

  state.user = user;
  state.isAdmin = user.uid === ADMIN_UID;
  show("screen-loading");

  await upsertUser(user);
  fillUserHeader(user);

  if (state.isAdmin) {
    const { setupAdmin } = await import("./admin.js?v=4");
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

function teardown() {
  state.unsubConvs?.();
  state.unsubProjects?.();
  state.projectSubs.forEach((unsub) => unsub());
  state.unsubMessages?.();
  state.admin?.teardown();
  resetImages();
  clearAttachment();
  Object.assign(state, {
    user: null, isAdmin: false, conversations: new Map(), projects: new Map(), selectedId: null,
    unsubConvs: null, unsubProjects: null, projectSubs: new Map(), unsubMessages: null, admin: null,
  });
  $("conv-list").replaceChildren();
  $("messages").replaceChildren();
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

/* ---------- Barre latérale ---------- */

function conversationItem(id, c) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = "item" + (id === state.selectedId ? " active" : "");
  btn.addEventListener("click", () => selectConversation(id));

  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = c.title || "(sans titre)";
  btn.append(title);

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
  if (state.selectedId === id) return;

  state.unsubMessages?.();
  resetImages();
  clearAttachment();
  state.selectedId = id;
  $("chat-empty").hidden = true;
  $("chat-view").hidden = false;
  $("chat-admin-actions").hidden = !state.isAdmin;
  $("messages").replaceChildren();
  renderChatHeader();
  renderConversationList();

  let first = true;
  const q = query(collection(db, "conversations", id, "messages"), orderBy("createdAt"), limitToLast(300));
  state.unsubMessages = onSnapshot(q, (snap) => {
    renderMessages(snap.docs, first);
    first = false;
  }, (err) => {
    console.error(err);
  });
}

function closeConversation() {
  state.unsubMessages?.();
  state.unsubMessages = null;
  resetImages();
  clearAttachment();
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

function isMobile() {
  return window.matchMedia("(max-width: 720px)").matches;
}

/* ---------- Messages ---------- */

const timeFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

function renderMessages(docs, forceScroll) {
  const list = $("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;

  if (docs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Aucun message pour l'instant.";
    list.replaceChildren(li);
    return;
  }

  list.replaceChildren(...docs.map((d) => renderMessage(d.id, d.data({ serverTimestamps: "estimate" }))));
  if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
}

function renderMessage(id, m) {
  const mine = m.authorUid === state.user.uid;
  const li = document.createElement("li");
  li.className = "msg" + (mine ? " mine" : "");

  const avatar = avatarEl(m.authorName);

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const head = document.createElement("div");
  head.className = "msg-head";
  const name = document.createElement("strong");
  name.textContent = m.authorName || "?";
  const time = document.createElement("time");
  const date = m.createdAt?.toDate?.();
  if (date) {
    time.dateTime = date.toISOString();
    time.textContent = timeFmt.format(date);
  }
  head.append(name, time);

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
    head.append(del);
  }

  bubble.append(head);
  if (m.image) bubble.append(renderImage(id, m));
  if (m.text) {
    const text = document.createElement("div");
    text.className = "msg-text";
    text.textContent = m.text;
    bubble.append(text);
  }
  li.append(avatar, bubble);
  return li;
}

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
  btn.setAttribute("aria-label", `Agrandir la photo envoyée par ${m.authorName || "?"}`);
  const img = document.createElement("img");
  img.className = "msg-img";
  img.alt = `Photo envoyée par ${m.authorName || "?"}`;
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

async function attachFile(file) {
  if (!file || !state.selectedId) return;
  $("attach-error").hidden = true;
  $("btn-attach").disabled = true;
  try {
    attachment = await prepareImage(file);
    $("attach-img").src = attachment.data;
    $("attach-preview").hidden = false;
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

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("msg-input");
  const text = input.value.trim();
  const image = attachment;
  if ((!text && !image) || !state.selectedId) return;

  const convId = state.selectedId;
  const submit = $("composer").querySelector("[type=submit]");
  submit.disabled = true;
  input.value = "";
  try {
    const msgRef = doc(collection(db, "conversations", convId, "messages"));
    const batch = writeBatch(db);
    batch.set(msgRef, {
      text,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email,
      createdAt: serverTimestamp(),
      ...(image ? { image: { w: image.w, h: image.h } } : {}),
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
    await batch.commit();
    if (image && attachment === image) clearAttachment();
  } catch (err) {
    console.error(err);
    input.value = text;
    alert("Envoi impossible : " + err.message);
  } finally {
    submit.disabled = false;
  }
});

$("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

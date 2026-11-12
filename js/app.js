import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
  orderBy, limitToLast, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isConfigured, ADMIN_UID, GMAIL_RE } from "./firebase.js";

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  isAdmin: false,
  conversations: new Map(), // id -> data
  selectedId: null,
  unsubConvs: null,
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
  onAuthStateChanged(auth, onAuth);
}

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

async function onAuth(user) {
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
    const { setupAdmin } = await import("./admin.js");
    state.admin = setupAdmin({
      getConversations: () => state.conversations,
      getSelected: () => (state.selectedId ? { id: state.selectedId, ...state.conversations.get(state.selectedId) } : null),
      selectConversation,
    });
  }
  listenConversations();
}

function teardown() {
  state.unsubConvs?.();
  state.unsubMessages?.();
  state.admin?.teardown();
  Object.assign(state, {
    user: null, isAdmin: false, conversations: new Map(), selectedId: null,
    unsubConvs: null, unsubMessages: null, admin: null,
  });
  $("conv-list").replaceChildren();
  $("messages").replaceChildren();
  $("chat-view").hidden = true;
  $("chat-empty").hidden = false;
}

async function upsertUser(user) {
  const ref = doc(db, "users", user.uid);
  const data = {
    email: user.email,
    displayName: user.displayName || user.email,
    photoURL: user.photoURL || "",
    lastLogin: serverTimestamp(),
  };
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) await updateDoc(ref, data);
    else await setDoc(ref, { ...data, createdAt: serverTimestamp() });
  } catch (err) {
    console.error("Enregistrement du profil impossible", err);
  }
}

function fillUserHeader(user) {
  $("user-photo").src = user.photoURL || "";
  $("user-photo").hidden = !user.photoURL;
  $("user-name").textContent = user.displayName || user.email;
  $("admin-badge").hidden = !state.isAdmin;
  $("btn-new-conv").hidden = !state.isAdmin;
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

function sortedConversations() {
  return [...state.conversations.entries()].sort((a, b) =>
    (b[1].createdAt?.toMillis?.() ?? 0) - (a[1].createdAt?.toMillis?.() ?? 0));
}

function renderConversationList() {
  const items = sortedConversations().map(([id, c]) => {
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
  });
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.style.padding = "0 1rem";
    li.textContent = state.isAdmin ? "Aucune conversation. Crée-en une." : "";
    items.push(li);
  }
  $("conv-list").replaceChildren(...items);
}

function selectConversation(id) {
  if (!state.conversations.has(id)) return;
  $("screen-app").classList.add("show-chat");
  if (state.selectedId === id) return;

  state.unsubMessages?.();
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
  state.selectedId = null;
  $("chat-view").hidden = true;
  $("chat-empty").hidden = false;
  $("screen-app").classList.remove("show-chat");
}

function renderChatHeader() {
  const c = state.conversations.get(state.selectedId);
  if (!c) return;
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

  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  if (m.authorPhoto) img.src = m.authorPhoto;

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
        await deleteDoc(doc(db, "conversations", state.selectedId, "messages", id));
      } catch (err) {
        console.error(err);
        alert("Suppression impossible : " + err.message);
      }
    });
    head.append(del);
  }

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = m.text;

  bubble.append(head, text);
  li.append(img, bubble);
  return li;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("msg-input");
  const text = input.value.trim();
  if (!text || !state.selectedId) return;

  input.value = "";
  try {
    await addDoc(collection(db, "conversations", state.selectedId, "messages"), {
      text,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email,
      authorPhoto: state.user.photoURL || "",
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    input.value = text;
    alert("Envoi impossible : " + err.message);
  }
});

$("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

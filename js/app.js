import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, collection, query, where, writeBatch,
  orderBy, limitToLast, onSnapshot, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, isConfigured, ADMIN_UID, GMAIL_RE } from "./firebase.js?v=2";
import { initAccount } from "./account.js?v=2";
import { avatarEl, initials } from "./ui.js?v=2";
import { prepareImage } from "./images.js?v=2";

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
    const { setupAdmin } = await import("./admin.js?v=2");
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
  resetImages();
  clearAttachment();
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

// Zone de saisie : photo jointe (bouton, collage, glisser-déposer), envoi, bandeau hors ligne.

import { collection, doc, serverTimestamp, writeBatch } from "./sdk/firebase-firestore.js";
import { toast } from "./dialogs.js";
import { db } from "./firebase.js";
import { prepareImage } from "./images.js";
import { bumpRate, rateReady, rateWait } from "./rate.js";
import { $ } from "./ui.js";
import { clearReply, images, startReply } from "./messages.js";
import { state } from "./state.js";

/* ---------- Photos : pièce jointe ---------- */

let attachment = null; // { data, w, h } prête à l'envoi

export function clearAttachment() {
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

// Glisser-déposer une photo sur la conversation (ordinateur).
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
let dragDepth = 0; // dragenter/dragleave se déclenchent aussi sur chaque élément survolé
$("chat-view").addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("chat-view").classList.add("dragging");
});
$("chat-view").addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
$("chat-view").addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("chat-view").classList.remove("dragging");
});
$("chat-view").addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("chat-view").classList.remove("dragging");
  const files = [...e.dataTransfer.files];
  const file = files.find((f) => f.type.startsWith("image/"));
  if (file) attachFile(file);
  else if (files.length) toast("Seules les photos peuvent être jointes.", { error: true });
});

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
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  await rateReady();
  const wait = rateWait();
  if (wait) {
    toast(`Tu as envoyé beaucoup de messages en une minute : réessaie dans ${wait} s.`, { error: true });
    return;
  }
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
    ...(image ? { image: { w: image.w, h: image.h, thumb: true } } : {}),
    ...(replyTo ? { replyTo } : {}),
  });
  if (image) {
    // La photo est rangée à part (même identifiant) pour ne pas alourdir la liste des messages.
    batch.set(doc(db, "conversations", convId, "images", msgRef.id), {
      data: image.data,
      authorUid: state.user.uid,
      createdAt: serverTimestamp(),
    });
    // Miniature affichée dans le fil (l'original n'est chargé qu'à l'agrandissement).
    batch.set(doc(db, "conversations", convId, "thumbs", msgRef.id), {
      data: image.thumb,
      authorUid: state.user.uid,
      createdAt: serverTimestamp(),
    });
    images.cache.set(msgRef.id, Promise.resolve(image.data));
    images.cache.set("t:" + msgRef.id, Promise.resolve(image.thumb));
  }
  // Date de la dernière activité, pour classer la conversation en tête de liste chez tous ses membres.
  batch.update(doc(db, "conversations", convId), { lastMessageAt: serverTimestamp() });
  bumpRate(batch); // limitation anti-abus, exigée par les règles
  input.value = "";
  if (image) clearAttachment();
  if (replyTo) clearReply();

  batch.commit().catch((err) => {
    console.error(err);
    images.cache.delete(msgRef.id);
    images.cache.delete("t:" + msgRef.id);
    if (state.selectedId === convId) {
      if (!input.value.trim()) input.value = text;
      if (image && !attachment) setAttachment(image);
      if (replyTo && !state.replyTo) startReply(replyTo);
    }
    toast("Envoi impossible : " + err.message, { error: true });
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

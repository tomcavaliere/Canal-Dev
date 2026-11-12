// Droits RGPD de l'utilisateur connecté : accès/portabilité (export JSON)
// et effacement (suppression du compte et de toutes ses données).
import {
  GoogleAuthProvider, reauthenticateWithPopup, deleteUser,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, collectionGroup, doc, getDoc, getDocs, deleteDoc, updateDoc, writeBatch,
  query, where, limit, arrayRemove, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, ADMIN_UID } from "./firebase.js?v=8";

const $ = (id) => document.getElementById(id);

/* ---------- Suppression des données d'un utilisateur ---------- */

// Supprime tous les messages de `uid`, le retire de toutes les conversations,
// supprime son nom de l'annuaire et son profil. Utilisé par l'utilisateur lui-même et par l'admin.
// Le compte Firebase Authentication est traité séparément.
export async function purgeUserData(uid) {
  // Photos, messages puis accusés de lecture. Les photos sont lues par petits lots (jusqu'à ~900 Ko chacune).
  for (const [group, field, size] of [["images", "authorUid", 10], ["messages", "authorUid", 400], ["reads", "uid", 400]]) {
    const q = query(collectionGroup(db, group), where(field, "==", uid), limit(size));
    for (;;) {
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  const convs = await getDocs(query(collection(db, "conversations"), where("members", "array-contains", uid)));
  for (const c of convs.docs) {
    await updateDoc(c.ref, { members: arrayRemove(uid) });
  }

  await deleteDoc(doc(db, "names", uid));
  await deleteDoc(doc(db, "users", uid));
}

/* ---------- Export des données ---------- */

function plain(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

async function collectMyData(user) {
  const [profile, name, convs, msgs, imgs, reads] = await Promise.all([
    getDoc(doc(db, "users", user.uid)),
    getDoc(doc(db, "names", user.uid)),
    getDocs(query(collection(db, "conversations"), where("members", "array-contains", user.uid))),
    getDocs(query(collectionGroup(db, "messages"), where("authorUid", "==", user.uid))),
    getDocs(query(collectionGroup(db, "images"), where("authorUid", "==", user.uid))),
    getDocs(query(collectionGroup(db, "reads"), where("uid", "==", user.uid))),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    service: "Canal Dev",
    privacyPolicy: new URL("confidentialite.html", location.href).href,
    // Compte Firebase Authentication. La photo Google y est enregistrée automatiquement :
    // Canal Dev ne la copie, ne l'utilise ni ne l'affiche jamais.
    account: {
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      photoURL: user.photoURL,
      providers: user.providerData.map((p) => ({
        providerId: p.providerId,
        uid: p.uid,
        email: p.email,
        displayName: p.displayName,
        photoURL: p.photoURL,
      })),
      createdAt: user.metadata.creationTime,
      lastSignInAt: user.metadata.lastSignInTime,
    },
    profile: profile.exists() ? plain(profile.data()) : null,
    // Nom affiché aux autres membres, fixé par l'administrateur (annuaire).
    displayedName: name.exists() ? plain(name.data()) : null,
    conversations: convs.docs.map((d) => ({
      id: d.id, title: d.data().title, description: d.data().description,
      projectId: d.data().projectId ?? null,
    })),
    messages: msgs.docs
      .map((d) => ({ conversationId: d.ref.parent.parent.id, id: d.id, ...plain(d.data()) }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    // Photos au format data URL JPEG (ouvrable dans un navigateur), liées au message par messageId.
    photos: imgs.docs.map((d) => ({
      conversationId: d.ref.parent.parent.id,
      messageId: d.id,
      createdAt: plain(d.data().createdAt),
      data: d.data().data,
    })),
    // Date de dernière lecture de chaque conversation, visible par ses autres membres.
    readReceipts: reads.docs.map((d) => ({
      conversationId: d.ref.parent.parent.id,
      lastRead: plain(d.data().lastRead),
    })),
  };
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Dialogue « Mon compte » ---------- */

function setStatus(msg, isError = false) {
  $("account-status").textContent = msg;
  $("account-status").classList.toggle("error", isError);
}

function openAccount() {
  const user = auth.currentUser;
  if (!user) return;
  $("account-email").textContent = user.email;
  $("account-name").textContent = "…";
  getDoc(doc(db, "names", user.uid))
    .then((snap) => { $("account-name").textContent = snap.exists() ? snap.data().name : "pas encore attribué"; })
    .catch(() => { $("account-name").textContent = "indisponible"; });
  $("account-delete").hidden = user.uid === ADMIN_UID;
  $("account-admin-note").hidden = user.uid !== ADMIN_UID;
  $("delete-confirm").value = "";
  setStatus("");
  $("dlg-account").showModal();
}

async function exportData() {
  const user = auth.currentUser;
  if (!user) return;
  const btn = $("btn-export");
  btn.disabled = true;
  setStatus("Préparation de l'export…");
  try {
    const data = await collectMyData(user);
    download(`canal-dev-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`, data);
    setStatus(`Export téléchargé (${data.messages.length} message(s), ${data.photos.length} photo(s)).`);
  } catch (err) {
    console.error(err);
    setStatus("Export impossible : " + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteAccount() {
  const user = auth.currentUser;
  if (!user || user.uid === ADMIN_UID) return;
  if ($("delete-confirm").value.trim().toUpperCase() !== "SUPPRIMER") {
    setStatus("Tape SUPPRIMER dans le champ pour confirmer.", true);
    return;
  }
  const btn = $("btn-delete-account");
  btn.disabled = true;
  try {
    // Firebase exige une connexion récente pour supprimer un compte.
    // Fait en premier pour que la fenêtre ne soit pas bloquée par le navigateur.
    setStatus("Confirme ton identité dans la fenêtre Google…");
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ login_hint: user.email });
    await reauthenticateWithPopup(user, provider);

    setStatus("Suppression de tes messages, photos et accès…");
    await purgeUserData(user.uid);
    await deleteUser(user);
    $("dlg-account").close();
    alert("Ton compte et toutes tes données ont été supprimés.");
  } catch (err) {
    console.error(err);
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
      setStatus("Suppression annulée.");
    } else if (err.code === "auth/user-mismatch") {
      setStatus("Il faut confirmer avec le même compte Google.", true);
    } else {
      setStatus("Suppression incomplète : " + err.message + " — réessaie ou contacte l'administrateur.", true);
    }
  } finally {
    btn.disabled = false;
  }
}

export function initAccount() {
  document.querySelectorAll(".btn-account").forEach((b) => b.addEventListener("click", openAccount));
  $("btn-export").addEventListener("click", exportData);
  $("btn-delete-account").addEventListener("click", deleteAccount);
}

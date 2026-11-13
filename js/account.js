// Droits RGPD de l'utilisateur connecté : accès/portabilité (export JSON)
// et effacement (suppression du compte et de toutes ses données).
import {
  GoogleAuthProvider, reauthenticateWithPopup, deleteUser,
} from "./sdk/firebase-auth.js";
import {
  collection, collectionGroup, deleteField, doc, getDoc, getDocs, deleteDoc, updateDoc, writeBatch,
  query, where, limit, arrayRemove, Timestamp,
} from "./sdk/firebase-firestore.js";
import { auth, db, ADMIN_UID } from "./firebase.js";
import { toast } from "./dialogs.js";
import { $ } from "./ui.js";
import { state } from "./state.js";
import { bumpRate, rateWait } from "./rate.js";
import { purgePresence, setPresenceHidden, stopPresence } from "./presence.js";
import { REACTIONS } from "./emoji.js";

// Messages de la conversation `convId` portant une réaction de `uid`.
function reactedQuery(convId, uid) {
  return query(collection(db, "conversations", convId, "messages"), where(`reactions.${uid}`, "in", REACTIONS));
}

/* ---------- Suppression des données d'un utilisateur ---------- */

// Supprime tous les messages de `uid`, le retire de toutes les conversations,
// supprime son nom de l'annuaire, son invitation éventuelle et son profil.
// Utilisé par l'utilisateur lui-même et par l'admin.
// Le compte Firebase Authentication est traité séparément.
/**
 * @param {string} uid
 * @param {string} [email] adresse du compte, pour supprimer aussi son invitation éventuelle
 */
export async function purgeUserData(uid, email) {
  // Photos, messages puis accusés de lecture. Les photos sont lues par petits lots (jusqu'à ~900 Ko chacune).
  /** @type {[string, string, number][]} */
  const groups = [["images", "authorUid", 10], ["thumbs", "authorUid", 100], ["messages", "authorUid", 400], ["reads", "uid", 400]];
  for (const [group, field, size] of groups) {
    const q = query(collectionGroup(db, group), where(field, "==", uid), limit(size));
    for (;;) {
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // Rôles tenus dans des projets (voir firestore.rules : la personne peut s'en retirer elle-même).
  const projects = await getDocs(query(collection(db, "projects"), where("roleUids", "array-contains", uid)));
  for (const p of projects.docs) {
    await updateDoc(p.ref, { [`roleMembers.${uid}`]: deleteField(), roleUids: arrayRemove(uid) });
  }

  const convs = await getDocs(query(collection(db, "conversations"), where("members", "array-contains", uid)));
  // Réactions laissées sur les messages des autres (tant qu'on est encore membre pour les retirer).
  for (const c of convs.docs) {
    const reacted = await getDocs(reactedQuery(c.id, uid));
    for (let i = 0; i < reacted.docs.length; i += 400) {
      const batch = writeBatch(db);
      reacted.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { [`reactions.${uid}`]: deleteField() }));
      await batch.commit();
    }
  }
  for (const c of convs.docs) {
    await updateDoc(c.ref, { members: arrayRemove(uid) });
  }

  if (email) await deleteDoc(doc(db, "invites", email.toLowerCase()));
  // Présence « en ligne » (Realtime Database) : sans conséquence si elle échoue (rien de durable).
  await purgePresence(uid).catch((err) => console.warn("Effacement de la présence impossible", err));
  // Compteur anti-abus : seul l'admin peut le supprimer (sinon, le supprimer le remettrait à
  // zéro) ; après une suppression par la personne elle-même, l'admin le retire à sa prochaine visite.
  if (auth.currentUser?.uid === ADMIN_UID) await deleteDoc(doc(db, "rate", uid));
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
  const [profile, name, invite, convs, msgs, imgs, thumbs, reads, projects] = await Promise.all([
    getDoc(doc(db, "users", user.uid)),
    getDoc(doc(db, "names", user.uid)),
    getDoc(doc(db, "invites", user.email.toLowerCase())),
    getDocs(query(collection(db, "conversations"), where("members", "array-contains", user.uid))),
    getDocs(query(collectionGroup(db, "messages"), where("authorUid", "==", user.uid))),
    getDocs(query(collectionGroup(db, "images"), where("authorUid", "==", user.uid))),
    getDocs(query(collectionGroup(db, "thumbs"), where("authorUid", "==", user.uid))),
    getDocs(query(collectionGroup(db, "reads"), where("uid", "==", user.uid))),
    getDocs(query(collection(db, "projects"), where("roleUids", "array-contains", user.uid))),
  ]);
  const reacted = await Promise.all(convs.docs.map((c) => getDocs(reactedQuery(c.id, user.uid))));
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
    // Invitation pas encore utilisée (elle est supprimée dès qu'elle a servi).
    invitation: invite.exists() ? plain(invite.data()) : null,
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
      // Miniature affichée dans le fil (même photo, réduite), si elle existe.
      thumbnail: thumbs.docs.find((t) => t.ref.parent.parent.id === d.ref.parent.parent.id && t.id === d.id)?.data().data ?? null,
    })),
    // Réactions (emoji) mises sur des messages des conversations dont on est membre.
    reactions: reacted.flatMap((snap) => snap.docs.map((d) => ({
      conversationId: d.ref.parent.parent.id,
      messageId: d.id,
      emoji: d.data().reactions[user.uid],
    }))),
    // Date de dernière lecture de chaque conversation, visible par ses autres membres.
    readReceipts: reads.docs.map((d) => ({
      conversationId: d.ref.parent.parent.id,
      lastRead: plain(d.data().lastRead),
    })),
    // Rôles tenus dans des projets, visibles par les membres de leurs conversations.
    projectRoles: projects.docs.map((d) => {
      const p = d.data();
      const ids = p.roleMembers?.[user.uid] ?? [];
      return {
        projectId: d.id,
        projectTitle: p.title,
        roles: (p.roles ?? []).filter((r) => ids.includes(r.id)).map((r) => r.name),
      };
    }),
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
  $("no-receipts").checked = state.noReceipts;
  $("no-presence").checked = state.noPresence;
  setStatus("");
  $("dlg-account").showModal();
}

// Réglage « Ne pas envoyer d'accusés de lecture » (profil), avec effacement des accusés existants.
async function toggleReceipts() {
  const user = auth.currentUser;
  const box = $("no-receipts");
  const on = box.checked;
  if (!user) return;
  if (rateWait()) {
    box.checked = !on;
    setStatus(`Trop de modifications en une minute : réessaie dans ${rateWait()} s.`, true);
    return;
  }
  box.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "users", user.uid), { noReceipts: on });
    bumpRate(batch);
    await batch.commit();
    state.noReceipts = on;
    if (on) {
      const reads = await getDocs(query(collectionGroup(db, "reads"), where("uid", "==", user.uid)));
      for (let i = 0; i < reads.docs.length; i += 400) {
        const del = writeBatch(db);
        reads.docs.slice(i, i + 400).forEach((d) => del.delete(d.ref));
        await del.commit();
      }
      setStatus(`Accusés de lecture désactivés (${reads.size} supprimé(s)).`);
    } else {
      setStatus("Accusés de lecture réactivés.");
    }
  } catch (err) {
    console.error(err);
    box.checked = !on;
    setStatus("Modification impossible : " + err.message, true);
  } finally {
    box.disabled = false;
  }
}

// Réglage « Masquer ma présence en ligne » (profil). Effet immédiat dans les onglets de ce navigateur ;
// les entrées des autres appareils sont effacées (ils appliquent le réglage à leur prochaine connexion).
async function togglePresence() {
  const user = auth.currentUser;
  const box = $("no-presence");
  const on = box.checked;
  if (!user) return;
  if (rateWait()) {
    box.checked = !on;
    setStatus(`Trop de modifications en une minute : réessaie dans ${rateWait()} s.`, true);
    return;
  }
  box.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "users", user.uid), { noPresence: on });
    bumpRate(batch);
    await batch.commit();
    state.noPresence = on;
    await setPresenceHidden(on);
    // Retire aussi les entrées des autres onglets/appareils encore ouverts.
    if (on) await purgePresence(user.uid);
    setStatus(on ? "Ta présence est masquée." : "Ta présence est de nouveau visible.");
  } catch (err) {
    console.error(err);
    box.checked = !on;
    setStatus("Modification impossible : " + err.message, true);
  } finally {
    box.disabled = false;
  }
}

// Préférences et dates de lecture gardées dans ce navigateur (clés « canal-dev.* »).
function clearLocalData() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("canal-dev.")) localStorage.removeItem(key);
  } catch { /* stockage indisponible */ }
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
    await stopPresence(); // sinon cet onglet réécrirait sa présence
    await purgeUserData(user.uid, user.email);
    await deleteUser(user);
    clearLocalData();
    $("dlg-account").close();
    toast("Ton compte et toutes tes données ont été supprimés.", { timeout: 15000 });
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
  $("no-receipts").addEventListener("change", toggleReceipts);
  $("no-presence").addEventListener("change", togglePresence);
}

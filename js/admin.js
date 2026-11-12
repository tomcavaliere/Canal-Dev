// Fonctions réservées à l'administrateur. Chargé uniquement si l'UID connecté
// correspond à ADMIN_UID — mais la vraie protection est dans firestore.rules.
import {
  collection, doc, addDoc, updateDoc, deleteDoc, getDocs, writeBatch, query, limit,
  onSnapshot, arrayUnion, arrayRemove, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ADMIN_UID } from "./firebase.js";
import { purgeUserData } from "./account.js";
import { avatarEl } from "./ui.js";

// Durée de conservation d'un compte sans connexion (voir confidentialite.html).
const INACTIVE_MS = 365 * 24 * 3600 * 1000;

const $ = (id) => document.getElementById(id);

export function setupAdmin({ getConversations, getSelected, selectConversation }) {
  let users = new Map(); // uid -> data
  const cleanups = [];

  const on = (el, type, fn) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  /* --- Utilisateurs inscrits --- */
  const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    users = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderUsers();
    if ($("dlg-members").open) renderMembers();
  }, (err) => console.error("Lecture des utilisateurs impossible", err));
  cleanups.push(unsubUsers);

  function accessCount(uid) {
    let n = 0;
    for (const c of getConversations().values()) if (c.members?.includes(uid)) n++;
    return n;
  }

  function sortedUsers() {
    return [...users.entries()]
      .filter(([uid]) => uid !== ADMIN_UID)
      .sort((a, b) => (a[1].email || "").localeCompare(b[1].email || ""));
  }

  function userRow([uid, u], extra) {
    const wrap = document.createElement("div");
    wrap.className = "user-row";
    const avatar = avatarEl(u.displayName || u.email);
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("span");
    name.textContent = u.displayName || u.email;
    const email = document.createElement("span");
    email.className = "muted small";
    email.textContent = u.email;
    info.append(name, email);
    wrap.append(avatar, info);
    if (extra) wrap.append(...[].concat(extra));
    return wrap;
  }

  function renderUsers() {
    const list = sortedUsers();
    const items = list.map((entry) => {
      const li = document.createElement("li");
      let tag = null;
      const n = accessCount(entry[0]);
      if (n === 0) {
        tag = document.createElement("span");
        tag.className = "tag-pending";
        tag.textContent = "en attente";
      } else {
        tag = document.createElement("span");
        tag.className = "muted small";
        tag.textContent = String(n);
        tag.title = `${n} conversation(s)`;
      }
      const extras = [tag];
      const last = entry[1].lastLogin?.toMillis?.();
      if (last && Date.now() - last > INACTIVE_MS) {
        const old = document.createElement("span");
        old.className = "tag-pending";
        old.textContent = "inactif > 12 mois";
        old.title = "Durée de conservation dépassée : supprimer ce compte.";
        extras.unshift(old);
      }
      extras.push(deleteUserButton(entry));
      li.append(userRow(entry, extras));
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.style.padding = "0 1rem";
      li.textContent = "Personne d'autre ne s'est encore connecté.";
      items.push(li);
    }
    $("user-list").replaceChildren(...items);
  }

  /* --- Suppression d'un utilisateur (conservation / droit à l'effacement) --- */
  function deleteUserButton([uid, u]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "del-user";
    btn.textContent = "✕";
    btn.title = "Supprimer l'utilisateur et toutes ses données";
    btn.setAttribute("aria-label", `Supprimer ${u.email} et toutes ses données`);
    btn.addEventListener("click", async () => {
      if (!confirm(`Supprimer ${u.email} : profil, tous ses messages et ses accès ? Action irréversible.`)) return;
      btn.disabled = true;
      try {
        await purgeUserData(uid);
        alert(`Données de ${u.email} supprimées.\n\nÀ faire aussi : Firebase Console → Authentication → Users → supprimer le compte ${uid}.`);
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        alert("Suppression impossible : " + err.message);
      }
    });
    return btn;
  }

  /* --- Nouvelle conversation --- */
  const dlgNew = $("dlg-new-conv");
  on($("btn-new-conv"), "click", () => {
    $("form-new-conv").reset();
    dlgNew.showModal();
  });
  on($("form-new-conv"), "submit", async (e) => {
    e.preventDefault();
    const title = $("new-conv-title").value.trim();
    const description = $("new-conv-desc").value.trim();
    if (!title) return;
    try {
      const ref = await addDoc(collection(db, "conversations"), {
        title,
        description,
        members: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dlgNew.close();
      // la conversation arrive via onSnapshot ; on la sélectionne dès qu'elle est là
      setTimeout(() => selectConversation(ref.id), 0);
    } catch (err) {
      console.error(err);
      alert("Création impossible : " + err.message);
    }
  });

  /* --- Gestion des membres --- */
  const dlgMembers = $("dlg-members");
  on($("btn-members"), "click", () => {
    renderMembers();
    dlgMembers.showModal();
  });

  function renderMembers() {
    const conv = getSelected();
    if (!conv) { dlgMembers.close(); return; }
    $("members-conv-title").textContent = conv.title || "";
    const members = new Set(conv.members || []);
    const list = sortedUsers();

    const items = list.map(([uid, u]) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = members.has(uid);
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        try {
          await updateDoc(doc(db, "conversations", conv.id), {
            members: cb.checked ? arrayUnion(uid) : arrayRemove(uid),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          console.error(err);
          cb.checked = !cb.checked;
          alert("Modification impossible : " + err.message);
        } finally {
          cb.disabled = false;
        }
      });
      const text = document.createElement("span");
      text.textContent = `${u.displayName || u.email} — ${u.email}`;
      label.append(cb, text);
      li.append(label);
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.style.padding = ".75rem";
      li.textContent = "Aucun utilisateur inscrit. Les personnes doivent d'abord se connecter une fois.";
      items.push(li);
    }
    $("members-list").replaceChildren(...items);
  }

  /* --- Suppression d'une conversation --- */
  on($("btn-delete-conv"), "click", async () => {
    const conv = getSelected();
    if (!conv) return;
    if (!confirm(`Supprimer définitivement « ${conv.title} », tous ses messages et toutes ses photos ?`)) return;
    try {
      // Photos d'abord, lues par petits lots (jusqu'à ~900 Ko chacune), puis les messages.
      for (const [sub, size] of [["images", 10], ["messages", 400]]) {
        const ref = collection(db, "conversations", conv.id, sub);
        for (;;) {
          const snap = await getDocs(query(ref, limit(size)));
          if (snap.empty) break;
          const batch = writeBatch(db);
          snap.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
      await deleteDoc(doc(db, "conversations", conv.id));
    } catch (err) {
      console.error(err);
      alert("Suppression impossible : " + err.message);
    }
  });

  return {
    onConversationsChanged() {
      renderUsers();
      if (dlgMembers.open) renderMembers();
    },
    teardown() {
      cleanups.forEach((fn) => fn());
      if (dlgNew.open) dlgNew.close();
      if (dlgMembers.open) dlgMembers.close();
      $("user-list").replaceChildren();
    },
  };
}

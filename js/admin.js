// Fonctions réservées à l'administrateur. Chargé uniquement si l'UID connecté
// correspond à ADMIN_UID — mais la vraie protection est dans firestore.rules.
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs, writeBatch, query, where, limit,
  onSnapshot, arrayUnion, arrayRemove, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, ADMIN_UID } from "./firebase.js?v=8";
import { purgeUserData } from "./account.js?v=8";
import { avatarEl } from "./ui.js?v=8";
import { nameOf, namesLoaded, isNameTaken } from "./names.js?v=8";

// Durée de conservation d'un compte sans connexion (voir confidentialite.html).
const INACTIVE_MS = 365 * 24 * 3600 * 1000;

const $ = (id) => document.getElementById(id);

export function setupAdmin({ getConversations, getProjects, getSelected, selectConversation }) {
  let users = new Map(); // uid -> data
  const cleanups = [];

  const on = (el, type, fn) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  /* --- Utilisateurs inscrits --- */
  let usersLoaded = false;
  const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    users = new Map(snap.docs.map((d) => [d.id, d.data()]));
    usersLoaded = true;
    renderUsers();
    if ($("dlg-members").open) renderMembers();
    ensureNames();
  }, (err) => console.error("Lecture des utilisateurs impossible", err));
  cleanups.push(unsubUsers);

  /* --- Annuaire des noms (names/{uid}) --- */
  // Chaque membre (et l'admin) doit y figurer, sinon ses messages sont marqués « non vérifié ».
  // L'entrée est créée une seule fois à partir du nom Google ; ensuite seul l'admin la modifie,
  // car la personne peut changer elle-même son nom Google (et donc celui de son profil).
  const naming = new Set(); // UID en cours d'écriture, ou en échec (pas de nouvel essai)

  // Nom par défaut : le nom Google, sans jamais exposer l'adresse email aux membres.
  function googleName(u) {
    const n = (u?.displayName || "").trim();
    return n && !n.includes("@") ? n.slice(0, 190) : "";
  }

  // Deux personnes ne doivent pas apparaître sous le même nom : « Nom (2) », « Nom (3) »…
  function uniqueName(base, uid, reserved = new Set()) {
    const taken = (n) => isNameTaken(n, uid) || reserved.has(n.toLocaleLowerCase("fr"));
    let name = base;
    for (let i = 2; taken(name); i++) name = `${base} (${i})`;
    return name;
  }

  function nameEntry(name) {
    return { name, updatedAt: serverTimestamp() };
  }

  function ensureNames() {
    if (!usersLoaded || !namesLoaded()) return;
    const needed = new Set([ADMIN_UID]);
    for (const c of getConversations().values()) for (const uid of c.members || []) needed.add(uid);
    const reserved = new Set(); // noms attribués dans ce passage, pas encore revenus de l'annuaire
    for (const uid of needed) {
      if (nameOf(uid) != null || naming.has(uid) || !users.has(uid)) continue;
      const name = uniqueName(googleName(users.get(uid)) || "Membre sans nom", uid, reserved);
      reserved.add(name.toLocaleLowerCase("fr"));
      naming.add(uid);
      setDoc(doc(db, "names", uid), nameEntry(name))
        .then(() => naming.delete(uid))
        .catch((err) => console.error("Ajout à l'annuaire impossible", uid, err));
    }
  }

  /* --- Nom affiché d'un utilisateur (rectification) --- */
  const dlgUser = $("dlg-user");
  let editingUid = null;

  function openUserDialog(uid) {
    const u = users.get(uid);
    if (!u) return;
    editingUid = uid;
    $("user-dlg-email").textContent = u.email;
    $("user-dlg-google").textContent = googleName(u) || "—";
    $("btn-user-google").disabled = !googleName(u);
    $("user-dlg-name").value = nameOf(uid) || googleName(u);
    $("user-dlg-error").hidden = true;
    dlgUser.showModal();
  }
  on($("btn-user-google"), "click", () => {
    $("user-dlg-name").value = googleName(users.get(editingUid));
  });
  on($("form-user"), "submit", async (e) => {
    e.preventDefault();
    const name = $("user-dlg-name").value.trim();
    if (!name || !editingUid) return;
    if (isNameTaken(name, editingUid)) {
      $("user-dlg-error").textContent = "Ce nom est déjà celui d'une autre personne.";
      $("user-dlg-error").hidden = false;
      return;
    }
    try {
      await setDoc(doc(db, "names", editingUid), nameEntry(name));
      dlgUser.close();
    } catch (err) {
      console.error(err);
      alert("Enregistrement impossible : " + err.message);
    }
  });

  function displayedName(uid, u) {
    return nameOf(uid) || u.displayName || u.email;
  }

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
    const avatar = avatarEl(displayedName(uid, u));
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("span");
    name.textContent = displayedName(uid, u);
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
      extras.push(editUserButton(entry), deleteUserButton(entry));
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

  function editUserButton([uid, u]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-user";
    btn.textContent = "✎";
    btn.title = "Modifier le nom affiché aux membres";
    btn.setAttribute("aria-label", `Modifier le nom affiché de ${u.email}`);
    btn.addEventListener("click", () => openUserDialog(uid));
    return btn;
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

  /* --- Choix du projet (listes déroulantes) --- */
  function fillProjectSelect(select, selectedId) {
    const none = new Option("Aucun projet", "");
    const opts = [...getProjects().entries()]
      .sort((a, b) => (a[1].title || "").localeCompare(b[1].title || "", "fr"))
      .map(([id, p]) => new Option(p.title || "(sans titre)", id));
    select.replaceChildren(none, ...opts);
    select.value = selectedId && getProjects().has(selectedId) ? selectedId : "";
  }

  /* --- Nouvelle conversation / renommer une conversation --- */
  // Même dialogue : editingConvId est null pour une création.
  const dlgNew = $("dlg-new-conv");
  let editingConvId = null;

  function openConversationDialog(conv = null, projectId = "") {
    editingConvId = conv?.id ?? null;
    $("form-new-conv").reset();
    $("conv-dlg-title").textContent = conv ? "Renommer la conversation" : "Nouvelle conversation";
    $("conv-dlg-submit").textContent = conv ? "Enregistrer" : "Créer";
    $("new-conv-title").value = conv?.title || "";
    $("new-conv-desc").value = conv?.description || "";
    // Le changement de projet d'une conversation existante passe par « Déplacer ».
    $("new-conv-project-label").hidden = !!conv;
    fillProjectSelect($("new-conv-project"), projectId);
    dlgNew.showModal();
  }
  const newConversation = (projectId = "") => openConversationDialog(null, projectId);
  on($("btn-new-conv"), "click", () => newConversation());
  on($("btn-edit-conv"), "click", () => {
    const conv = getSelected();
    if (conv) openConversationDialog(conv);
  });
  on($("form-new-conv"), "submit", async (e) => {
    e.preventDefault();
    const title = $("new-conv-title").value.trim();
    const description = $("new-conv-desc").value.trim();
    const projectId = $("new-conv-project").value;
    if (!title) return;
    if (editingConvId) {
      try {
        await updateDoc(doc(db, "conversations", editingConvId), { title, description, updatedAt: serverTimestamp() });
        dlgNew.close();
      } catch (err) {
        console.error(err);
        alert("Modification impossible : " + err.message);
      }
      return;
    }
    try {
      const ref = await addDoc(collection(db, "conversations"), {
        title,
        description,
        members: [],
        ...(projectId ? { projectId } : {}),
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

  /* --- Projets : création, modification, suppression --- */
  const dlgProject = $("dlg-project");
  let editingProjectId = null;

  function openProjectDialog(projectId = null) {
    const p = projectId ? getProjects().get(projectId) : null;
    if (projectId && !p) return;
    editingProjectId = projectId;
    $("form-project").reset();
    $("project-dlg-title").textContent = p ? "Renommer le projet" : "Nouveau projet";
    $("project-title").value = p?.title || "";
    $("project-desc").value = p?.description || "";
    $("btn-delete-project").hidden = !p;
    dlgProject.showModal();
  }
  on($("btn-new-project"), "click", () => openProjectDialog());

  on($("form-project"), "submit", async (e) => {
    e.preventDefault();
    const title = $("project-title").value.trim();
    const description = $("project-desc").value.trim();
    if (!title) return;
    try {
      if (editingProjectId) {
        await updateDoc(doc(db, "projects", editingProjectId), { title, description, updatedAt: serverTimestamp() });
      } else {
        await addDoc(collection(db, "projects"), {
          title, description, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
      }
      dlgProject.close();
    } catch (err) {
      console.error(err);
      alert("Enregistrement impossible : " + err.message);
    }
  });

  // Supprimer un projet ne supprime pas ses conversations : elles passent « Sans projet ».
  on($("btn-delete-project"), "click", async () => {
    const id = editingProjectId;
    const p = id && getProjects().get(id);
    if (!p) return;
    if (!confirm(`Supprimer le projet « ${p.title} » ? Ses conversations sont conservées et passent dans « Sans projet ».`)) return;
    try {
      const convs = await getDocs(query(collection(db, "conversations"), where("projectId", "==", id)));
      for (let i = 0; i < convs.docs.length; i += 400) {
        const batch = writeBatch(db);
        convs.docs.slice(i, i + 400).forEach((d) =>
          batch.update(d.ref, { projectId: deleteField(), updatedAt: serverTimestamp() }));
        await batch.commit();
      }
      await deleteDoc(doc(db, "projects", id));
      dlgProject.close();
    } catch (err) {
      console.error(err);
      alert("Suppression impossible : " + err.message);
    }
  });

  /* --- Déplacer une conversation --- */
  const dlgMove = $("dlg-move");
  on($("btn-move-conv"), "click", () => {
    const conv = getSelected();
    if (!conv) return;
    $("move-conv-title").textContent = conv.title || "";
    fillProjectSelect($("move-project"), conv.projectId);
    dlgMove.showModal();
  });
  on($("form-move"), "submit", async (e) => {
    e.preventDefault();
    const conv = getSelected();
    if (!conv) { dlgMove.close(); return; }
    const projectId = $("move-project").value;
    try {
      if (projectId !== (conv.projectId || "")) {
        await updateDoc(doc(db, "conversations", conv.id), {
          projectId: projectId || deleteField(),
          updatedAt: serverTimestamp(),
        });
      }
      dlgMove.close();
    } catch (err) {
      console.error(err);
      alert("Déplacement impossible : " + err.message);
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
        // Nouveau membre absent de l'annuaire : son entrée est créée dans le même batch,
        // pour que ses messages ne soient jamais marqués « non vérifié ».
        const addName = cb.checked && namesLoaded() && nameOf(uid) == null && !naming.has(uid);
        if (addName) naming.add(uid);
        try {
          const batch = writeBatch(db);
          batch.update(doc(db, "conversations", conv.id), {
            members: cb.checked ? arrayUnion(uid) : arrayRemove(uid),
            updatedAt: serverTimestamp(),
          });
          if (addName) {
            batch.set(doc(db, "names", uid), nameEntry(uniqueName(googleName(u) || "Membre sans nom", uid)));
          }
          await batch.commit();
        } catch (err) {
          console.error(err);
          cb.checked = !cb.checked;
          alert("Modification impossible : " + err.message);
        } finally {
          if (addName) naming.delete(uid);
          cb.disabled = false;
        }
      });
      const text = document.createElement("span");
      text.textContent = `${displayedName(uid, u)} — ${u.email}`;
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
      // Photos d'abord, lues par petits lots (jusqu'à ~900 Ko chacune), puis les messages
      // et les accusés de lecture.
      for (const [sub, size] of [["images", 10], ["messages", 400], ["reads", 400]]) {
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
    newConversation,
    editProject: openProjectDialog,
    onProjectsChanged() {
      // Un projet supprimé pendant qu'on l'édite : on ferme le dialogue.
      if (dlgProject.open && editingProjectId && !getProjects().has(editingProjectId)) dlgProject.close();
    },
    onConversationsChanged() {
      // Conversation supprimée pendant qu'on la renomme : on ferme le dialogue.
      if (dlgNew.open && editingConvId && !getConversations().has(editingConvId)) dlgNew.close();
      renderUsers();
      if (dlgMembers.open) renderMembers();
      ensureNames(); // nouveau membre : entrée dans l'annuaire
    },
    onNamesChanged() {
      renderUsers();
      if (dlgMembers.open) renderMembers();
      ensureNames();
    },
    teardown() {
      cleanups.forEach((fn) => fn());
      if (dlgNew.open) dlgNew.close();
      if (dlgMembers.open) dlgMembers.close();
      if (dlgProject.open) dlgProject.close();
      if (dlgMove.open) dlgMove.close();
      if (dlgUser.open) dlgUser.close();
      $("user-list").replaceChildren();
    },
  };
}

// Fonctions réservées à l'administrateur. Chargé uniquement si l'UID connecté
// correspond à ADMIN_UID — mais la vraie protection est dans firestore.rules.
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs, writeBatch, query, where, limit,
  onSnapshot, arrayUnion, arrayRemove, serverTimestamp, deleteField,
} from "./sdk/firebase-firestore.js";
import { db, ADMIN_UID } from "./firebase.js";
import { purgeUserData } from "./account.js";
import { $, avatarEl } from "./ui.js";
import { nameOf, namesLoaded, isNameTaken } from "./names.js";
import { confirmDialog, toast } from "./dialogs.js";
import { playMessageSound } from "./sound.js";
import { showNotification } from "./notify.js";
import { isOnline } from "./presence.js";
import { addMemberEvent } from "./messages.js";
import { projectOrgLevels, projectRoles, roleUids } from "./sidebar.js";
import { isLogo, prepareLogo } from "./images.js";
import { deleteProjectCalendar } from "./tickets.js";

// Durée de conservation d'un compte sans connexion (voir confidentialite.html).
const INACTIVE_MS = 365 * 24 * 3600 * 1000;
// Durée de conservation d'une invitation jamais utilisée.
const INVITE_MS = 90 * 24 * 3600 * 1000;
const INVITE_EMAIL_RE = /^[a-z0-9._+-]+@gmail\.com$/;
const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

export function setupAdmin({ getConversations, getProjects, getSelected, selectConversation, onUsersChanged }) {
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
    // Alerte quand quelqu'un se connecte pour la première fois (pas au chargement).
    if (usersLoaded) {
      for (const ch of snap.docChanges()) {
        if (ch.type !== "added" || ch.doc.id === ADMIN_UID) continue;
        const u = ch.doc.data();
        playMessageSound();
        showNotification({
          title: "Nouvel utilisateur",
          body: `${u.displayName || u.email} s'est connecté pour la première fois.`,
          tag: "new-user",
        });
      }
    }
    if (!usersLoaded) cleanOrphanRates();
    usersLoaded = true;
    onUsersChanged(); // présence suivie pour tous les inscrits
    renderUsers();
    if ($("dlg-members").open) renderMembers();
    if ($("dlg-project").open) renderRoleEditors();
    ensureNames();
  }, (err) => console.error("Lecture des utilisateurs impossible", err));
  cleanups.push(unsubUsers);

  /* --- Compteurs anti-abus orphelins --- */
  // Une personne qui supprime elle-même son compte ne peut pas supprimer son compteur rate/{uid}
  // (les règles le réservent à l'admin) : il est retiré ici, à la première ouverture qui suit.
  async function cleanOrphanRates() {
    try {
      const snap = await getDocs(collection(db, "rate"));
      for (const d of snap.docs) {
        if (d.id !== ADMIN_UID && !users.has(d.id)) await deleteDoc(d.ref);
      }
    } catch (err) {
      console.error("Nettoyage des compteurs impossible", err);
    }
  }

  /* --- Invitations (invites/{email}) --- */
  let invites = new Map(); // email -> data
  const unsubInvites = onSnapshot(collection(db, "invites"), (snap) => {
    invites = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderUsers();
    if ($("dlg-members").open) renderInvites();
  }, (err) => console.error("Lecture des invitations impossible", err));
  cleanups.push(unsubInvites);

  // Nom déjà pris par une autre personne : inscrite (annuaire) ou invitée.
  function nameInUse(name, { uid = "", email = "" } = {}) {
    const key = name.trim().toLocaleLowerCase("fr");
    return isNameTaken(name, uid)
      || [...invites.values()].some((i) => i.email !== email && i.name.trim().toLocaleLowerCase("fr") === key);
  }

  function showInviteError(msg) {
    $("invite-error").textContent = msg;
    $("invite-error").hidden = !msg;
  }

  // Motif de refus d'une invitation, ou "" si elle est valable.
  function inviteProblem(email, name) {
    if (!INVITE_EMAIL_RE.test(email)) return "Il faut une adresse Gmail (…@gmail.com).";
    if ([...users.values()].some((u) => (u.email || "").toLowerCase() === email)) {
      return "Cette personne s'est déjà connectée : donne-lui accès avec « Membres » dans la conversation.";
    }
    if (!name) return "Indique le nom affiché aux membres.";
    if (nameInUse(name, { email })) return "Ce nom est déjà celui d'une autre personne.";
    return "";
  }

  // Crée l'invitation, ou remplace le nom et les conversations d'une invitation existante.
  function saveInvite(email, name, convIds) {
    const ref = doc(db, "invites", email);
    if (invites.has(email)) return updateDoc(ref, { name, convIds, updatedAt: serverTimestamp() });
    return setDoc(ref, { email, name, convIds, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }

  on($("form-invite"), "submit", async (e) => {
    e.preventDefault();
    const conv = getSelected();
    if (!conv) return;
    const email = $("invite-email").value.trim().toLowerCase();
    const name = $("invite-name").value.trim();
    const problem = inviteProblem(email, name);
    if (problem) return showInviteError(problem);
    const convIds = [...new Set([...(invites.get(email)?.convIds || []), conv.id])];
    if (convIds.length > 50) return showInviteError("Cette invitation compte déjà 50 conversations.");
    showInviteError("");
    try {
      await saveInvite(email, name, convIds);
      $("invite-email").value = "";
      $("invite-name").value = "";
      toast(`Invitation enregistrée : préviens ${name} de se connecter avec ${email}.`);
    } catch (err) {
      console.error(err);
      showInviteError("Invitation impossible : " + err.message);
    }
  });

  /* --- Inviter depuis « Utilisateurs » (sans ouvrir de conversation) --- */
  const dlgInvite = $("dlg-invite");

  function showInvError(msg) {
    $("inv-error").textContent = msg;
    $("inv-error").hidden = !msg;
  }

  // Conversations à cocher, rangées par projet puis par titre.
  function renderInviteConvs(checked) {
    const projects = getProjects();
    const label = (c) => {
      const p = c.projectId && projects.get(c.projectId);
      return p ? `${p.title || "(sans titre)"} · ${c.title || ""}` : c.title || "";
    };
    const convs = [...getConversations().values()]
      .sort((a, b) => label(a).localeCompare(label(b), "fr"));
    const items = convs.map((c) => {
      const li = document.createElement("li");
      const lab = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.id;
      cb.checked = checked.has(c.id);
      const text = document.createElement("span");
      text.textContent = label(c);
      const count = document.createElement("span");
      count.className = "muted small";
      count.textContent = `${c.members?.length || 0} membre(s)`;
      lab.append(cb, text, count);
      li.append(lab);
      return li;
    });
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.style.padding = ".75rem";
      li.textContent = "Crée d'abord une conversation.";
      items.push(li);
    }
    $("inv-convs").replaceChildren(...items);
  }

  // Une invitation existante est rouverte avec son nom et ses conversations, pour la modifier.
  function openInviteDialog(email = "") {
    const inv = email ? invites.get(email) : null;
    $("form-invite-user").reset();
    showInvError("");
    $("inv-email").value = email;
    $("inv-email").readOnly = !!inv;
    $("inv-name").value = inv?.name || "";
    $("inv-submit").textContent = inv ? "Enregistrer" : "Inviter";
    const sel = getSelected();
    renderInviteConvs(new Set(inv ? inv.convIds : sel ? [sel.id] : []));
    dlgInvite.showModal();
    (inv ? $("inv-name") : $("inv-email")).focus();
  }
  on($("btn-invite-user"), "click", () => openInviteDialog());

  // Adresse déjà invitée : on reprend son nom et ses conversations.
  on($("inv-email"), "change", () => {
    const inv = invites.get($("inv-email").value.trim().toLowerCase());
    if (!inv) return;
    $("inv-name").value = inv.name;
    renderInviteConvs(new Set(inv.convIds));
    $("inv-submit").textContent = "Enregistrer";
  });

  on($("form-invite-user"), "submit", async (e) => {
    e.preventDefault();
    const email = $("inv-email").value.trim().toLowerCase();
    const name = $("inv-name").value.trim();
    const problem = inviteProblem(email, name);
    if (problem) return showInvError(problem);
    const convIds = [...$("inv-convs").querySelectorAll("input:checked")].map((cb) => cb.value);
    if (!convIds.length) return showInvError("Coche au moins une conversation.");
    if (convIds.length > 50) return showInvError("50 conversations au plus par invitation.");
    showInvError("");
    const btn = $("inv-submit");
    btn.disabled = true;
    try {
      const existed = invites.has(email);
      await saveInvite(email, name, convIds);
      dlgInvite.close();
      toast(existed ? `Invitation de ${name} modifiée.`
        : `Invitation enregistrée : préviens ${name} avec ✉ dans « Utilisateurs ».`);
    } catch (err) {
      console.error(err);
      showInvError("Invitation impossible : " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Retire une conversation d'une invitation (supprimée si c'était la dernière).
  function uninvite(email, convId) {
    const inv = invites.get(email);
    const ref = doc(db, "invites", email);
    if (!inv || inv.convIds.every((id) => id === convId)) return deleteDoc(ref);
    return updateDoc(ref, { convIds: arrayRemove(convId), updatedAt: serverTimestamp() });
  }

  function renderInvites() {
    const conv = getSelected();
    if (!conv) return;
    const items = [...invites.values()]
      .filter((i) => i.convIds?.includes(conv.id))
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((i) => {
        const li = document.createElement("li");
        const text = document.createElement("span");
        const since = i.createdAt?.toDate?.();
        text.textContent = `${i.name} — ${i.email}` + (since ? ` (invitée le ${dateFmt.format(since)})` : "");
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn small";
        cancel.textContent = "Annuler";
        cancel.setAttribute("aria-label", `Annuler l'invitation de ${i.email}`);
        cancel.addEventListener("click", () => uninvite(i.email, conv.id).catch((err) => {
          console.error(err);
          toast("Annulation impossible : " + err.message, { error: true });
        }));
        li.append(tagEl("tag-invite", "invitation"), text, cancel);
        return li;
      });
    $("invite-list").replaceChildren(...items);
  }

  function tagEl(className, text, title = "") {
    const t = document.createElement("span");
    t.className = className;
    t.textContent = text;
    if (title) t.title = title;
    return t;
  }

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
    for (const uid of roleUids()) needed.add(uid); // personnes qui tiennent un rôle
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
      toast("Enregistrement impossible : " + err.message, { error: true });
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
    if (uid) name.append(presenceDot(isOnline(uid)));
    const email = document.createElement("span");
    email.className = "muted small";
    email.textContent = u.email;
    info.append(name, email);
    wrap.append(avatar, info);
    if (extra) wrap.append(...[].concat(extra));
    return wrap;
  }

  // Pastille de présence : pleine si en ligne, cerclée sinon (le texte caché est lu par les
  // lecteurs d'écran). « Hors ligne » couvre aussi les personnes qui masquent leur présence.
  function presenceDot(online) {
    const dot = document.createElement("span");
    dot.className = online ? "online-dot" : "online-dot offline";
    dot.title = online ? "En ligne" : "Hors ligne";
    const sr = document.createElement("span");
    sr.className = "visually-hidden";
    sr.textContent = online ? " (en ligne)" : " (hors ligne)";
    dot.append(sr);
    return dot;
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
      if (n > 0 && !isOnline(entry[0])) extras.push(alertMailButton(entry));
      extras.push(editUserButton(entry), deleteUserButton(entry));
      li.append(userRow(entry, extras));
      return li;
    });
    // Invitations en attente (personnes qui ne se sont pas encore connectées).
    for (const i of [...invites.values()].sort((a, b) => a.email.localeCompare(b.email))) {
      const li = document.createElement("li");
      const extras = [tagEl("tag-invite", "invitation", `${i.convIds.length} conversation(s)`)];
      const created = i.createdAt?.toMillis?.();
      if (created && Date.now() - created > INVITE_MS) {
        extras.unshift(tagEl("tag-pending", "> 3 mois", "Invitation jamais utilisée : l'annuler."));
      }
      extras.push(inviteMailButton(i), editInviteButton(i), cancelInviteButton(i));
      li.append(userRow(["", { displayName: i.name, email: i.email }], extras));
      items.push(li);
    }
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.style.padding = "0 1rem";
      li.textContent = "Personne d'autre ne s'est encore connecté.";
      items.push(li);
    }
    $("user-list").replaceChildren(...items);
    // Personnes connectées qui attendent un accès.
    const waiting = list.filter(([uid]) => accessCount(uid) === 0).length;
    $("users-pending").textContent = `${waiting} en attente`;
    $("users-pending").title = "Utilisateurs connectés sans accès à une conversation";
    $("users-pending").hidden = !waiting;
    // Comptes sans connexion depuis plus de 12 mois : suppression groupée.
    const inactive = inactiveUsers();
    $("btn-purge-inactive").textContent = `Supprimer ${inactive.length} compte${inactive.length > 1 ? "s" : ""} inactif${inactive.length > 1 ? "s" : ""} (> 12 mois)`;
    $("btn-purge-inactive").hidden = !inactive.length;
  }

  function inactiveUsers() {
    return sortedUsers().filter(([, u]) => {
      const last = u.lastLogin?.toMillis?.();
      return last && Date.now() - last > INACTIVE_MS;
    });
  }

  on($("btn-purge-inactive"), "click", async () => {
    const list = inactiveUsers();
    if (!list.length) return;
    const emails = list.map(([, u]) => u.email).join("\n");
    if (!await confirmDialog(`Supprimer ces ${list.length} compte(s) inactif(s), avec tous leurs messages, photos et accès ? Action irréversible.\n\n${emails}`,
      { ok: "Supprimer", danger: true })) return;
    const btn = $("btn-purge-inactive");
    btn.disabled = true;
    const done = [];
    try {
      for (const [uid, u] of list) {
        await purgeUserData(uid, u.email);
        done.push(uid);
      }
    } catch (err) {
      console.error(err);
      toast("Suppression interrompue : " + err.message, { error: true });
    } finally {
      btn.disabled = false;
    }
    if (done.length) {
      await confirmDialog(`${done.length} compte(s) supprimé(s).\n\nÀ faire aussi : Firebase Console → Authentication → Users → supprimer les comptes :\n${done.join("\n")}`,
        { ok: "Compris", cancel: false });
    }
  });

  function cancelInviteButton(i) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "del-user";
    btn.textContent = "✕";
    btn.title = "Annuler l'invitation";
    btn.setAttribute("aria-label", `Annuler l'invitation de ${i.email}`);
    btn.addEventListener("click", async () => {
      if (!await confirmDialog(`Annuler l'invitation de ${i.email} (${i.convIds.length} conversation(s)) ?`,
        { ok: "Annuler l'invitation", danger: true })) return;
      try {
        await deleteDoc(doc(db, "invites", i.email));
      } catch (err) {
        console.error(err);
        toast("Annulation impossible : " + err.message, { error: true });
      }
    });
    return btn;
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

  /* --- Alerte par email d'un inscrit hors ligne --- */
  // Sans serveur (plan Spark), le site ne peut pas envoyer d'email lui-même : le bouton ouvre
  // Gmail avec le message déjà rédigé, il ne reste qu'à cliquer sur « Envoyer ».
  function gmailButton(to, subject, body, title, ariaLabel) {
    const params = new URLSearchParams({ view: "cm", fs: "1", to, su: subject, body });
    const link = document.createElement("a");
    link.className = "edit-user";
    link.href = "https://mail.google.com/mail/?" + params;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "✉";
    link.title = title;
    link.setAttribute("aria-label", ariaLabel);
    return link;
  }

  const siteUrl = () => location.origin + location.pathname;

  function alertMailButton([uid, u]) {
    const name = displayedName(uid, u);
    return gmailButton(u.email, "Nouveaux messages sur Canal Dev",
      `Bonjour ${name},\n\nDe nouveaux messages t'attendent sur Canal Dev :\n${siteUrl()}\n\nÀ bientôt !`,
      "Prévenir par email (ouvre Gmail avec le message prêt)", `Prévenir ${u.email} par email`);
  }

  // Invitation : la personne doit se connecter avec exactement cette adresse Google.
  function inviteMailButton(i) {
    return gmailButton(i.email, "Invitation sur Canal Dev",
      `Bonjour ${i.name},\n\nJe t'ai ajouté(e) sur Canal Dev. Pour y accéder, connecte-toi avec ton compte Google ${i.email} :\n${siteUrl()}\n\nÀ bientôt !`,
      "Envoyer l'invitation par email (ouvre Gmail avec le message prêt)", `Envoyer l'invitation à ${i.email} par email`);
  }

  function editInviteButton(i) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edit-user";
    btn.textContent = "✎";
    btn.title = "Modifier le nom ou les conversations de l'invitation";
    btn.setAttribute("aria-label", `Modifier l'invitation de ${i.email}`);
    btn.addEventListener("click", () => openInviteDialog(i.email));
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
      if (!await confirmDialog(`Supprimer ${u.email} : profil, tous ses messages et ses accès ? Action irréversible.`,
        { ok: "Supprimer", danger: true })) return;
      btn.disabled = true;
      try {
        await purgeUserData(uid, u.email);
        await confirmDialog(`Données de ${u.email} supprimées.\n\nÀ faire aussi : Firebase Console → Authentication → Users → supprimer le compte ${uid}.`,
          { ok: "Compris", cancel: false });
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        toast("Suppression impossible : " + err.message, { error: true });
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
        toast("Modification impossible : " + err.message, { error: true });
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
      toast("Création impossible : " + err.message, { error: true });
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
    $("project-title").value = p?.title || "";
    $("project-desc").value = p?.description || "";
    draftLogo = isLogo(p?.logo) ? p.logo : null;
    renderLogo();
    $("btn-delete-project").hidden = !p;
    $("project-dlg-title").textContent = p ? "Modifier le projet" : "Nouveau projet";
    $("project-error").hidden = true;
    draftRoles = projectRoles(p).map((r) => ({ id: r.id, name: r.name, uids: new Set(r.uids) }));
    draftLevels = projectOrgLevels(p).map((l) => ({ id: l.id, name: l.name, roles: l.roles.map((r) => r.id) }));
    renderRoleEditors();
    dlgProject.showModal();
  }
  on($("btn-new-project"), "click", () => openProjectDialog());

  /* --- Logo d'un projet (petite image enregistrée dans le document du projet) --- */
  /** @type {string | null} */
  let draftLogo = null;

  function renderLogo() {
    const img = /** @type {HTMLImageElement} */ ($("project-logo-preview"));
    if (draftLogo) img.src = draftLogo; else img.removeAttribute("src");
    img.hidden = !draftLogo;
    $("project-logo-none").hidden = !!draftLogo;
    $("btn-remove-logo").hidden = !draftLogo;
  }

  on($("project-logo-file"), "change", async (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      draftLogo = await prepareLogo(file);
      renderLogo();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  on($("btn-remove-logo"), "click", () => {
    draftLogo = null;
    renderLogo();
  });

  /* --- Rôles d'un projet (édités dans le dialogue du projet) --- */
  const MAX_ROLES = 20;
  /** @type {{ id: string, name: string, uids: Set<string> }[]} */
  let draftRoles = [];

  function newRoleId() {
    return Math.random().toString(36).slice(2, 10);
  }

  // Personnes qu'on peut cocher : les inscrits, sous leur nom affiché (annuaire), sinon leur nom Google.
  function roleCandidates() {
    return [...users.entries()]
      .map(([uid, u]) => ({ uid, label: nameOf(uid) || googleName(u) || u.email || uid }))
      .sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }

  function focusRole(id) {
    /** @type {HTMLInputElement | null} */ ($("project-roles").querySelector(`input[data-role="${CSS.escape(id)}"]`))?.focus();
  }

  function renderRoleEditors() {
    // La liste est reconstruite (ajout, retrait, ordre, nouvel inscrit) : on garde le nom en cours de saisie.
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusedRole = active && $("project-roles").contains(active) ? active.dataset.role : null;
    const people = roleCandidates();
    const items = draftRoles.map((role, i) => {
      const li = document.createElement("li");
      li.className = "role-editor stack tight";
      const head = document.createElement("div");
      head.className = "row";
      const input = document.createElement("input");
      input.maxLength = 60;
      input.value = role.name;
      input.placeholder = "Nom du rôle (ex. Développeur)";
      input.setAttribute("aria-label", `Nom du rôle ${i + 1}`);
      input.dataset.role = role.id;
      input.addEventListener("input", () => { role.name = input.value; renderLevelEditors(); });
      // Entrée dans un nom de rôle : passe au rôle suivant (ou en crée un), sans enregistrer le projet.
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        if (i < draftRoles.length - 1) focusRole(draftRoles[i + 1].id);
        else addRole();
      });
      const up = document.createElement("button");
      up.type = "button";
      up.className = "btn small";
      up.textContent = "↑";
      up.title = "Monter ce rôle";
      up.setAttribute("aria-label", `Monter le rôle ${role.name || i + 1}`);
      up.disabled = i === 0;
      up.addEventListener("click", () => {
        [draftRoles[i - 1], draftRoles[i]] = [draftRoles[i], draftRoles[i - 1]];
        renderRoleEditors();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn small danger";
      del.textContent = "Retirer";
      del.setAttribute("aria-label", `Retirer le rôle ${role.name || i + 1}`);
      del.addEventListener("click", () => {
        draftRoles.splice(i, 1);
        renderRoleEditors();
      });
      head.append(input, up, del);

      const ul = document.createElement("ul");
      ul.className = "list members role-people-picker";
      for (const { uid, label } of people) {
        const pli = document.createElement("li");
        const lab = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = role.uids.has(uid);
        cb.addEventListener("change", () => { if (cb.checked) role.uids.add(uid); else role.uids.delete(uid); });
        lab.append(cb, document.createTextNode(label));
        pli.append(lab);
        ul.append(pli);
      }
      if (!people.length) ul.append(Object.assign(document.createElement("li"), { className: "muted small", textContent: "Aucun inscrit." }));
      li.append(head, ul);
      return li;
    });
    $("project-roles").replaceChildren(...items);
    $("btn-add-role").disabled = draftRoles.length >= MAX_ROLES;
    if (focusedRole) focusRole(focusedRole);
    renderLevelEditors(); // les rôles proposés dans l'organigramme suivent la liste
  }

  function addRole() {
    if (draftRoles.length >= MAX_ROLES) return;
    const role = { id: newRoleId(), name: "", uids: new Set() };
    draftRoles.push(role);
    renderRoleEditors();
    focusRole(role.id);
  }
  on($("btn-add-role"), "click", addRole);

  /* --- Organigramme d'un projet : les rôles rangés par niveau (même dialogue) --- */
  const MAX_LEVELS = 10;
  /** @type {{ id: string, name: string, roles: string[] }[]} */
  let draftLevels = [];

  function focusLevel(id) {
    /** @type {HTMLInputElement | null} */ ($("project-levels").querySelector(`input[data-level="${CSS.escape(id)}"]`))?.focus();
  }

  function renderLevelEditors() {
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusedLevel = active && $("project-levels").contains(active) ? active.dataset.level : null;
    const named = draftRoles.filter((r) => r.name.trim());
    const items = draftLevels.map((level, i) => {
      const li = document.createElement("li");
      li.className = "role-editor stack tight";
      const head = document.createElement("div");
      head.className = "row";
      const num = document.createElement("span");
      num.className = "level-num";
      num.textContent = String(i + 1);
      num.title = `Niveau ${i + 1}`;
      const input = document.createElement("input");
      input.maxLength = 60;
      input.value = level.name;
      input.placeholder = `Niveau ${i + 1} (ex. Direction)`;
      input.setAttribute("aria-label", `Nom du niveau ${i + 1}`);
      input.dataset.level = level.id;
      input.addEventListener("input", () => { level.name = input.value; });
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        if (i < draftLevels.length - 1) focusLevel(draftLevels[i + 1].id);
        else addLevel();
      });
      const up = document.createElement("button");
      up.type = "button";
      up.className = "btn small";
      up.textContent = "↑";
      up.title = "Monter ce niveau";
      up.setAttribute("aria-label", `Monter le niveau ${level.name || i + 1}`);
      up.disabled = i === 0;
      up.addEventListener("click", () => {
        [draftLevels[i - 1], draftLevels[i]] = [draftLevels[i], draftLevels[i - 1]];
        renderLevelEditors();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn small danger";
      del.textContent = "Retirer";
      del.setAttribute("aria-label", `Retirer le niveau ${level.name || i + 1}`);
      del.addEventListener("click", () => {
        draftLevels.splice(i, 1);
        renderLevelEditors();
      });
      head.append(num, input, up, del);

      // Un rôle n'est qu'à un seul niveau : le cocher ici le retire de l'autre.
      const ul = document.createElement("ul");
      ul.className = "list members role-people-picker";
      for (const role of named) {
        const pli = document.createElement("li");
        const lab = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = level.roles.includes(role.id);
        const other = draftLevels.findIndex((l) => l !== level && l.roles.includes(role.id));
        cb.addEventListener("change", () => {
          for (const l of draftLevels) l.roles = l.roles.filter((id) => id !== role.id);
          if (cb.checked) level.roles.push(role.id);
          renderLevelEditors();
        });
        lab.append(cb, document.createTextNode(role.name.trim()));
        if (other >= 0) {
          const where = document.createElement("span");
          where.className = "muted small";
          where.textContent = ` (niveau ${other + 1})`;
          lab.append(where);
        }
        pli.append(lab);
        ul.append(pli);
      }
      if (!named.length) ul.append(Object.assign(document.createElement("li"), { className: "muted small", textContent: "Aucun rôle : ajoute-en au-dessus." }));
      li.append(head, ul);
      return li;
    });
    $("project-levels").replaceChildren(...items);
    $("btn-add-level").disabled = draftLevels.length >= MAX_LEVELS;
    const unplaced = draftLevels.length
      ? named.filter((r) => !draftLevels.some((l) => l.roles.includes(r.id))).map((r) => r.name.trim())
      : [];
    $("project-levels-unplaced").textContent = `Hors organigramme : ${unplaced.join(", ")}.`;
    $("project-levels-unplaced").hidden = !unplaced.length;
    if (focusedLevel) focusLevel(focusedLevel);
  }

  function addLevel() {
    if (draftLevels.length >= MAX_LEVELS) return;
    const level = { id: newRoleId(), name: "", roles: [] };
    draftLevels.push(level);
    renderLevelEditors();
    focusLevel(level.id);
  }
  on($("btn-add-level"), "click", addLevel);

  // Champ Firestore de l'organigramme : seuls les rôles enregistrés (nommés) y restent.
  function levelsFields() {
    const kept = new Set(draftRoles.filter((r) => r.name.trim()).map((r) => r.id));
    return {
      orgLevels: draftLevels.map((l) => ({
        id: l.id, name: l.name.trim().slice(0, 60), roles: l.roles.filter((id) => kept.has(id)),
      })),
    };
  }

  // Champs Firestore des rôles (voir firestore.rules) : seuls les rôles nommés sont gardés,
  // et seules les personnes encore inscrites.
  function rolesFields() {
    const roles = draftRoles
      .map((r) => ({ id: r.id, name: r.name.trim().slice(0, 60), uids: r.uids }))
      .filter((r) => r.name);
    /** @type {Record<string, string[]>} */
    const roleMembers = {};
    for (const r of roles) {
      for (const uid of r.uids) if (users.has(uid)) (roleMembers[uid] ??= []).push(r.id);
    }
    return { roles: roles.map(({ id, name }) => ({ id, name })), roleMembers, roleUids: Object.keys(roleMembers) };
  }

  on($("form-project"), "submit", async (e) => {
    e.preventDefault();
    const title = $("project-title").value.trim();
    const description = $("project-desc").value.trim();
    if (!title) return;
    const names = draftRoles.map((r) => r.name.trim().toLocaleLowerCase("fr")).filter(Boolean);
    if (new Set(names).size !== names.length) {
      $("project-error").textContent = "Deux rôles portent le même nom.";
      $("project-error").hidden = false;
      return;
    }
    try {
      if (editingProjectId) {
        await updateDoc(doc(db, "projects", editingProjectId), {
          title, description, ...rolesFields(), ...levelsFields(), logo: draftLogo ?? deleteField(), updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "projects"), {
          title, description, ...rolesFields(), ...levelsFields(), ...(draftLogo ? { logo: draftLogo } : {}),
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
      }
      dlgProject.close();
      ensureNames(); // personnes qui tiennent un rôle : entrée dans l'annuaire
    } catch (err) {
      console.error(err);
      toast("Enregistrement impossible : " + err.message, { error: true });
    }
  });

  // Supprimer un projet ne supprime pas ses conversations : elles passent « Sans projet ».
  on($("btn-delete-project"), "click", async () => {
    const id = editingProjectId;
    const p = id && getProjects().get(id);
    if (!p) return;
    if (!await confirmDialog(`Supprimer le projet « ${p.title} » ? Ses conversations sont conservées et passent dans « Sans projet ». Son calendrier (réunions et objectifs) est supprimé.`,
      { ok: "Supprimer", danger: true })) return;
    try {
      const convs = await getDocs(query(collection(db, "conversations"), where("projectId", "==", id)));
      for (let i = 0; i < convs.docs.length; i += 400) {
        const batch = writeBatch(db);
        convs.docs.slice(i, i + 400).forEach((d) =>
          batch.update(d.ref, { projectId: deleteField(), updatedAt: serverTimestamp() }));
        await batch.commit();
      }
      await deleteProjectCalendar(id);
      await deleteDoc(doc(db, "projects", id));
      dlgProject.close();
    } catch (err) {
      console.error(err);
      toast("Suppression impossible : " + err.message, { error: true });
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
      toast("Déplacement impossible : " + err.message, { error: true });
    }
  });

  /* --- Gestion des membres --- */
  const dlgMembers = $("dlg-members");
  on($("btn-members"), "click", () => {
    $("form-invite").reset();
    showInviteError("");
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
          addMemberEvent(batch, conv.id, uid, cb.checked ? "join" : "leave");
          if (addName) {
            batch.set(doc(db, "names", uid), nameEntry(uniqueName(googleName(u) || "Membre sans nom", uid)));
          }
          await batch.commit();
        } catch (err) {
          console.error(err);
          cb.checked = !cb.checked;
          toast("Modification impossible : " + err.message, { error: true });
        } finally {
          if (addName) naming.delete(uid);
          cb.disabled = false;
        }
      });
      const text = document.createElement("span");
      text.textContent = `${displayedName(uid, u)} — ${u.email}`;
      if (isOnline(uid)) text.append(presenceDot(true));
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
    renderInvites();
  }

  /* --- Suppression d'une conversation --- */
  on($("btn-delete-conv"), "click", async () => {
    const conv = getSelected();
    if (!conv) return;
    if (!await confirmDialog(`Supprimer définitivement « ${conv.title} », tous ses messages et toutes ses photos ?`,
      { ok: "Supprimer", danger: true })) return;
    try {
      // Photos d'abord, lues par petits lots (jusqu'à ~900 Ko chacune), puis les messages
      // et les accusés de lecture.
      /** @type {[string, number][]} */
      const subs = [["images", 10], ["thumbs", 100], ["messages", 400], ["reads", 400]];
      for (const [sub, size] of subs) {
        const ref = collection(db, "conversations", conv.id, sub);
        for (;;) {
          const snap = await getDocs(query(ref, limit(size)));
          if (snap.empty) break;
          const batch = writeBatch(db);
          snap.docs.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
      // Les invitations ne doivent plus y mener.
      for (const i of [...invites.values()].filter((inv) => inv.convIds?.includes(conv.id))) {
        await uninvite(i.email, conv.id);
      }
      await deleteDoc(doc(db, "conversations", conv.id));
    } catch (err) {
      console.error(err);
      toast("Suppression impossible : " + err.message, { error: true });
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
    // Inscrits dont l'admin suit la présence (liste « Utilisateurs »).
    userIds() {
      return users.keys();
    },
    onPresenceChanged() {
      renderUsers();
      if (dlgMembers.open) renderMembers();
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
      if (dlgInvite.open) dlgInvite.close();
      $("user-list").replaceChildren();
    },
  };
}

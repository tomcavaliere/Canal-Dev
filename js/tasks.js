// Tâches d'un projet (projects/{p}/tasks) : une todo list partagée par tous les membres du projet
// (voir tickets.js et firestore.rules).
//   - Tout membre ajoute une tâche et coche celles qui sont faites (qui + quand sont gardés).
//   - Une tâche cochée ne disparaît jamais : elle passe dans « Terminées », la plus récente en premier,
//     ce qui forme l'historique du projet. On peut la rouvrir, mais son texte ne se modifie plus.
//   - L'auteur (et l'admin) modifie ou supprime une tâche encore à faire.
//   - Une tâche peut avoir un responsable : nommé à la création (ou ensuite, par l'auteur et l'admin), ou pris par
//     quiconque en cliquant « Je m'en occupe » sur une tâche libre (on peut s'en retirer).
//   - Une tâche peut avoir une échéance : elle apparaît alors dans le calendrier du projet (calendar.js), où on
//     peut aussi la cocher.
//   - Le nombre de tâches ouvertes de chaque projet est suivi en permanence et affiché sur le bouton ✅ (sidebar.js).
//   - Chaque tâche a une note en texte libre (projects/{p}/notes/{id}, même identifiant), pour en écrire le
//     rapport : tout membre l'écrit tant que la tâche est à faire ; terminée, elle se lit sans se modifier.
// La liste s'ouvre dans un dialogue (bouton ✅ d'un projet, barre latérale).
import {
  collection, deleteField, doc, limit, onSnapshot, orderBy, query, serverTimestamp, where, writeBatch,
} from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { confirmDialog, toast } from "./dialogs.js";
import { displayText } from "./names.js";
import { bumpRate, rateReady, rateWait } from "./rate.js";
import { projectColor, renderConversationList } from "./sidebar.js";
import { state } from "./state.js";
import { ensureTicket } from "./tickets.js";
import { addLog } from "./log.js";
import { $, announce } from "./ui.js";
import { syncNames } from "./app.js";

const MAX_TASKS = 500; // les règles ne bornent pas le nombre : c'est la taille de la liste écoutée

const whenFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const dueFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

const pad = (n) => String(n).padStart(2, "0");
/** @returns {string} aujourd'hui, « AAAA-MM-JJ » en heure locale */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** @returns {string | null} échéance « AAAA-MM-JJ » d'une tâche (jamais supposée bien formée) */
export function dueOf(t) {
  return typeof t?.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null;
}
/** @param {string} key « AAAA-MM-JJ » */
export function formatDue(key) {
  const [y, m, d] = key.split("-").map(Number);
  return dueFmt.format(new Date(y, m - 1, d));
}

const me = () => state.user?.uid ?? "";
const who = (uid) => (uid === me() ? "toi" : displayText(uid));
const canManage = (owner) => state.isAdmin || owner === me();
const toDate = (ts) => ts?.toDate?.() ?? null;
const millis = (ts) => toDate(ts)?.getTime() ?? 0;

/** @type {string | null} projet dont la liste est ouverte */
let pid = null;
/** @type {Map<string, any>} id -> données */
let tasks = new Map();
let unsub = /** @type {null | (() => void)} */ (null);
let unsubMembers = /** @type {null | (() => void)} */ (null);
let unsubNotes = /** @type {null | (() => void)} */ (null);
/** @type {Map<string, any>} id de la tâche -> note */
let notes = new Map();
/** @type {Set<string>} personnes du projet (fiches de membre), proposées comme responsables */
let members = new Set();
let editingId = /** @type {string | null} */ (null);

function showError(msg) {
  $("tasks-error").textContent = msg;
  $("tasks-error").hidden = !msg;
}

function stop() {
  unsub?.();
  unsub = null;
  unsubMembers?.();
  unsubMembers = null;
  unsubNotes?.();
  unsubNotes = null;
}

/**
 * Ouvre la liste des tâches d'un projet.
 * @param {string} projectId
 */
export async function openTasks(projectId) {
  if (!state.projects.get(projectId)) return;
  const dlg = $("dlg-tasks");
  if (pid !== projectId) {
    stop();
    pid = projectId;
    tasks = new Map();
    notes = new Map();
    members = new Set();
    showError("");
    $("task-new").value = "";
    $("task-due").value = "";
    $("task-assignee").value = "";
  }
  render();
  if (!dlg.open) dlg.showModal();
  if (unsub) return;

  const ok = await ensureTicket(projectId);
  if (pid !== projectId || unsub) return;
  if (!ok) {
    showError("Accès aux tâches impossible pour le moment : réessaie dans un instant.");
    return;
  }
  unsubMembers = onSnapshot(collection(db, "projects", projectId, "members"), (snap) => {
    members = new Set(snap.docs.map((d) => d.id));
    syncNames();
    render();
  }, (err) => console.error("Lecture des membres du projet impossible", err));
  unsubNotes = onSnapshot(collection(db, "projects", projectId, "notes"), (snap) => {
    notes = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
    render();
    renderNote();
  }, (err) => console.error("Lecture des notes impossible", err));
  unsub = onSnapshot(
    query(collection(db, "projects", projectId, "tasks"), orderBy("createdAt", "desc"), limit(MAX_TASKS)),
    (snap) => {
      tasks = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
      showError("");
      syncNames();
      render();
      renderNote();
    },
    (err) => {
      console.error("Lecture des tâches impossible", err);
      showError("Lecture des tâches impossible : " + (err.code === "permission-denied"
        ? "tu n'as plus accès à ce projet." : err.message));
    },
  );
}

$("dlg-tasks").addEventListener("close", () => {
  stop();
  pid = null;
  tasks = new Map();
  notes = new Map();
  members = new Set();
  if ($("dlg-task").open) $("dlg-task").close();
  if ($("dlg-task-note").open) $("dlg-task-note").close();
});

// Personnes à suivre dans l'annuaire des noms (app.js, syncNames) : auteurs et personnes qui ont coché.
export function taskUids() {
  const uids = new Set(members);
  for (const t of tasks.values()) {
    if (typeof t.createdBy === "string") uids.add(t.createdBy);
    if (typeof t.doneBy === "string") uids.add(t.doneBy);
    if (typeof t.assignee === "string") uids.add(t.assignee);
  }
  for (const n of notes.values()) if (typeof n.updatedBy === "string") uids.add(n.updatedBy);
  return uids;
}

// Projet, noms ou accès modifiés : réaffiche la liste ouverte, ou la ferme si le projet a disparu.
export function renderTasks() {
  if (!pid) return;
  const mine = [...state.conversations.values()].some((c) => c.projectId === pid);
  if (!state.projects.get(pid) || (!state.isAdmin && !mine)) {
    $("dlg-tasks").close();
    return;
  }
  render();
}

/* ---------- Compteur de tâches ouvertes (barre latérale) ---------- */

export const COUNT_LIMIT = 100; // au-delà, le compteur affiche « 100+ »
/** @type {Map<string, { open: number, mine: number }>} projet -> tâches ouvertes (dont celles dont on est responsable) */
const counts = new Map();
const watchers = new Map(); // projet -> unsubscribe
const starting = new Set(); // projets en cours de démarrage
const failedAt = new Map(); // projet -> date du dernier échec (nouvel essai au bout d'une minute)

/**
 * @param {string} projectId
 * @returns {{ open: number, mine: number } | null} null tant que le compteur n'est pas connu
 */
export function openTaskCount(projectId) {
  return counts.get(projectId) ?? null;
}

// Un écouteur par projet visible (l'admin : tous), sur les seules tâches ouvertes. Appelé quand les
// conversations ou les projets changent : ne fait rien si tout est déjà suivi.
export function syncTaskCounts() {
  const session = state.user;
  if (!session) return;
  const wanted = new Set();
  if (state.isAdmin) {
    if (state.projectsLoaded) for (const id of state.projects.keys()) wanted.add(id);
  } else {
    for (const [id, p] of state.projects) if (p) wanted.add(id);
  }
  for (const [id, unsub] of watchers) {
    if (wanted.has(id)) continue;
    unsub();
    watchers.delete(id);
    if (counts.delete(id)) renderConversationList();
  }
  for (const id of wanted) {
    if (watchers.has(id) || starting.has(id) || Date.now() - (failedAt.get(id) ?? 0) < 60_000) continue;
    starting.add(id);
    ensureTicket(id).then((ok) => {
      starting.delete(id);
      if (state.user !== session || watchers.has(id) || !state.projects.get(id)) return;
      if (!ok) {
        failedAt.set(id, Date.now());
        return;
      }
      watchers.set(id, onSnapshot(
        query(collection(db, "projects", id, "tasks"), where("done", "==", false), limit(COUNT_LIMIT)),
        (snap) => {
          const mine = snap.docs.filter((d) => d.data().assignee === me()).length;
          const prev = counts.get(id);
          if (prev?.open === snap.size && prev.mine === mine) return;
          counts.set(id, { open: snap.size, mine });
          renderConversationList();
        },
        (err) => {
          console.warn("Compteur de tâches impossible", id, err);
          watchers.delete(id);
          if (counts.delete(id)) renderConversationList();
          failedAt.set(id, Date.now());
        },
      ));
    }).catch(() => {
      starting.delete(id);
      failedAt.set(id, Date.now());
    });
  }
}

// Fermeture à la déconnexion.
export function teardownTasks() {
  watchers.forEach((unsub) => unsub());
  watchers.clear();
  starting.clear();
  failedAt.clear();
  counts.clear();
  if ($("dlg-tasks").open) $("dlg-tasks").close();
  pid = null;
  stop();
  tasks = new Map();
  notes = new Map();
  members = new Set();
  drafts.clear(); // brouillons du compte qui se déconnecte
}

/* ---------- Affichage ---------- */

function render() {
  if (!pid) return;
  const p = state.projects.get(pid);
  $("dlg-tasks").style.setProperty("--proj", projectColor(pid));
  $("tasks-title").textContent = `Tâches de « ${p?.title || "(sans titre)"} »`;
  fillAssignees($("task-assignee"), null);
  if ($("dlg-task").open && editingId) fillAssignees($("task-edit-assignee"), assigneeOf(tasks.get(editingId)));

  const all = [...tasks.entries()].filter(([, t]) => typeof t.title === "string" && t.title);
  // À faire : échéances les plus proches d'abord (sans échéance à la fin), puis par date d'ajout.
  const open = all.filter(([, t]) => t.done !== true).sort((a, b) =>
    (dueOf(a[1]) ?? "9999").localeCompare(dueOf(b[1]) ?? "9999") || millis(a[1].createdAt) - millis(b[1].createdAt));
  const done = all.filter(([, t]) => t.done === true).sort((a, b) => millis(b[1].doneAt) - millis(a[1].doneAt));

  $("tasks-open").replaceChildren(...(open.length ? open.map(([id, t]) => taskItem(id, t)) : [emptyItem("Rien à faire pour l'instant.")]));
  $("tasks-done").replaceChildren(...(done.length ? done.map(([id, t]) => taskItem(id, t)) : [emptyItem("Aucune tâche terminée.")]));
  $("tasks-open-count").textContent = open.length ? String(open.length) : "";
  $("tasks-done-count").textContent = done.length ? String(done.length) : "";
}

/** @returns {string | null} responsable d'une tâche (jamais supposé bien formé) */
function assigneeOf(t) {
  return typeof t?.assignee === "string" && t.assignee ? t.assignee : null;
}

// Liste des responsables possibles : personne, soi-même, puis les autres membres du projet (et le
// responsable actuel d'une tâche, même s'il a quitté le projet). Les options ne sont refaites que si
// elles changent, pour ne pas fermer une liste ouverte ni perdre le choix en cours.
function fillAssignees(select, current) {
  const others = new Set(members);
  others.delete(me());
  if (current && current !== me()) others.add(current);
  const list = [...others].sort((a, b) => who(a).localeCompare(who(b), "fr"));
  const sig = JSON.stringify([me(), list.map((u) => [u, who(u)])]);
  if (select.dataset.sig === sig) return;
  select.dataset.sig = sig;
  const keep = select.value;
  const option = (value, text) => Object.assign(document.createElement("option"), { value, textContent: text });
  select.replaceChildren(option("", "Non assignée"), option(me(), "Moi"), ...list.map((u) => option(u, who(u))));
  select.value = [...select.options].some((o) => o.value === keep) ? keep : (current ?? "");
}

function emptyItem(text) {
  const li = document.createElement("li");
  li.className = "muted small";
  li.textContent = text;
  return li;
}

function stamp(ts) {
  const d = toDate(ts);
  return d ? " le " + whenFmt.format(d) : "";
}

function taskItem(id, t) {
  const done = t.done === true;
  const li = document.createElement("li");
  li.className = "task" + (done ? " done" : "");
  const label = document.createElement("label");
  label.className = "check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = done;
  cb.addEventListener("change", () => toggleTask(id, cb));
  const text = document.createElement("span");
  text.className = "task-title";
  text.textContent = t.title;
  label.append(cb, text);
  li.append(label);

  const meta = document.createElement("span");
  meta.className = "task-meta muted small";
  const added = typeof t.createdBy === "string" ? `ajoutée par ${who(t.createdBy)}${stamp(t.createdAt)}` : "";
  const finished = done ? `terminée${typeof t.doneBy === "string" ? " par " + who(t.doneBy) : ""}${stamp(t.doneAt)}` : "";
  const assignee = assigneeOf(t);
  const parts = [];
  const due = dueOf(t);
  if (due) {
    const late = !done && due < todayKey();
    parts.push(Object.assign(document.createElement("span"), {
      className: late ? "task-late" : "", textContent: (late ? "en retard · " : "pour le ") + formatDue(due),
    }));
  }
  if (assignee) parts.push(Object.assign(document.createElement("span"), {
    className: "task-assignee", textContent: "responsable : " + who(assignee),
  }));
  else if (!done) parts.push(Object.assign(document.createElement("span"), {
    className: "task-assignee free", textContent: "sans responsable",
  }));
  parts.push(...[finished, added].filter(Boolean));
  parts.forEach((p, i) => meta.append(i ? " · " : "", p));
  if (parts.length) li.append(meta);

  const actions = document.createElement("div");
  actions.className = "task-actions";
  // Tâche libre : « Je m'en occupe ». Tâche qu'on a prise : on peut s'en retirer.
  if (!done && (!assignee || assignee === me())) {
    const take = document.createElement("button");
    take.type = "button";
    take.className = "task-take";
    take.textContent = assignee ? "Me retirer" : "Je m'en occupe";
    take.title = assignee ? `Ne plus être responsable de « ${t.title} »` : `Devenir responsable de « ${t.title} »`;
    take.addEventListener("click", () => setAssignee(id, assignee ? null : me(), take));
    actions.append(take);
  }
  // Note : à écrire tant que la tâche est à faire ; terminée, seulement si elle en a une (lecture).
  const hasNote = Boolean(noteText(notes.get(id)));
  if (!done || hasNote) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task-note" + (hasNote ? " has-note" : "");
    btn.textContent = hasNote ? "📝 Note" : "📝 Ajouter une note";
    btn.title = (hasNote ? "Ouvrir la note de " : "Écrire une note sur ") + `« ${t.title} »`;
    btn.addEventListener("click", () => openNote(id));
    actions.append(btn);
  }
  if (actions.childElementCount) li.append(actions);

  // L'historique n'est pas modifiable : seules les tâches à faire ont un ✎.
  if (!done && canManage(t.createdBy)) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "task-edit";
    edit.textContent = "✎";
    edit.title = `Modifier la tâche « ${t.title} »`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => openEdit(id));
    li.append(edit);
  }
  return li;
}

/* ---------- Écritures ---------- */

async function rateOk() {
  await rateReady();
  const wait = rateWait();
  if (wait) toast(`Trop de modifications en une minute : réessaie dans ${wait} s.`, { error: true });
  return !wait;
}

/**
 * Coche ou rouvre une tâche (aussi utilisé par le calendrier). Affiche l'erreur si l'écriture échoue.
 * @param {string} projectId
 * @param {string} id
 * @param {boolean} on true : terminée
 * @param {string} [title] texte de la tâche, pour le journal (sinon lu dans la liste ouverte)
 * @returns {Promise<boolean>} true si l'écriture a réussi
 */
export async function setTaskDone(projectId, id, on, title = tasks.get(id)?.title) {
  if (!await rateOk()) return false;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "projects", projectId, "tasks", id), on
      ? { done: true, doneBy: me(), doneAt: serverTimestamp(), updatedAt: serverTimestamp() }
      : { done: false, doneBy: deleteField(), doneAt: deleteField(), updatedAt: serverTimestamp() });
    addLog(batch, on ? "task.done" : "task.reopen", { projectId, label: title });
    bumpRate(batch);
    await batch.commit();
    announce(on ? "Tâche terminée." : "Tâche rouverte.");
    return true;
  } catch (err) {
    console.error(err);
    toast("Modification impossible : " + err.message, { error: true });
    return false;
  }
}

async function toggleTask(id, cb) {
  const on = cb.checked;
  if (!pid) {
    cb.checked = !on;
    return;
  }
  cb.disabled = true;
  if (!await setTaskDone(pid, id, on)) cb.checked = !on;
  cb.disabled = false;
}

/**
 * Prend une tâche libre, ou s'en retire.
 * @param {string} id
 * @param {string | null} uid null : retire le responsable
 * @param {HTMLButtonElement} btn
 */
async function setAssignee(id, uid, btn) {
  const projectId = pid;
  if (!projectId || !await rateOk()) return;
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "projects", projectId, "tasks", id), {
      assignee: uid ?? deleteField(), updatedAt: serverTimestamp(),
    });
    addLog(batch, "task.assign", { projectId, about: uid ?? undefined, label: tasks.get(id)?.title });
    bumpRate(batch);
    await batch.commit();
    announce(uid ? "Tu es responsable de la tâche." : "Tu n'es plus responsable de la tâche.");
  } catch (err) {
    console.error(err);
    toast("Modification impossible : " + err.message, { error: true });
  } finally {
    btn.disabled = false;
  }
}

$("form-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const projectId = pid;
  const input = $("task-new");
  const title = input.value.trim();
  if (!projectId || !title) return;
  if (!unsub) return showError("Les tâches ne sont pas encore chargées : réessaie dans un instant.");
  if (tasks.size >= MAX_TASKS) return showError(`${MAX_TASKS} tâches au plus dans la liste.`);
  if (!await rateOk()) return;
  const btn = $("task-add");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const assignee = $("task-assignee").value;
    const due = $("task-due").value;
    batch.set(doc(collection(db, "projects", projectId, "tasks")), {
      title, ...(assignee ? { assignee } : {}), ...(due ? { due } : {}), done: false, createdBy: me(),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    addLog(batch, "task.create", { projectId, about: assignee || undefined, label: title });
    bumpRate(batch);
    await batch.commit();
    if (pid === projectId && input.value.trim() === title) {
      input.value = "";
      $("task-due").value = "";
    }
    showError("");
    input.focus();
  } catch (err) {
    console.error(err);
    showError("Ajout impossible : " + err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Dialogue : modifier une tâche ---------- */

function openEdit(id) {
  const t = tasks.get(id);
  if (!t || t.done === true || !canManage(t.createdBy)) return;
  editingId = id;
  $("task-title").value = t.title;
  fillAssignees($("task-edit-assignee"), assigneeOf(t));
  $("task-edit-assignee").value = assigneeOf(t) ?? "";
  $("task-edit-due").value = dueOf(t) ?? "";
  $("task-error").hidden = true;
  $("dlg-task").showModal();
}

$("form-task-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  const projectId = pid;
  const title = $("task-title").value.trim();
  const fail = (msg) => { $("task-error").textContent = msg; $("task-error").hidden = false; };
  if (!projectId || !editingId) return $("dlg-task").close();
  if (!title) return fail("Écris la tâche.");
  if (!await rateOk()) return;
  const btn = $("task-edit-submit");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const before = assigneeOf(tasks.get(editingId));
    const assignee = $("task-edit-assignee").value || null;
    const dueBefore = dueOf(tasks.get(editingId));
    const due = $("task-edit-due").value || null;
    batch.update(doc(db, "projects", projectId, "tasks", editingId), {
      title,
      ...(assignee === before ? {} : { assignee: assignee ?? deleteField() }),
      ...(due === dueBefore ? {} : { due: due ?? deleteField() }),
      updatedAt: serverTimestamp(),
    });
    addLog(batch, "task.update", { projectId, label: title });
    if (assignee !== before) addLog(batch, "task.assign", { projectId, about: assignee ?? undefined, label: title });
    bumpRate(batch);
    await batch.commit();
    $("dlg-task").close();
  } catch (err) {
    console.error(err);
    fail("Enregistrement impossible : " + err.message);
  } finally {
    btn.disabled = false;
  }
});

$("btn-delete-task").addEventListener("click", async () => {
  const projectId = pid;
  const t = editingId && tasks.get(editingId);
  if (!projectId || !t) return;
  if (!await confirmDialog(`Supprimer la tâche « ${t.title} » ?`, { ok: "Supprimer", danger: true })) return;
  if (!await rateOk()) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "projects", projectId, "tasks", editingId));
    batch.delete(doc(db, "projects", projectId, "notes", editingId)); // sa note part avec elle
    addLog(batch, "task.delete", { projectId, label: t.title });
    bumpRate(batch);
    await batch.commit();
    $("dlg-task").close();
  } catch (err) {
    console.error(err);
    toast("Suppression impossible : " + err.message, { error: true });
  }
});

/* ---------- Dialogue : note d'une tâche ---------- */

const NOTE_MAX = 20000; // identique à firestore.rules
/** @type {string | null} tâche dont la note est ouverte */
let noteId = null;
// Version de la note chargée dans la zone de texte (date et texte) : sert à savoir si l'on a écrit
// quelque chose, et si quelqu'un d'autre l'a enregistrée entre-temps.
let noteBase = 0;
let noteLoaded = "";
// Texte non enregistré d'une note fermée (Fermer, Échap) : retrouvé à sa réouverture, jusqu'au
// rechargement de la page. Rien n'est écrit dans le navigateur.
/** @type {Map<string, string>} « projet/tâche » -> brouillon */
const drafts = new Map();

/** @returns {string} texte d'une note (jamais supposée bien formée) */
function noteText(n) {
  return typeof n?.text === "string" ? n.text : "";
}

function noteFail(msg) {
  $("task-note-error").textContent = msg;
  $("task-note-error").hidden = !msg;
}

function openNote(id) {
  const t = tasks.get(id);
  if (!t) return;
  const n = notes.get(id);
  noteId = id;
  noteLoaded = noteText(n);
  noteBase = millis(n?.updatedAt);
  const draft = drafts.get(`${pid}/${id}`);
  $("task-note-text").value = t.done !== true && draft !== undefined ? draft : noteLoaded;
  noteFail(t.done !== true && draft !== undefined ? "Brouillon non enregistré repris." : "");
  $("dlg-task-note").showModal();
  renderNote();
  if (t.done !== true) $("task-note-text").focus();
}

// Titre, dernière modification et lecture seule (tâche terminée). Si la note change ailleurs : reprend
// le nouveau texte si l'on n'a rien écrit, sinon prévient qu'enregistrer remplacera l'autre version.
function renderNote() {
  if (!noteId || !$("dlg-task-note").open) return;
  const t = tasks.get(noteId);
  if (!t) {
    $("dlg-task-note").close();
    return;
  }
  const n = notes.get(noteId);
  const done = t.done === true;
  const by = typeof n?.updatedBy === "string" ? " par " + who(n.updatedBy) : "";
  $("task-note-title").textContent = `Note : « ${t.title} »`;
  $("task-note-meta").textContent = (n ? `Modifiée${by}${stamp(n.updatedAt)}.` : "Pas encore de note.")
    + (done ? " Tâche terminée : la note ne se modifie plus (rouvre la tâche pour la compléter)." : "");
  const area = /** @type {HTMLTextAreaElement} */ ($("task-note-text"));
  area.readOnly = done;
  $("task-note-save").hidden = done;
  const at = millis(n?.updatedAt);
  if (at === noteBase) return;
  if (done || area.value === noteLoaded) {
    noteLoaded = area.value = noteText(n);
    noteBase = at;
    noteFail("");
  } else {
    noteFail(`Note modifiée${by} pendant que tu écrivais : enregistrer remplacera sa version.`);
  }
}

$("dlg-task-note").addEventListener("close", () => {
  const text = /** @type {HTMLTextAreaElement} */ ($("task-note-text")).value;
  if (noteId && pid) {
    const key = `${pid}/${noteId}`;
    if (text !== noteLoaded && tasks.get(noteId)?.done !== true) drafts.set(key, text);
    else drafts.delete(key);
  }
  noteId = null;
});

$("form-task-note").addEventListener("submit", async (e) => {
  e.preventDefault();
  const projectId = pid;
  const id = noteId;
  const t = id && tasks.get(id);
  if (!projectId || !t || t.done === true) return;
  const text = /** @type {HTMLTextAreaElement} */ ($("task-note-text")).value;
  if (text.length > NOTE_MAX) return noteFail(`${NOTE_MAX} caractères au plus.`);
  if (!await rateOk()) return;
  const btn = $("task-note-save");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "projects", projectId, "notes", id), {
      text, updatedBy: me(), updatedAt: serverTimestamp(),
    });
    bumpRate(batch);
    await batch.commit();
    noteLoaded = text; // enregistrée : pas de brouillon à garder
    $("dlg-task-note").close();
    announce("Note enregistrée.");
  } catch (err) {
    console.error(err);
    noteFail("Enregistrement impossible : " + err.message);
  } finally {
    btn.disabled = false;
  }
});

$("task-note-copy").addEventListener("click", async () => {
  const text = /** @type {HTMLTextAreaElement} */ ($("task-note-text")).value;
  try {
    await navigator.clipboard.writeText(text);
    toast("Note copiée.");
  } catch {
    $("task-note-text").select();
    toast("Copie impossible : le texte est sélectionné, copie-le avec Cmd/Ctrl + C.", { error: true });
  }
});

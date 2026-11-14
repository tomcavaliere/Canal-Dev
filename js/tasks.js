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
// La liste s'ouvre dans un dialogue (bouton ✅ d'un projet, barre latérale).
import {
  collection, deleteDoc, deleteField, doc, limit, onSnapshot, orderBy, query, serverTimestamp, writeBatch,
} from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { confirmDialog, toast } from "./dialogs.js";
import { displayText } from "./names.js";
import { bumpRate, rateReady, rateWait } from "./rate.js";
import { projectColor } from "./sidebar.js";
import { state } from "./state.js";
import { ensureTicket } from "./tickets.js";
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
  unsub = onSnapshot(
    query(collection(db, "projects", projectId, "tasks"), orderBy("createdAt", "desc"), limit(MAX_TASKS)),
    (snap) => {
      tasks = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
      showError("");
      syncNames();
      render();
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
  members = new Set();
  if ($("dlg-task").open) $("dlg-task").close();
});

// Personnes à suivre dans l'annuaire des noms (app.js, syncNames) : auteurs et personnes qui ont coché.
export function taskUids() {
  const uids = new Set(members);
  for (const t of tasks.values()) {
    if (typeof t.createdBy === "string") uids.add(t.createdBy);
    if (typeof t.doneBy === "string") uids.add(t.doneBy);
    if (typeof t.assignee === "string") uids.add(t.assignee);
  }
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

// Fermeture à la déconnexion.
export function teardownTasks() {
  if ($("dlg-tasks").open) $("dlg-tasks").close();
  pid = null;
  stop();
  tasks = new Map();
  members = new Set();
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

  // Tâche libre : « Je m'en occupe ». Tâche qu'on a prise : on peut s'en retirer.
  if (!done && (!assignee || assignee === me())) {
    const take = document.createElement("button");
    take.type = "button";
    take.className = "task-take";
    take.textContent = assignee ? "Me retirer" : "Je m'en occupe";
    take.title = assignee ? `Ne plus être responsable de « ${t.title} »` : `Devenir responsable de « ${t.title} »`;
    take.addEventListener("click", () => setAssignee(id, assignee ? null : me(), take));
    li.append(take);
  }

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
 * @returns {Promise<boolean>} true si l'écriture a réussi
 */
export async function setTaskDone(projectId, id, on) {
  if (!await rateOk()) return false;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "projects", projectId, "tasks", id), on
      ? { done: true, doneBy: me(), doneAt: serverTimestamp(), updatedAt: serverTimestamp() }
      : { done: false, doneBy: deleteField(), doneAt: deleteField(), updatedAt: serverTimestamp() });
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
  try {
    await deleteDoc(doc(db, "projects", projectId, "tasks", editingId));
    $("dlg-task").close();
  } catch (err) {
    console.error(err);
    toast("Suppression impossible : " + err.message, { error: true });
  }
});

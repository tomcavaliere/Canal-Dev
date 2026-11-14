// Tâches d'un projet (projects/{p}/tasks) : une todo list partagée par tous les membres du projet
// (voir tickets.js et firestore.rules).
//   - Tout membre ajoute une tâche et coche celles qui sont faites (qui + quand sont gardés).
//   - Une tâche cochée ne disparaît jamais : elle passe dans « Terminées », la plus récente en premier,
//     ce qui forme l'historique du projet. On peut la rouvrir, mais son texte ne se modifie plus.
//   - L'auteur (et l'admin) modifie ou supprime une tâche encore à faire.
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
let editingId = /** @type {string | null} */ (null);

function showError(msg) {
  $("tasks-error").textContent = msg;
  $("tasks-error").hidden = !msg;
}

function stop() {
  unsub?.();
  unsub = null;
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
    showError("");
    $("task-new").value = "";
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
  if ($("dlg-task").open) $("dlg-task").close();
});

// Personnes à suivre dans l'annuaire des noms (app.js, syncNames) : auteurs et personnes qui ont coché.
export function taskUids() {
  const uids = new Set();
  for (const t of tasks.values()) {
    if (typeof t.createdBy === "string") uids.add(t.createdBy);
    if (typeof t.doneBy === "string") uids.add(t.doneBy);
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
}

/* ---------- Affichage ---------- */

function render() {
  if (!pid) return;
  const p = state.projects.get(pid);
  $("dlg-tasks").style.setProperty("--proj", projectColor(pid));
  $("tasks-title").textContent = `Tâches de « ${p?.title || "(sans titre)"} »`;

  const all = [...tasks.entries()].filter(([, t]) => typeof t.title === "string" && t.title);
  const open = all.filter(([, t]) => t.done !== true).sort((a, b) => millis(a[1].createdAt) - millis(b[1].createdAt));
  const done = all.filter(([, t]) => t.done === true).sort((a, b) => millis(b[1].doneAt) - millis(a[1].doneAt));

  $("tasks-open").replaceChildren(...(open.length ? open.map(([id, t]) => taskItem(id, t)) : [emptyItem("Rien à faire pour l'instant.")]));
  $("tasks-done").replaceChildren(...(done.length ? done.map(([id, t]) => taskItem(id, t)) : [emptyItem("Aucune tâche terminée.")]));
  $("tasks-open-count").textContent = open.length ? String(open.length) : "";
  $("tasks-done-count").textContent = done.length ? String(done.length) : "";
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
  meta.textContent = [finished, added].filter(Boolean).join(" · ");
  if (meta.textContent) li.append(meta);

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

async function toggleTask(id, cb) {
  const projectId = pid;
  const on = cb.checked;
  if (!projectId || !await rateOk()) {
    cb.checked = !on;
    return;
  }
  cb.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "projects", projectId, "tasks", id), on
      ? { done: true, doneBy: me(), doneAt: serverTimestamp(), updatedAt: serverTimestamp() }
      : { done: false, doneBy: deleteField(), doneAt: deleteField(), updatedAt: serverTimestamp() });
    bumpRate(batch);
    await batch.commit();
    announce(on ? "Tâche terminée." : "Tâche rouverte.");
  } catch (err) {
    cb.checked = !on;
    console.error(err);
    toast("Modification impossible : " + err.message, { error: true });
  } finally {
    cb.disabled = false;
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
    batch.set(doc(collection(db, "projects", projectId, "tasks")), {
      title, done: false, createdBy: me(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    bumpRate(batch);
    await batch.commit();
    if (pid === projectId && input.value.trim() === title) input.value = "";
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
    batch.update(doc(db, "projects", projectId, "tasks", editingId), { title, updatedAt: serverTimestamp() });
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

// Calendrier d'un projet : réunions (projects/{p}/events) et objectifs (projects/{p}/goals),
// visibles par tous les membres du projet (voir tickets.js et firestore.rules).
//   - Tout membre crée une réunion et y invite d'autres membres du projet ; l'organisateur
//     (et l'admin) la modifie ou la supprime ; chaque invité répond « présent » ou « absent ».
//   - Tout membre ajoute des objectifs et coche ceux qui sont atteints ; l'auteur (et l'admin)
//     les modifie ou les supprime.
//   - Les tâches du projet (tasks.js) qui ont une échéance y apparaissent aussi, cochables depuis le calendrier.
// Le calendrier s'affiche à la place de la conversation (bouton 📅 d'un projet, barre latérale).
import {
  collection, collectionGroup, deleteDoc, deleteField, doc, limit, onSnapshot, orderBy, query,
  serverTimestamp, Timestamp, where, writeBatch,
} from "./sdk/firebase-firestore.js";
import { ADMIN_UID, db } from "./firebase.js";
import { confirmDialog, toast } from "./dialogs.js";
import { displayText } from "./names.js";
import { showNotification } from "./notify.js";
import { bumpRate, rateReady, rateWait } from "./rate.js";
import { renderRichText } from "./richtext.js";
import { isLogo } from "./images.js";
import { projectColor, renderConversationList } from "./sidebar.js";
import { state } from "./state.js";
import { ensureTicket } from "./tickets.js";
import { openTasks, setTaskDone } from "./tasks.js";
import { $, announce } from "./ui.js";
import { openProjectCalendar, syncNames } from "./app.js";

const MAX_ATTENDEES = 50; // mêmes limites que firestore.rules
const MAX_GOALS = 300;
const UPCOMING = 10;

const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const shortDayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });
const dueFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

/* ---------- Dates ---------- */

const pad = (n) => String(n).padStart(2, "0");
/** @param {Date} d @returns {string} « AAAA-MM-JJ » en heure locale */
function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** @param {string} key « AAAA-MM-JJ » @returns {Date} minuit, heure locale */
function fromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** @param {Date} d @returns {string} « HH:MM » */
function timeKey(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function toDate(ts) {
  return ts?.toDate?.() ?? null;
}
const isDueKey = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Premier jour affiché (lundi) et lendemain du dernier : 6 semaines autour du mois.
function gridRange(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  return { start, end: addDays(start, 42) };
}

/* ---------- Données ---------- */

/**
 * Réunion telle qu'affichée (données filtrées : jamais supposées bien formées).
 * @typedef {{ id: string, title: string, description: string, place: string, start: Date, end: Date,
 *   createdBy: string, attendees: string[], responses: Record<string, string> }} CalEvent
 */
/** @returns {CalEvent | null} */
function eventOf(id, data) {
  const start = toDate(data.start);
  const end = toDate(data.end) ?? start;
  if (!start || typeof data.title !== "string") return null;
  const responses = data.responses && typeof data.responses === "object" ? data.responses : {};
  return {
    id,
    title: data.title,
    description: typeof data.description === "string" ? data.description : "",
    place: typeof data.place === "string" ? data.place : "",
    start,
    end,
    createdBy: typeof data.createdBy === "string" ? data.createdBy : "",
    attendees: Array.isArray(data.attendees) ? data.attendees.filter((u) => typeof u === "string") : [],
    responses: Object.fromEntries(Object.entries(responses).filter(([, v]) => v === "yes" || v === "no")),
  };
}

function freshCalendar() {
  return {
    pid: /** @type {string | null} */ (null),
    month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selected: dayKey(new Date()),
    ready: false,
    events: /** @type {Map<string, CalEvent>} */ (new Map()), // réunions des 6 semaines affichées
    upcoming: /** @type {Map<string, CalEvent>} */ (new Map()), // prochaines réunions
    goals: new Map(), // id -> data
    tasks: /** @type {Map<string, any>} */ (new Map()), // tâches dont l'échéance tombe dans les 6 semaines affichées
    members: /** @type {Set<string>} */ (new Set()), // fiches des membres du projet
    unsubs: /** @type {(() => void)[]} */ ([]),
    unsubMonth: /** @type {null | (() => void)} */ (null),
    unsubTasks: /** @type {null | (() => void)} */ (null),
  };
}
let cal = freshCalendar();

const me = () => state.user?.uid ?? "";
const who = (uid) => (uid === me() ? "toi" : displayText(uid));
const canManage = (owner) => state.isAdmin || owner === me();

function findEvent(id) {
  return cal.events.get(id) ?? cal.upcoming.get(id) ?? null;
}

// Personnes à suivre dans l'annuaire des noms (app.js, syncNames).
export function calendarUids() {
  const uids = new Set(cal.members);
  for (const e of [...cal.events.values(), ...cal.upcoming.values()]) {
    uids.add(e.createdBy);
    e.attendees.forEach((u) => uids.add(u));
  }
  for (const g of cal.goals.values()) {
    if (typeof g.createdBy === "string") uids.add(g.createdBy);
    if (typeof g.doneBy === "string") uids.add(g.doneBy);
  }
  for (const t of cal.tasks.values()) {
    for (const f of [t.createdBy, t.doneBy, t.assignee]) if (typeof f === "string") uids.add(f);
  }
  for (const inv of invites.values()) uids.add(inv.event.createdBy);
  uids.delete("");
  return uids;
}

/* ---------- Ouverture et fermeture ---------- */

export function isCalendarOpen() {
  return cal.pid !== null;
}

function stopListeners() {
  cal.unsubs.forEach((u) => u());
  cal.unsubMonth?.();
  cal.unsubTasks?.();
}

function showError(msg) {
  $("cal-error").textContent = msg;
  $("cal-error").hidden = !msg;
}

function listenError(what) {
  return (err) => {
    console.error(`Lecture du calendrier impossible (${what})`, err);
    showError("Lecture du calendrier impossible : " + (err.code === "permission-denied"
      ? "tu n'as plus accès à ce projet." : err.message));
  };
}

/**
 * Affiche le calendrier d'un projet (app.js ferme d'abord la conversation ouverte).
 * @param {string} projectId
 */
export async function openCalendar(projectId) {
  $("chat-empty").hidden = true;
  $("cal-view").hidden = false;
  if (cal.pid === projectId) return;
  stopListeners();
  closeDialogs();
  cal = freshCalendar();
  cal.pid = projectId;
  state.calendarProjectId = projectId;
  showError("");
  render();
  renderConversationList();

  const ok = await ensureTicket(projectId);
  if (cal.pid !== projectId) return;
  if (!ok) {
    showError("Accès au calendrier impossible pour le moment : réessaie dans un instant.");
    return;
  }
  const base = (sub) => collection(db, "projects", projectId, sub);
  cal.unsubs.push(
    onSnapshot(base("members"), (snap) => {
      cal.members = new Set(snap.docs.map((d) => d.id));
      changed();
    }, listenError("membres")),
    onSnapshot(query(base("goals"), limit(MAX_GOALS)), (snap) => {
      cal.goals = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
      changed();
    }, listenError("objectifs")),
    // Réunions pas encore terminées (une réunion en cours reste affichée).
    onSnapshot(query(base("events"), where("end", ">=", Timestamp.now()), orderBy("end"), limit(UPCOMING * 3)), (snap) => {
      cal.upcoming = eventsOf(snap);
      changed();
    }, listenError("prochaines réunions")),
  );
  listenMonth();
}

function eventsOf(snap) {
  const map = new Map();
  for (const d of snap.docs) {
    const e = eventOf(d.id, d.data({ serverTimestamps: "estimate" }));
    if (e) map.set(d.id, e);
  }
  return map;
}

// Réunions des six semaines affichées (réécoutées à chaque changement de mois).
function listenMonth() {
  cal.unsubMonth?.();
  cal.unsubTasks?.();
  const pid = cal.pid;
  if (!pid) return;
  const { start, end } = gridRange(cal.month);
  // Tâches dont l'échéance tombe dans ces six semaines (dates « AAAA-MM-JJ », comparées comme du texte).
  cal.tasks = new Map();
  cal.unsubTasks = onSnapshot(query(collection(db, "projects", pid, "tasks"),
    where("due", ">=", dayKey(start)), where("due", "<", dayKey(end)), orderBy("due")), (snap) => {
    cal.tasks = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
    changed();
  }, listenError("tâches"));
  const q = query(collection(db, "projects", pid, "events"),
    where("start", ">=", Timestamp.fromDate(start)), where("start", "<", Timestamp.fromDate(end)), orderBy("start"));
  cal.ready = false;
  cal.unsubMonth = onSnapshot(q, (snap) => {
    cal.events = eventsOf(snap);
    cal.ready = true;
    changed();
  }, listenError("mois"));
}

function changed() {
  syncNames();
  render();
  refreshDialogs();
}

export function closeCalendar() {
  if (cal.pid === null) return;
  stopListeners();
  closeDialogs();
  cal = freshCalendar();
  state.calendarProjectId = null;
  $("cal-view").hidden = true;
  if (!state.selectedId) $("chat-empty").hidden = false;
  renderConversationList();
}

function closeDialogs() {
  for (const id of ["dlg-event", "dlg-event-view", "dlg-goal"]) if ($(id).open) $(id).close();
}

// Conversations ou projets modifiés : le projet a pu disparaître ou devenir inaccessible.
export function onCalendarContextChanged() {
  if (!cal.pid) return;
  const project = state.projects.get(cal.pid);
  const mine = [...state.conversations.values()].some((c) => c.projectId === cal.pid);
  if (!project || (!state.isAdmin && !mine)) {
    closeCalendar();
    return;
  }
  if (!state.isAdmin) ensureTicket(cal.pid); // la conversation de la fiche a pu changer
  renderHead();
}

// Changement de session.
export function teardownCalendar() {
  closeCalendar();
  unsubInvites?.();
  unsubInvites = null;
  invites = new Map();
  invitesLoaded = false;
}

/* ---------- Affichage ---------- */

function render() {
  if (!cal.pid) return;
  renderHead();
  renderGrid();
  renderDay();
  renderUpcoming();
  renderGoals();
}

function renderHead() {
  const p = state.projects.get(cal.pid);
  const el = $("cal-project");
  el.textContent = p?.title || "";
  if (isLogo(p?.logo)) {
    const img = document.createElement("img");
    img.className = "chat-project-logo";
    img.src = p.logo;
    img.alt = "";
    el.prepend(img);
  }
  el.classList.toggle("has-logo", isLogo(p?.logo));
  $("cal-view").style.setProperty("--proj", projectColor(cal.pid));
}

// Réunions d'un jour (par heure de début), parmi celles du mois affiché.
function eventsOn(key) {
  return [...cal.events.values()].filter((e) => dayKey(e.start) === key).sort((a, b) => a.start.getTime() - b.start.getTime());
}
function tasksDue(key) {
  return [...cal.tasks.entries()].filter(([, t]) => t.due === key && typeof t.title === "string" && t.title)
    .sort((a, b) => Number(a[1].done === true) - Number(b[1].done === true) || a[1].title.localeCompare(b[1].title, "fr"));
}
function goalsDue(key) {
  return [...cal.goals.entries()].filter(([, g]) => g.due === key && typeof g.title === "string");
}

function renderGrid() {
  $("cal-month-label").textContent = monthFmt.format(cal.month);
  const { start } = gridRange(cal.month);
  const today = dayKey(new Date());
  const rows = [];
  for (let week = 0; week < 6; week++) {
    const tr = document.createElement("tr");
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, week * 7 + i);
      const key = dayKey(day);
      const events = eventsOn(key);
      const goals = goalsDue(key);
      const tasksOn = tasksDue(key);
      const td = document.createElement("td");
      td.className = "cal-cell"
        + (day.getMonth() !== cal.month.getMonth() ? " other-month" : "")
        + (key === today ? " today" : "")
        + (key === cal.selected ? " selected" : "");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-daynum" + (events.length || goals.length || tasksOn.length ? " has-items" : "");
      btn.textContent = String(day.getDate());
      const parts = [dayFmt.format(day)];
      if (events.length) parts.push(`${events.length} réunion${events.length > 1 ? "s" : ""}`);
      if (goals.length) parts.push(`${goals.length} objectif${goals.length > 1 ? "s" : ""} à échéance`);
      if (tasksOn.length) parts.push(`${tasksOn.length} tâche${tasksOn.length > 1 ? "s" : ""} à échéance`);
      btn.setAttribute("aria-label", parts.join(", "));
      btn.setAttribute("aria-pressed", String(key === cal.selected));
      if (key === today) btn.setAttribute("aria-current", "date");
      btn.addEventListener("click", () => selectDay(key));
      td.append(btn);

      if (events.length || goals.length || tasksOn.length) {
        const ul = document.createElement("ul");
        ul.className = "cal-chips";
        for (const e of events.slice(0, 3)) {
          const li = document.createElement("li");
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "cal-chip" + chipClass(e);
          chip.textContent = `${timeFmt.format(e.start)} ${e.title}`;
          chip.title = chip.textContent;
          chip.addEventListener("click", () => openEventView(e.id));
          li.append(chip);
          ul.append(li);
        }
        const more = events.length - 3;
        if (more > 0 || goals.length || tasksOn.length) {
          const li = document.createElement("li");
          li.className = "cal-more";
          li.textContent = [more > 0 ? `+${more}` : "", goals.length ? "🎯".repeat(Math.min(goals.length, 3)) : "",
            tasksOn.length ? "✅".repeat(Math.min(tasksOn.length, 3)) : ""].filter(Boolean).join(" ");
          li.setAttribute("aria-hidden", "true");
          ul.append(li);
        }
        td.append(ul);
      }
      tr.append(td);
    }
    rows.push(tr);
  }
  $("cal-grid").replaceChildren(...rows);
}

function chipClass(e) {
  if (!e.attendees.includes(me())) return e.createdBy === me() ? " mine" : "";
  const r = e.responses[me()];
  return " invited" + (r === "no" ? " declined" : r ? "" : " pending");
}

function selectDay(key) {
  cal.selected = key;
  const d = fromKey(key);
  if (d.getMonth() !== cal.month.getMonth() || d.getFullYear() !== cal.month.getFullYear()) {
    cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
    listenMonth();
  }
  render();
  $("cal-grid").querySelector(".selected .cal-daynum")?.focus();
}

function moveMonth(delta) {
  cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + delta, 1);
  cal.selected = dayKey(cal.month);
  listenMonth();
  render();
  announce(monthFmt.format(cal.month));
}

// Une réunion dans une liste : heure, titre, lieu, et ta réponse si tu es invité.
function eventItem(e, { withDate = false } = {}) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cal-item" + chipClass(e);
  const when = document.createElement("span");
  when.className = "cal-item-when";
  when.textContent = (withDate ? shortDayFmt.format(e.start) + " · " : "")
    + `${timeFmt.format(e.start)}–${timeFmt.format(e.end)}`;
  const title = document.createElement("span");
  title.className = "cal-item-title";
  title.textContent = e.title;
  btn.append(when, title);
  const tag = responseTag(e);
  if (tag) btn.append(tag);
  btn.addEventListener("click", () => openEventView(e.id));
  li.append(btn);
  return li;
}

function responseTag(e) {
  if (!e.attendees.includes(me())) return null;
  const r = e.responses[me()];
  const tag = document.createElement("span");
  tag.className = "cal-tag" + (r ? "" : " todo");
  tag.textContent = r === "yes" ? "Présent" : r === "no" ? "Absent" : "Invité · à répondre";
  return tag;
}

function emptyLi(text) {
  const li = document.createElement("li");
  li.className = "muted small cal-empty";
  li.textContent = text;
  return li;
}

function renderDay() {
  const day = fromKey(cal.selected);
  $("cal-day-label").textContent = dayFmt.format(day);
  const items = eventsOn(cal.selected).map((e) => eventItem(e));
  for (const [id, g] of goalsDue(cal.selected)) items.push(goalItem(id, g));
  for (const [id, t] of tasksDue(cal.selected)) items.push(taskDayItem(id, t));
  if (!items.length) items.push(emptyLi(cal.ready ? "Rien de prévu ce jour-là." : "Chargement…"));
  $("cal-day-list").replaceChildren(...items);
}

function renderUpcoming() {
  const list = [...cal.upcoming.values()].sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, UPCOMING);
  const items = list.map((e) => eventItem(e, { withDate: true }));
  if (!items.length) items.push(emptyLi("Aucune réunion prévue."));
  $("cal-upcoming").replaceChildren(...items);
}

/* ---------- Tâches à échéance ---------- */

// Une tâche du jour : case à cocher (comme dans la liste des tâches), responsable, et accès à la liste.
function taskDayItem(id, t) {
  const done = t.done === true;
  const li = document.createElement("li");
  li.className = "cal-goal" + (done ? " done" : "");
  const label = document.createElement("label");
  label.className = "check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = done;
  cb.addEventListener("change", async () => {
    const pid = cal.pid;
    cb.disabled = true;
    if (!pid || !await setTaskDone(pid, id, cb.checked)) cb.checked = !cb.checked;
    cb.disabled = false;
  });
  const text = document.createElement("span");
  text.className = "cal-goal-title";
  text.textContent = t.title;
  label.append(cb, text);
  li.append(label);

  const meta = document.createElement("span");
  meta.className = "cal-goal-meta muted small";
  const parts = ["tâche"];
  if (typeof t.assignee === "string" && t.assignee) parts.push("responsable : " + who(t.assignee));
  else if (!done) parts.push("sans responsable");
  if (done) parts.push(`terminée${typeof t.doneBy === "string" ? " par " + who(t.doneBy) : ""}`);
  else if (typeof t.due === "string" && t.due < dayKey(new Date())) parts.push("en retard");
  meta.textContent = parts.join(" · ");
  li.append(meta);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "cal-goal-edit";
  open.textContent = "✅";
  open.title = "Ouvrir la liste des tâches du projet";
  open.setAttribute("aria-label", open.title);
  open.addEventListener("click", () => cal.pid && openTasks(cal.pid));
  li.append(open);
  return li;
}

/* ---------- Objectifs ---------- */

function sortedGoals() {
  const goals = [...cal.goals.entries()].filter(([, g]) => typeof g.title === "string" && g.title);
  const open = goals.filter(([, g]) => !g.done)
    .sort((a, b) => (a[1].due || "9999").localeCompare(b[1].due || "9999") || a[1].title.localeCompare(b[1].title, "fr"));
  const done = goals.filter(([, g]) => g.done)
    .sort((a, b) => (toDate(b[1].doneAt)?.getTime() ?? 0) - (toDate(a[1].doneAt)?.getTime() ?? 0));
  return { open, done };
}

function goalItem(id, g) {
  const li = document.createElement("li");
  li.className = "cal-goal" + (g.done ? " done" : "");
  const label = document.createElement("label");
  label.className = "check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = g.done === true;
  cb.addEventListener("change", () => toggleGoal(id, cb));
  const text = document.createElement("span");
  text.className = "cal-goal-title";
  text.textContent = g.title;
  label.append(cb, text);
  li.append(label);

  const meta = document.createElement("span");
  meta.className = "cal-goal-meta muted small";
  const parts = [];
  if (isDueKey(g.due)) {
    const late = !g.done && g.due < dayKey(new Date());
    const due = document.createElement("span");
    due.className = late ? "cal-late" : "";
    due.textContent = (late ? "en retard · " : "pour le ") + dueFmt.format(fromKey(g.due));
    parts.push(due);
  }
  if (g.done) {
    const at = toDate(g.doneAt);
    parts.push(`atteint${typeof g.doneBy === "string" ? " par " + who(g.doneBy) : ""}${at ? " le " + dueFmt.format(at) : ""}`);
  } else if (typeof g.createdBy === "string") {
    parts.push(`ajouté par ${who(g.createdBy)}`);
  }
  parts.forEach((p, i) => meta.append(i ? " · " : "", p));
  if (parts.length) li.append(meta);

  if (canManage(g.createdBy)) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cal-goal-edit";
    edit.textContent = "✎";
    edit.title = `Modifier l'objectif « ${g.title} »`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => openGoalDialog(id));
    li.append(edit);
  }
  return li;
}

function renderGoals() {
  const { open, done } = sortedGoals();
  const items = [...open, ...done].map(([id, g]) => goalItem(id, g));
  if (!items.length) items.push(emptyLi("Aucun objectif pour l'instant."));
  $("cal-goals").replaceChildren(...items);
  const total = open.length + done.length;
  $("cal-goals-count").textContent = total ? `${done.length}/${total} atteint${done.length > 1 ? "s" : ""}` : "";
}

async function rateOk() {
  await rateReady();
  const wait = rateWait();
  if (wait) toast(`Trop de modifications en une minute : réessaie dans ${wait} s.`, { error: true });
  return !wait;
}

async function toggleGoal(id, cb) {
  const pid = cal.pid;
  const on = cb.checked;
  if (!pid || !await rateOk()) {
    cb.checked = !on;
    return;
  }
  cb.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "projects", pid, "goals", id), on
      ? { done: true, doneBy: me(), doneAt: serverTimestamp(), updatedAt: serverTimestamp() }
      : { done: false, doneBy: deleteField(), doneAt: deleteField(), updatedAt: serverTimestamp() });
    bumpRate(batch);
    await batch.commit();
    announce(on ? "Objectif atteint." : "Objectif rouvert.");
  } catch (err) {
    cb.checked = !on;
    console.error(err);
    toast("Modification impossible : " + err.message, { error: true });
  } finally {
    cb.disabled = false;
  }
}

/* ---------- Dialogue : objectif ---------- */

let editingGoal = /** @type {string | null} */ (null);

function openGoalDialog(id = null) {
  if (!cal.pid) return;
  const g = id ? cal.goals.get(id) : null;
  if (id && !g) return;
  editingGoal = id;
  $("form-goal").reset();
  $("goal-dlg-title").textContent = g ? "Modifier l'objectif" : "Nouvel objectif";
  $("goal-title").value = g?.title ?? "";
  $("goal-due").value = isDueKey(g?.due) ? g.due : "";
  $("btn-delete-goal").hidden = !g;
  $("goal-error").hidden = true;
  $("dlg-goal").showModal();
}

$("form-goal").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pid = cal.pid;
  const title = $("goal-title").value.trim();
  const due = $("goal-due").value;
  const fail = (msg) => { $("goal-error").textContent = msg; $("goal-error").hidden = false; };
  if (!pid) return $("dlg-goal").close();
  if (!title) return fail("Écris l'objectif.");
  if (due && !isDueKey(due)) return fail("Date d'échéance invalide.");
  if (!await rateOk()) return;
  const btn = $("goal-submit");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    if (editingGoal) {
      batch.update(doc(db, "projects", pid, "goals", editingGoal), {
        title, due: due || deleteField(), updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(collection(db, "projects", pid, "goals")), {
        title, ...(due ? { due } : {}), done: false, createdBy: me(),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    bumpRate(batch);
    await batch.commit();
    $("dlg-goal").close();
  } catch (err) {
    console.error(err);
    fail("Enregistrement impossible : " + err.message);
  } finally {
    btn.disabled = false;
  }
});

$("btn-delete-goal").addEventListener("click", async () => {
  const pid = cal.pid;
  const g = editingGoal && cal.goals.get(editingGoal);
  if (!pid || !g) return;
  if (!await confirmDialog(`Supprimer l'objectif « ${g.title} » ?`, { ok: "Supprimer", danger: true })) return;
  try {
    await deleteDoc(doc(db, "projects", pid, "goals", editingGoal));
    $("dlg-goal").close();
  } catch (err) {
    console.error(err);
    toast("Suppression impossible : " + err.message, { error: true });
  }
});

/* ---------- Dialogue : détail d'une réunion ---------- */

let viewing = /** @type {CalEvent | null} */ (null);

function openEventView(id) {
  const e = findEvent(id) ?? (viewing?.id === id ? viewing : null);
  if (!e) return;
  viewing = e;
  renderEventView();
  if (!$("dlg-event-view").open) $("dlg-event-view").showModal();
}

function renderEventView() {
  const e = viewing;
  if (!e) return;
  $("ev-title").textContent = e.title;
  $("ev-when").textContent = `${dayFmt.format(e.start)}, ${timeFmt.format(e.start)}–${timeFmt.format(e.end)}`;
  $("ev-place").replaceChildren(renderRichText(e.place));
  $("ev-place-row").hidden = !e.place;
  $("ev-desc").replaceChildren(renderRichText(e.description));
  $("ev-desc").hidden = !e.description;
  $("ev-organizer").textContent = who(e.createdBy);

  const status = { yes: "présent", no: "absent" };
  const items = e.attendees
    .map((uid) => ({ uid, name: who(uid), r: e.responses[uid] }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map(({ name, r }) => {
      const li = document.createElement("li");
      const n = document.createElement("span");
      n.textContent = name;
      const s = document.createElement("span");
      s.className = "cal-tag" + (r === "yes" ? " yes" : r === "no" ? " no" : "");
      s.textContent = status[r] ?? "sans réponse";
      li.append(n, s);
      return li;
    });
  if (!items.length) items.push(emptyLi("Personne n'est invité."));
  $("ev-attendees").replaceChildren(...items);
  const yes = e.attendees.filter((u) => e.responses[u] === "yes").length;
  $("ev-count").textContent = e.attendees.length ? `(${yes} présent${yes > 1 ? "s" : ""} sur ${e.attendees.length})` : "";

  const invited = e.attendees.includes(me());
  $("ev-respond").hidden = !invited;
  for (const [id, value] of [["btn-ev-yes", "yes"], ["btn-ev-no", "no"]]) {
    $(id).setAttribute("aria-pressed", String(e.responses[me()] === value));
  }
  $("btn-ev-edit").hidden = !canManage(e.createdBy);
  $("btn-ev-delete").hidden = !canManage(e.createdBy);
}

async function respond(value) {
  const pid = cal.pid;
  const e = viewing;
  if (!pid || !e || e.responses[me()] === value) return;
  if (!await rateOk()) return;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "projects", pid, "events", e.id), { [`responses.${me()}`]: value });
    bumpRate(batch);
    await batch.commit();
    announce(value === "yes" ? "Réponse : présent." : "Réponse : absent.");
  } catch (err) {
    console.error(err);
    toast("Réponse impossible : " + err.message, { error: true });
  }
}
$("btn-ev-yes").addEventListener("click", () => respond("yes"));
$("btn-ev-no").addEventListener("click", () => respond("no"));

$("btn-ev-edit").addEventListener("click", () => {
  const e = viewing;
  $("dlg-event-view").close();
  if (e) openEventDialog({ event: e });
});

$("btn-ev-delete").addEventListener("click", async () => {
  const pid = cal.pid;
  const e = viewing;
  if (!pid || !e) return;
  if (!await confirmDialog(`Supprimer la réunion « ${e.title} » ? Les invités ne la verront plus.`,
    { ok: "Supprimer", danger: true })) return;
  try {
    await deleteDoc(doc(db, "projects", pid, "events", e.id));
    $("dlg-event-view").close();
  } catch (err) {
    console.error(err);
    toast("Suppression impossible : " + err.message, { error: true });
  }
});

// Données à jour : le détail ouvert suit (ou se ferme si la réunion a été supprimée).
function refreshDialogs() {
  if ($("dlg-event-view").open && viewing) {
    const fresh = findEvent(viewing.id);
    // Absente des six semaines affichées alors qu'elle y tombe : elle a été supprimée.
    if (!fresh && cal.ready && gridHas(viewing.start)) {
      $("dlg-event-view").close();
      toast("Cette réunion a été supprimée.");
      return;
    }
    if (fresh) viewing = fresh;
    renderEventView();
  }
  if ($("dlg-event").open) renderAttendeePicker();
}

function gridHas(date) {
  const { start, end } = gridRange(cal.month);
  return date >= start && date < end;
}

/* ---------- Dialogue : nouvelle réunion / modifier ---------- */

let editingEvent = /** @type {CalEvent | null} */ (null);
let picked = /** @type {Set<string>} */ (new Set());

/** @param {{ event?: CalEvent, day?: string }} [options] */
function openEventDialog({ event = null, day = null } = {}) {
  if (!cal.pid) return;
  editingEvent = event;
  $("form-event").reset();
  $("event-dlg-title").textContent = event ? "Modifier la réunion" : "Nouvelle réunion";
  $("event-submit").textContent = event ? "Enregistrer" : "Créer";
  $("event-title").value = event?.title ?? "";
  $("event-place").value = event?.place ?? "";
  $("event-desc").value = event?.description ?? "";
  let start = event?.start;
  if (!start) {
    // Prochaine heure pleine, le jour choisi (ou aujourd'hui).
    const now = new Date();
    const base = day ? fromKey(day) : now;
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
      day && day !== dayKey(now) ? 10 : Math.min(now.getHours() + 1, 23));
  }
  const end = event?.end ?? new Date(Math.min(start.getTime() + 3600_000, addDays(start, 1).getTime() - 60_000));
  $("event-date").value = dayKey(start);
  $("event-start").value = timeKey(start);
  $("event-end").value = timeKey(end);
  $("event-reset-note").hidden = !event || !Object.keys(event.responses).length;
  picked = new Set(event?.attendees ?? []);
  renderAttendeePicker();
  $("event-error").hidden = true;
  $("dlg-event").showModal();
  $("event-title").focus();
}

// Membres du projet invitables (fiches), l'admin, et les invités déjà présents dans la réunion.
function renderAttendeePicker() {
  const uids = new Set([...cal.members, ADMIN_UID, ...picked]);
  uids.delete(me());
  const list = [...uids]
    .map((uid) => ({ uid, name: displayText(uid), member: cal.members.has(uid) || uid === ADMIN_UID }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const items = list.map(({ uid, name, member }) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = picked.has(uid);
    cb.addEventListener("change", () => {
      if (cb.checked) picked.add(uid); else picked.delete(uid);
      $("event-invite-count").textContent = picked.size ? `(${picked.size})` : "";
    });
    const text = document.createElement("span");
    text.textContent = name + (uid === ADMIN_UID ? " (admin)" : "") + (member ? "" : " — n'est plus membre du projet");
    label.append(cb, text);
    li.append(label);
    return li;
  });
  if (!items.length) items.push(emptyLi("Aucun autre membre dans ce projet pour l'instant."));
  $("event-attendees").replaceChildren(...items);
  $("event-invite-count").textContent = picked.size ? `(${picked.size})` : "";
}

$("form-event").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pid = cal.pid;
  const fail = (msg) => { $("event-error").textContent = msg; $("event-error").hidden = false; };
  if (!pid) return $("dlg-event").close();
  const title = $("event-title").value.trim();
  const place = $("event-place").value.trim();
  const description = $("event-desc").value.trim();
  const date = $("event-date").value;
  const [sh, sm] = ($("event-start").value || "").split(":").map(Number);
  const [eh, em] = ($("event-end").value || "").split(":").map(Number);
  if (!title) return fail("Donne un titre à la réunion.");
  if (!isDueKey(date) || [sh, sm, eh, em].some((n) => !Number.isFinite(n))) return fail("Indique la date, l'heure de début et l'heure de fin.");
  const day = fromKey(date);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
  if (end <= start) return fail("L'heure de fin doit suivre l'heure de début.");
  const attendees = [...picked].filter((u) => u !== me());
  if (attendees.length > MAX_ATTENDEES) return fail(`${MAX_ATTENDEES} invités au plus.`);
  if (!await rateOk()) return;

  const btn = $("event-submit");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const fields = {
      title, place, description, start: Timestamp.fromDate(start), end: Timestamp.fromDate(end),
      attendees, updatedAt: serverTimestamp(),
    };
    const old = editingEvent;
    if (old) {
      // Horaire changé : les réponses ne valent plus. Invité retiré : sa réponse part avec lui.
      const moved = old.start.getTime() !== start.getTime() || old.end.getTime() !== end.getTime();
      const responses = moved ? {} : Object.fromEntries(Object.entries(old.responses).filter(([u]) => attendees.includes(u)));
      batch.update(doc(db, "projects", pid, "events", old.id), { ...fields, responses });
    } else {
      batch.set(doc(collection(db, "projects", pid, "events")), {
        ...fields, createdBy: me(), createdAt: serverTimestamp(),
      });
    }
    bumpRate(batch);
    await batch.commit();
    $("dlg-event").close();
    if (!old) {
      selectDay(date);
      toast(attendees.length
        ? `Réunion créée. ${attendees.length} invité${attendees.length > 1 ? "s" : ""} la ver${attendees.length > 1 ? "ront" : "ra"} dans le calendrier du projet.`
        : "Réunion créée.");
    }
  } catch (err) {
    console.error(err);
    fail("Enregistrement impossible : " + err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Boutons de la vue ---------- */

$("btn-cal-prev").addEventListener("click", () => moveMonth(-1));
$("btn-cal-next").addEventListener("click", () => moveMonth(1));
$("btn-cal-today").addEventListener("click", () => selectDay(dayKey(new Date())));
$("btn-new-event").addEventListener("click", () => openEventDialog());
$("btn-day-event").addEventListener("click", () => openEventDialog({ day: cal.selected }));
$("btn-new-goal").addEventListener("click", () => openGoalDialog());
$("btn-cal-tasks").addEventListener("click", () => cal.pid && openTasks(cal.pid));
$("btn-cal-close").addEventListener("click", () => {
  closeCalendar();
  $("screen-app").classList.remove("show-chat");
});

/* ---------- Invitations (pastille 📅 de la barre latérale) ---------- */

/** @type {Map<string, { pid: string, event: CalEvent }>} chemin -> réunion où l'on est invité */
let invites = new Map();
let unsubInvites = null;
let invitesLoaded = false;

// Invitation qui attend une réponse : réunion pas encore terminée, organisée par quelqu'un d'autre.
function awaitsAnswer(e) {
  return e.end >= new Date() && e.createdBy !== me() && !e.responses[me()];
}

// Toutes les réunions où l'on est invité, dans tous ses projets (une seule écoute).
export function listenInvitations() {
  const uid = me();
  if (!uid) return;
  unsubInvites?.();
  invitesLoaded = false;
  const q = query(collectionGroup(db, "events"), where("attendees", "array-contains", uid));
  unsubInvites = onSnapshot(q, (snap) => {
    const next = new Map();
    for (const d of snap.docs) {
      const pid = d.ref.parent.parent?.id;
      const e = eventOf(d.id, d.data({ serverTimestamps: "estimate" }));
      if (pid && e) next.set(d.ref.path, { pid, event: e });
    }
    if (invitesLoaded) {
      for (const ch of snap.docChanges()) {
        const inv = next.get(ch.doc.ref.path);
        if (ch.type !== "added" || !inv || !awaitsAnswer(inv.event) || !state.projects.get(inv.pid)) continue;
        const e = inv.event;
        const text = `${displayText(e.createdBy)} t'invite à « ${e.title} », ${shortDayFmt.format(e.start)} à ${timeFmt.format(e.start)}.`;
        toast(text, { timeout: 10000 });
        showNotification({
          title: "Invitation à une réunion", body: text, tag: "event:" + e.id,
          onClick: () => openProjectCalendar(inv.pid),
        });
      }
    }
    invites = next;
    invitesLoaded = true;
    syncNames();
    renderConversationList();
  }, (err) => console.error("Lecture des invitations aux réunions impossible", err));
}

/**
 * Nombre d'invitations sans réponse dans un projet.
 * @param {string} projectId
 */
export function pendingInvitations(projectId) {
  let n = 0;
  for (const inv of invites.values()) if (inv.pid === projectId && awaitsAnswer(inv.event)) n++;
  return n;
}

/** Réaffichage quand l'annuaire des noms change. */
export function renderCalendarNames() {
  if (!cal.pid) return;
  render();
  refreshDialogs();
}

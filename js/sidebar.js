// Barre latérale : liste des conversations, groupées par projet et triées par activité.

import { displayText, nameOf } from "./names.js";
import { isLogo } from "./images.js";
import { linkHost, linksOf } from "./links.js";
import { $ } from "./ui.js";
import { openProjectCalendar, selectConversation } from "./app.js";
import { pendingInvitations } from "./calendar.js";
import { openOrgChart } from "./org.js";
import { COUNT_LIMIT, openTaskCount, openTasks } from "./tasks.js";
import { state } from "./state.js";
import { unreadBadge, unreadLabel, unreadMessages } from "./unread.js";

// Date de la dernière activité : dernier message, ou création pour une conversation vide.
function activityOf(c) {
  return (c.lastMessageAt ?? c.createdAt)?.toMillis?.() ?? 0;
}

export function sortedConversations() {
  return [...state.conversations.entries()].sort((a, b) => activityOf(b[1]) - activityOf(a[1]));
}

// Projet réel d'une conversation, ou null si elle n'en a pas (ou s'il a disparu).
export function projectOf(c) {
  return c.projectId && state.projects.get(c.projectId) ? c.projectId : null;
}

// Couleur d'un projet : choisie dans une palette à partir de son identifiant, donc stable
// d'une session à l'autre et identique pour tous les utilisateurs. "" (sans projet) : neutre.
const PROJECT_COLORS = 8;
export function projectColor(projectId) {
  if (!projectId) return "var(--muted)";
  let h = 0;
  for (const ch of projectId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--proj-${h % PROJECT_COLORS})`;
}

// Projets repliés dans la barre latérale (préférence locale, sans importance si perdue).
const COLLAPSED_KEY = "canal-dev.collapsedProjects";
const collapsed = new Set((() => {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch { return []; }
})());
function toggleCollapsed(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* ignoré */ }
  renderConversationList();
}

/* ---------- Barre latérale ---------- */

function conversationItem(id, c) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  const unread = state.unread.get(id) || 0;
  btn.className = "item" + (id === state.selectedId ? " active" : "") + (unread ? " has-unread" : "");
  btn.addEventListener("click", () => selectConversation(id));
  btn.dataset.focus = "conv:" + id;

  const row = document.createElement("span");
  row.className = "item-row";
  const title = document.createElement("span");
  title.className = "item-title";
  title.textContent = c.title || "(sans titre)";
  row.append(title);
  if (c.lastMessageAt) row.append(activityTime(c.lastMessageAt.toDate()));
  if (unread) row.append(unreadBadge(unread, unreadLabel(unread)));
  btn.append(row);

  // Aperçu du dernier message non lu, à la place de la description.
  const last = unread ? unreadMessages(id).at(-1) : null;
  if (last) {
    const sub = document.createElement("span");
    sub.className = "item-sub item-preview";
    sub.textContent = `${displayText(last.authorUid, last.authorName)} : ${last.excerpt}`;
    btn.append(sub);
  } else if (state.isAdmin) {
    const sub = document.createElement("span");
    sub.className = "item-sub";
    const n = c.members?.length ?? 0;
    sub.textContent = n === 0 ? "Aucun membre" : `${n} membre${n > 1 ? "s" : ""}`;
    btn.append(sub);
  } else if (c.description) {
    const sub = document.createElement("span");
    sub.className = "item-sub";
    sub.textContent = c.description;
    btn.append(sub);
  }
  li.append(btn);
  return li;
}

const clockFmt = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });
const shortDayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const shortDateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

// Heure du dernier message aujourd'hui, sinon sa date.
function activityTime(date) {
  const now = new Date();
  const t = document.createElement("time");
  t.className = "item-time";
  t.dateTime = date.toISOString();
  if (date.toDateString() === now.toDateString()) t.textContent = clockFmt.format(date);
  else if (date.getFullYear() === now.getFullYear()) t.textContent = shortDayFmt.format(date);
  else t.textContent = shortDateFmt.format(date);
  return t;
}

function emptyItem(text) {
  const li = document.createElement("li");
  li.className = "muted small list-empty";
  li.textContent = text;
  return li;
}

function smallButton(text, label, onClick, focusKey) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "group-btn";
  b.textContent = text;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  b.dataset.focus = focusKey;
  return b;
}

// Rôles d'un projet, dans l'ordre choisi par l'admin : [{ id, name, uids }].
// Les données sont filtrées (écrites par l'admin seul, mais jamais supposées bien formées) ;
// une personne absente de l'annuaire (compte supprimé) n'est pas affichée.
export function projectRoles(p) {
  if (!p || !Array.isArray(p.roles)) return [];
  const members = p.roleMembers && typeof p.roleMembers === "object" ? p.roleMembers : {};
  return p.roles
    .filter((r) => r && typeof r.id === "string" && typeof r.name === "string" && r.name)
    .map((r) => ({
      id: r.id,
      name: r.name,
      uids: Object.keys(members).filter((uid) => Array.isArray(members[uid]) && members[uid].includes(r.id)),
    }));
}

// Organigramme d'un projet, du niveau le plus haut au plus bas : [{ id, roles: [{ id, name, uids }] }].
// Les rôles disparus sont ignorés ; un rôle n'apparaît qu'au premier niveau qui le cite.
export function projectOrgLevels(p) {
  if (!p || !Array.isArray(p.orgLevels)) return [];
  const roles = new Map(projectRoles(p).map((r) => [r.id, r]));
  const placed = new Set();
  return p.orgLevels
    .filter((l) => l && typeof l.id === "string")
    .map((l) => ({
      id: l.id,
      roles: (Array.isArray(l.roles) ? l.roles : [])
        .filter((id) => roles.has(id) && !placed.has(id) && placed.add(id))
        .map((id) => roles.get(id)),
    }));
}

// Noms des personnes qui tiennent un rôle (« toi » pour soi-même), triés ; les personnes
// absentes de l'annuaire (compte supprimé) sont omises.
export function holderNames(uids) {
  return uids
    .filter((uid) => uid === state.user?.uid || typeof nameOf(uid) === "string")
    .map((uid) => (uid === state.user?.uid ? "toi" : displayText(uid)))
    .sort((a, b) => a.localeCompare(b, "fr"));
}

// Toutes les personnes qui tiennent un rôle dans les projets connus (pour suivre leurs noms).
export function roleUids() {
  const uids = new Set();
  for (const p of state.projects.values()) for (const r of projectRoles(p)) r.uids.forEach((u) => uids.add(u));
  return uids;
}

// Bloc « rôles » affiché sous l'en-tête d'un projet ouvert. Tous les rôles sont montrés à tout le
// monde, y compris ceux que personne ne tient encore (« à pourvoir »).
function rolesBlock(projectId) {
  const roles = projectRoles(state.projects.get(projectId))
    .map((r) => ({ ...r, names: holderNames(r.uids) }));
  if (!roles.length) return null;
  const ul = document.createElement("ul");
  ul.className = "list group-roles";
  ul.setAttribute("aria-label", "Rôles du projet");
  for (const r of roles) {
    const li = document.createElement("li");
    li.className = "role";
    const name = document.createElement("span");
    name.className = "role-name";
    name.textContent = r.name;
    const people = document.createElement("span");
    people.className = "role-people" + (r.names.length ? "" : " muted");
    people.textContent = r.names.length ? r.names.join(", ") : "à pourvoir";
    li.append(name, people);
    ul.append(li);
  }
  return ul;
}

// Liens d'un projet (ajoutés par l'admin), sous ses rôles : chacun s'ouvre dans un nouvel onglet.
function linksBlock(projectId) {
  const links = linksOf(state.projects.get(projectId));
  if (!links.length) return null;
  const ul = document.createElement("ul");
  ul.className = "list group-links";
  ul.setAttribute("aria-label", "Liens du projet");
  for (const l of links) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = l.url;
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🔗";
    const text = document.createElement("span");
    text.className = "group-link-text";
    text.textContent = l.label;
    const host = document.createElement("span");
    host.className = "visually-hidden";
    host.textContent = ` (${linkHost(l.url)}, nouvel onglet)`;
    a.append(icon, text, host);
    li.append(a);
    ul.append(li);
  }
  return ul;
}

// Un groupe repliable : en-tête (titre du projet), ses rôles et ses liens, puis la liste de ses conversations.
function projectGroup(projectId, title, convs) {
  const li = document.createElement("li");
  li.className = "group" + (projectId ? "" : " group-loose");
  li.style.setProperty("--proj", projectColor(projectId));
  const isOpen = !collapsed.has(projectId);

  const head = document.createElement("div");
  head.className = "group-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "group-toggle";
  toggle.setAttribute("aria-expanded", String(isOpen));
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = isOpen ? "▾" : "▸";
  // Logo du projet s'il en a un, sinon une pastille de sa couleur.
  const logo = projectId ? state.projects.get(projectId)?.logo : null;
  let dot;
  if (isLogo(logo)) {
    dot = document.createElement("img");
    dot.className = "group-logo";
    dot.src = logo;
    dot.alt = "";
  } else {
    dot = document.createElement("span");
    dot.className = "group-dot";
  }
  dot.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "group-title";
  name.textContent = title;
  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(convs.length);
  toggle.append(caret, dot, name, count);
  // Projet replié : ses non-lus restent visibles sur l'en-tête.
  const groupUnread = isOpen ? 0 : convs.reduce((sum, [id]) => sum + (state.unread.get(id) || 0), 0);
  if (groupUnread) toggle.append(unreadBadge(groupUnread, unreadLabel(groupUnread)));
  toggle.addEventListener("click", () => toggleCollapsed(projectId));
  toggle.dataset.focus = "group:" + projectId;
  head.append(toggle);

  // Calendrier du projet, avec le nombre d'invitations à des réunions qui attendent une réponse.
  if (projectId) {
    const pending = pendingInvitations(projectId);
    const label = `Calendrier de « ${title} »` + (pending
      ? ` : ${pending} invitation${pending > 1 ? "s" : ""} à une réunion sans réponse` : "");
    const cal = smallButton("📅", label, () => openProjectCalendar(projectId), "cal:" + projectId);
    cal.classList.add("group-cal");
    if (state.calendarProjectId === projectId) {
      cal.classList.add("active");
      cal.setAttribute("aria-current", "page");
    }
    if (pending) {
      const badge = unreadBadge(pending, "");
      badge.setAttribute("aria-hidden", "true");
      cal.append(badge);
    }
    head.append(cal);
    // Tâches du projet (todo list, historique des tâches terminées conservé), avec le nombre de tâches ouvertes.
    const tc = openTaskCount(projectId);
    const more = tc && tc.open >= COUNT_LIMIT ? " ou plus" : "";
    const tasksLabel = `Tâches de « ${title} »` + (tc?.open
      ? ` : ${tc.open}${more} ouverte${tc.open > 1 ? "s" : ""}${tc.mine ? `, dont ${tc.mine} pour toi` : ""}` : "");
    const tasksBtn = smallButton("✅", tasksLabel, () => openTasks(projectId), "tasks:" + projectId);
    tasksBtn.classList.add("group-tasks");
    if (tc?.open) {
      const badge = document.createElement("span");
      badge.className = "task-count" + (tc.mine ? " mine" : "");
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = tc.open >= COUNT_LIMIT ? `${COUNT_LIMIT}+` : String(tc.open);
      tasksBtn.append(badge);
    }
    head.append(tasksBtn);
    // Organigramme, s'il a au moins un niveau.
    if (projectOrgLevels(state.projects.get(projectId)).length) {
      const org = smallButton("🏢", `Organigramme de « ${title} »`, () => openOrgChart(projectId), "org:" + projectId);
      org.classList.add("group-org");
      head.append(org);
    }
  }

  if (state.isAdmin && projectId) {
    head.append(
      smallButton("+", `Nouvelle conversation dans « ${title} »`, () => state.admin?.newConversation(projectId), "add:" + projectId),
      smallButton("✎", `Modifier le projet « ${title} » et ses rôles`, () => state.admin?.editProject(projectId), "edit:" + projectId),
    );
  }
  li.append(head);

  if (isOpen) {
    const roles = projectId ? rolesBlock(projectId) : null;
    if (roles) li.append(roles);
    const links = projectId ? linksBlock(projectId) : null;
    if (links) li.append(links);
    const ul = document.createElement("ul");
    ul.className = "list group-items";
    const items = convs.map(([id, c]) => conversationItem(id, c));
    if (items.length === 0) items.push(emptyItem("Aucune conversation."));
    ul.replaceChildren(...items);
    li.append(ul);
  }
  return li;
}

export function renderConversationList() {
  const convs = sortedConversations();
  const byProject = new Map(); // projectId -> [[id, c], ...]
  const loose = [];
  for (const entry of convs) {
    const pid = projectOf(entry[1]);
    if (!pid) { loose.push(entry); continue; }
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(entry);
  }
  // L'admin voit aussi les projets vides.
  if (state.isAdmin) for (const pid of state.projects.keys()) if (!byProject.has(pid)) byProject.set(pid, []);

  const projects = [...byProject.keys()]
    .map((pid) => [pid, state.projects.get(pid)])
    .sort((a, b) => (a[1].title || "").localeCompare(b[1].title || "", "fr"));

  const items = projects.map(([pid, p]) => projectGroup(pid, p.title || "(sans titre)", byProject.get(pid)));

  if (projects.length === 0) {
    // Pas de projet : liste simple, comme avant.
    items.push(...loose.map(([id, c]) => conversationItem(id, c)));
    if (loose.length === 0 && state.isAdmin) items.push(emptyItem("Aucune conversation. Crée-en une."));
  } else if (loose.length > 0 || state.isAdmin) {
    items.push(projectGroup("", "Sans projet", loose));
  }
  updateList($("conv-list"), items);
}

// La liste est reconstruite à chaque changement (conversations, non-lus, projets), mais le DOM
// n'est touché que si le résultat diffère ; dans ce cas, le focus clavier est rendu à l'élément
// équivalent (même conversation, même projet).
function updateList(list, items) {
  const html = items.map((el) => el.outerHTML).join("");
  if (html === list.innerHTML) return;
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const focusKey = active && list.contains(active) ? active.dataset.focus : null;
  list.replaceChildren(...items);
  if (focusKey) list.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

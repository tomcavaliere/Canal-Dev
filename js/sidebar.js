// Barre latérale : liste des conversations, groupées par projet et triées par activité.

import { displayText } from "./names.js";
import { $ } from "./ui.js";
import { selectConversation } from "./app.js";
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

function smallButton(text, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "group-btn";
  b.textContent = text;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

// Un groupe repliable : en-tête (titre du projet) + liste de ses conversations.
function projectGroup(projectId, title, convs) {
  const li = document.createElement("li");
  li.className = "group";
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
  const name = document.createElement("span");
  name.className = "group-title";
  name.textContent = title;
  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(convs.length);
  toggle.append(caret, name, count);
  // Projet replié : ses non-lus restent visibles sur l'en-tête.
  const groupUnread = isOpen ? 0 : convs.reduce((sum, [id]) => sum + (state.unread.get(id) || 0), 0);
  if (groupUnread) toggle.append(unreadBadge(groupUnread, unreadLabel(groupUnread)));
  toggle.addEventListener("click", () => toggleCollapsed(projectId));
  head.append(toggle);

  if (state.isAdmin && projectId) {
    head.append(
      smallButton("+", `Nouvelle conversation dans « ${title} »`, () => state.admin?.newConversation(projectId)),
      smallButton("✎", `Renommer ou supprimer le projet « ${title} »`, () => state.admin?.editProject(projectId)),
    );
  }
  li.append(head);

  if (isOpen) {
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
  $("conv-list").replaceChildren(...items);
}

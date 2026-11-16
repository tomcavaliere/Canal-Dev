// Dialogue « Paramètres » (bouton ⚙️ de la barre du haut) : onglets Mon compte, Notifications,
// Apparence, Confidentialité et, pour les administrateurs, Quotas Firebase.
// Le contenu de « Mon compte », « Apparence » et « Confidentialité » est géré par account.js.

import { auth } from "./firebase.js";
import { fillAccount, setStatus } from "./account.js";
import { notificationState, pushActive, toggleNotifications } from "./notify.js";
import { isSoundEnabled, setSoundEnabled } from "./sound.js";
import { state } from "./state.js";
import { $ } from "./ui.js";

const TAB_KEY = "canal-dev.settings-tab";
const TABS = ["account", "notifications", "appearance", "privacy", "quotas"];

/** @param {string} tab */
function tabAvailable(tab) {
  return TABS.includes(tab) && (tab !== "quotas" || state.isAdmin);
}

/** @param {string} tab @param {{ focus?: boolean }} [opts] */
function selectTab(tab, { focus = false } = {}) {
  if (!tabAvailable(tab)) tab = "account";
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    const on = t === tab;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${tab}`).focus();
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignoré */ }
  if (tab === "quotas") loadQuotas();
}

/** @param {string} [tab] onglet à afficher (par défaut : le dernier consulté dans ce navigateur) */
export function openSettings(tab) {
  if (!fillAccount()) return;
  $("tab-quotas").hidden = !state.isAdmin;
  renderSoundSetting();
  renderNotifSetting();
  if (!tab) {
    try { tab = localStorage.getItem(TAB_KEY) || "account"; } catch { tab = "account"; }
  }
  selectTab(tab);
  const dlg = /** @type {HTMLDialogElement} */ ($("dlg-settings"));
  if (!dlg.open) dlg.showModal();
}

// Navigation au clavier dans la liste d'onglets (flèches, Début, Fin), comme le veut le motif ARIA.
/** @param {KeyboardEvent} e */
function onTabKey(e) {
  const visible = TABS.filter(tabAvailable);
  const current = visible.indexOf(/** @type {HTMLElement} */ (e.target).dataset.tab);
  if (current < 0) return;
  let next = -1;
  if (e.key === "ArrowRight") next = (current + 1) % visible.length;
  else if (e.key === "ArrowLeft") next = (current - 1 + visible.length) % visible.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = visible.length - 1;
  if (next < 0) return;
  e.preventDefault();
  selectTab(visible[next], { focus: true });
}

/* ---------- Notifications ---------- */

function renderSoundSetting() {
  $("set-sound").checked = isSoundEnabled();
}

const NOTIF_TEXT = {
  push: "Activées sur cet appareil, même application fermée.",
  on: "Activées tant que l'application est ouverte (ce navigateur ne permet pas les notifications application fermée).",
  off: "Coupées sur cet appareil.",
  denied: "Bloquées par le navigateur : autorise-les dans les réglages du site, puis reviens ici.",
  unsupported: "Ce navigateur n'affiche pas de notifications.",
};

// Aussi appelée par app.js une fois l'abonnement push de l'appareil vérifié.
export function renderNotifSetting() {
  const st = notificationState();
  const box = $("set-notif");
  box.checked = st === "on";
  box.disabled = st === "unsupported" || st === "denied";
  $("notif-status").textContent = NOTIF_TEXT[st === "on" && pushActive() ? "push" : st] || "";
}

async function changeNotif() {
  const box = $("set-notif");
  box.disabled = true;
  $("notif-status").textContent = "…";
  try {
    // Le clic sur la case compte comme action de l'utilisateur : le navigateur peut demander l'autorisation.
    await toggleNotifications();
  } finally {
    renderNotifSetting();
  }
}

/* ---------- Quotas Firebase (admins) ---------- */

// Fonction appelable `firebaseUsage` (functions/index.js), appelée sans le SDK Cloud Functions :
// protocole des fonctions appelables (POST {data}, réponse {result} ou {error}).
const USAGE_URL = "https://europe-west1-canal-dev-c18d7.cloudfunctions.net/firebaseUsage";
const REFRESH_MS = 60_000;
let lastLoad = 0;
let loading = false;

async function fetchUsage() {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch(USAGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data: null }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || `erreur ${res.status}`);
  return body.result;
}

/** @param {{ force?: boolean }} [opts] */
async function loadQuotas({ force = false } = {}) {
  if (!state.isAdmin || loading) return;
  if (!force && Date.now() - lastLoad < REFRESH_MS && $("quotas-body").childElementCount) return;
  loading = true;
  const btn = $("btn-quotas-refresh");
  btn.disabled = true;
  if (!$("quotas-body").childElementCount) $("quotas-body").textContent = "Chargement…";
  try {
    renderQuotas(await fetchUsage());
    lastLoad = Date.now();
  } catch (err) {
    console.error(err);
    const p = document.createElement("p");
    p.className = "error small";
    p.textContent = "Relevé impossible : " + err.message;
    $("quotas-body").replaceChildren(p);
  } finally {
    loading = false;
    btn.disabled = false;
  }
}

const nf = new Intl.NumberFormat("fr-FR");
/** @param {number} n @param {"count" | "bytes"} unit */
export function formatAmount(n, unit) {
  if (unit === "count") return nf.format(Math.round(n));
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: n < 10 && i ? 1 : 0 }).format(n)} ${units[i]}`;
}

const PERIOD = { day: "aujourd'hui", month: "ce mois-ci", now: "actuellement" };

/** @param {string} iso */
function shortDate(iso) {
  return new Date(iso).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Une ligne : libellé, valeur / quota, barre de progression et, pour Firestore, les 7 derniers jours.
function quotaRow(r) {
  const row = el("div", "quota");
  const head = el("div", "quota-head");
  head.append(el("span", "quota-label", r.label));
  const ratio = r.value == null ? null : r.value / r.limit;
  let text;
  if (r.error === "forbidden") text = "accès refusé";
  else if (r.error) text = "indisponible";
  else if (r.value == null) text = "pas encore de données";
  else text = `${formatAmount(r.value, r.unit)} / ${formatAmount(r.limit, r.unit)} ${PERIOD[r.period]}`;
  head.append(el("span", "quota-value", text));
  row.append(head);

  const bar = el("div", "quota-bar");
  const fill = el("span");
  const pct = ratio == null ? 0 : Math.min(100, ratio * 100);
  fill.style.width = `${pct > 0 ? Math.max(pct, 1) : 0}%`;
  bar.classList.add(ratio == null ? "none" : ratio >= 0.9 ? "high" : ratio >= 0.6 ? "mid" : "low");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", ratio == null ? text : `${r.label} : ${Math.round(ratio * 100)} % du quota gratuit`);
  bar.append(fill);
  row.append(bar);

  const notes = [];
  if (ratio != null) notes.push(`${ratio < 0.01 && ratio > 0 ? "< 1" : Math.round(ratio * 100)} %`);
  if (r.period === "now" && r.at) notes.push(`relevé ${shortDate(r.at)}`);
  if (notes.length) row.append(el("p", "muted small quota-note", notes.join(" · ")));

  if (Array.isArray(r.history) && r.history.length) {
    const max = Math.max(r.limit * 0.05, ...r.history);
    const hist = el("div", "quota-hist");
    hist.setAttribute("role", "img");
    const days = r.history.map((v, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (r.history.length - i));
      return { v, day: d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" }) };
    });
    hist.setAttribute("aria-label", `7 derniers jours : ${days.map((x) => `${x.day} ${nf.format(x.v)}`).join(", ")}`);
    for (const { v, day } of days) {
      const b = el("span");
      b.style.height = `${Math.max(v > 0 ? 6 : 2, (v / max) * 100)}%`;
      if (v >= r.limit * 0.9) b.className = "high";
      b.title = `${day} : ${nf.format(v)}`;
      hist.append(b);
    }
    const wrap = el("div", "quota-hist-wrap");
    wrap.append(el("span", "muted small", "7 derniers jours"), hist);
    row.append(wrap);
  }
  return row;
}

function renderQuotas(data) {
  const body = $("quotas-body");
  const frag = document.createDocumentFragment();
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const r of data.rows) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  for (const [name, rows] of groups) {
    const sec = el("section", "quota-group stack tight");
    sec.append(el("h3", null, name));
    rows.forEach((r) => sec.append(quotaRow(r)));
    frag.append(sec);
  }
  const resets = el("p", "muted small",
    `Relevé du ${shortDate(data.at)}. Quotas du jour remis à zéro le ${shortDate(data.resets.day)} ` +
    `(minuit, heure du Pacifique), quotas du mois le ${shortDate(data.resets.month)}.`);
  frag.append(resets);
  if (data.rows.some((r) => r.error === "forbidden")) {
    frag.append(el("p", "error small",
      "Accès refusé à Cloud Monitoring : donne le rôle « Lecteur Monitoring » au compte de service de la fonction (voir README)."));
  }
  body.replaceChildren(frag);
}

export function initSettings() {
  document.querySelectorAll(".btn-settings").forEach((b) => b.addEventListener("click", () => openSettings()));
  for (const t of TABS) {
    $(`tab-${t}`).addEventListener("click", () => selectTab(t));
    $(`tab-${t}`).addEventListener("keydown", onTabKey);
  }
  $("set-sound").addEventListener("change", (e) => setSoundEnabled(/** @type {HTMLInputElement} */ (e.target).checked));
  $("set-notif").addEventListener("change", changeNotif);
  $("btn-quotas-refresh").addEventListener("click", () => loadQuotas({ force: true }));
  // Le statut des actions du compte ne doit pas rester affiché d'une ouverture à l'autre.
  $("dlg-settings").addEventListener("close", () => setStatus(""));
}

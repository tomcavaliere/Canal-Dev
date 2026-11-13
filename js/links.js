// Liens attachés à une conversation : un texte choisi (« sport ») qui ouvre une adresse
// (https://www.basketusa.com/). Affichés en bas de la conversation, au-dessus de la saisie.
// Stockés dans le champ `links` de la conversation : seul l'admin les ajoute ou les retire (règles).
import { arrayRemove, arrayUnion, doc, updateDoc } from "./sdk/firebase-firestore.js";
import { confirmDialog, toast } from "./dialogs.js";
import { db } from "./firebase.js";
import { state } from "./state.js";
import { $ } from "./ui.js";

export const MAX_LINKS = 30; // même limite que firestore.rules
export const MAX_LABEL = 60;
export const MAX_PROJECT_LINKS = 20; // même limite que firestore.rules
const MAX_URL = 2000;

/**
 * Adresse saisie → adresse http(s) complète, ou null si elle n'est pas valable.
 * « www.exemple.fr » devient « https://www.exemple.fr/ ».
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  return url.href.length <= MAX_URL ? url.href : null;
}

/**
 * Liens valables d'une conversation ou d'un projet (un lien mal formé est ignoré, jamais affiché).
 * @param {any} conv
 * @returns {{ label: string, url: string }[]}
 */
export function linksOf(conv) {
  if (!Array.isArray(conv?.links)) return [];
  return conv.links.filter((l) => l && typeof l.label === "string" && typeof l.url === "string"
    && normalizeUrl(l.url) === l.url);
}

export function linkHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Barre des liens de la conversation ouverte. Visible s'il y a des liens, ou pour l'admin (bouton « + Lien »).
export function renderLinks() {
  const bar = $("chat-links");
  const conv = state.conversations.get(state.selectedId);
  const links = linksOf(conv);
  bar.hidden = !conv || (!links.length && !state.isAdmin);
  $("btn-add-link").hidden = !state.isAdmin || links.length >= MAX_LINKS;

  const items = links.map((l) => {
    const li = document.createElement("li");
    li.className = "chat-link";
    const a = document.createElement("a");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = l.label;
    a.title = l.url;
    const host = document.createElement("span");
    host.className = "visually-hidden";
    host.textContent = ` (${linkHost(l.url)}, nouvel onglet)`;
    a.append(host);
    li.append(a);
    if (state.isAdmin) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "chat-link-del";
      del.textContent = "✕";
      del.title = `Retirer le lien « ${l.label} »`;
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", () => removeLink(l));
      li.append(del);
    }
    return li;
  });
  $("links-list").replaceChildren(...items);
}

async function removeLink(link) {
  const id = state.selectedId;
  if (!id) return;
  if (!await confirmDialog(`Retirer le lien « ${link.label} » de la conversation ?`, { ok: "Retirer", danger: true })) return;
  try {
    // Le lien tel qu'il est enregistré (arrayRemove compare le contenu exact).
    const stored = state.conversations.get(id)?.links?.find((l) => l.label === link.label && l.url === link.url);
    if (stored) await updateDoc(doc(db, "conversations", id), { links: arrayRemove(stored) });
  } catch (err) {
    console.error(err);
    toast("Suppression du lien impossible : " + err.message, { error: true });
  }
}

/* ---------- Dialogue d'ajout (admin) ---------- */

function showLinkError(msg) {
  $("link-error").textContent = msg;
  $("link-error").hidden = !msg;
}

$("btn-add-link").addEventListener("click", () => {
  if (!state.isAdmin || !state.selectedId) return;
  $("form-link").reset();
  showLinkError("");
  $("dlg-link").showModal();
});

$("form-link").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = state.selectedId;
  const conv = id && state.conversations.get(id);
  if (!conv) { $("dlg-link").close(); return; }
  const label = $("link-label").value.trim().slice(0, MAX_LABEL);
  const url = normalizeUrl($("link-url").value);
  if (!label) return showLinkError("Écris le texte du lien.");
  if (!url) return showLinkError("Adresse invalide : elle doit commencer par https:// (ou http://).");
  const links = linksOf(conv);
  if (links.length >= MAX_LINKS) return showLinkError(`${MAX_LINKS} liens au plus par conversation.`);
  if (links.some((l) => l.label === label && l.url === url)) return showLinkError("Ce lien est déjà attaché.");
  const btn = $("link-submit");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "conversations", id), { links: arrayUnion({ label, url }) });
    $("dlg-link").close();
  } catch (err) {
    console.error(err);
    showLinkError("Ajout impossible : " + err.message);
  } finally {
    btn.disabled = false;
  }
});

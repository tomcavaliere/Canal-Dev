// Fichiers d'un projet (zone de dépôt) : projects/{p}/files (nom, taille, auteur, date) et
// projects/{p}/fileData (contenu, même identifiant), écrits dans le même batch (voir firestore.rules).
//   - Tout membre du projet dépose des fichiers texte (HTML, Markdown, texte, CSV, JSON, code…),
//     900 Ko au plus chacun, par glisser-déposer ou avec le sélecteur de fichiers.
//   - La liste n'écoute que les noms ; le contenu n'est lu qu'à l'ouverture d'un fichier.
//   - Affichage : le Markdown est mis en forme (markdown.js, sans HTML) ; une page HTML s'affiche dans
//     apercu.html, cadre sandbox sans allow-same-origin (aucun accès au compte ni aux données) ; le reste
//     en texte brut. Chacun peut télécharger ou copier le fichier.
//   - Un fichier ne se modifie pas : on en dépose une nouvelle version. L'auteur et l'admin le suppriment.
// La liste s'ouvre dans un dialogue (bouton 📁 d'un projet, barre latérale).
import {
  collection, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, writeBatch,
} from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { confirmDialog, toast } from "./dialogs.js";
import { displayText } from "./names.js";
import { bumpRate, rateReady, rateWait } from "./rate.js";
import { projectColor } from "./sidebar.js";
import { state } from "./state.js";
import { ensureTicket } from "./tickets.js";
import { addLog } from "./log.js";
import { renderMarkdown } from "./markdown.js";
import { $, announce } from "./ui.js";
import { syncNames } from "./app.js";

export const FILE_MAX = 900_000; // octets, identique à firestore.rules
const MAX_FILES = 200; // les règles ne bornent pas le nombre : c'est la taille de la liste écoutée
const MAX_NAME = 200;

// Extensions acceptées (identiques à firestore.rules) : type MIME au téléchargement, et affichage.
/** @type {Record<string, [string, "html" | "md" | "text"]>} */
const FILE_TYPES = {
  html: ["text/html", "html"], htm: ["text/html", "html"],
  md: ["text/markdown", "md"], markdown: ["text/markdown", "md"],
  txt: ["text/plain", "text"], log: ["text/plain", "text"],
  csv: ["text/csv", "text"], tsv: ["text/tab-separated-values", "text"],
  json: ["application/json", "text"], xml: ["application/xml", "text"],
  yaml: ["application/yaml", "text"], yml: ["application/yaml", "text"],
  css: ["text/css", "text"], js: ["text/javascript", "text"], ts: ["text/plain", "text"],
  py: ["text/x-python", "text"], sql: ["application/sql", "text"], sh: ["text/x-shellscript", "text"],
};
const ICONS = { html: "🌐", md: "📝", text: "📄" };
$("files-input").accept = Object.keys(FILE_TYPES).map((e) => "." + e).join(",");

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
const typeOf = (name) => FILE_TYPES[extOf(name)] ?? null;

const whenFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const me = () => state.user?.uid ?? "";
const who = (uid) => (uid === me() ? "toi" : displayText(uid));
const canManage = (owner) => state.isAdmin || owner === me();
const toDate = (ts) => ts?.toDate?.() ?? null;

/** @param {number} n octets */
export function formatSize(n) {
  if (n < 1000) return `${n} o`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} Ko`;
  return `${(n / 1_000_000).toFixed(1).replace(".", ",")} Mo`;
}

/** @type {string | null} projet dont la liste est ouverte */
let pid = null;
/** @type {Map<string, any>} id -> nom, taille, auteur, date */
let files = new Map();
let unsub = /** @type {null | (() => void)} */ (null);
let uploading = false;

function showError(msg) {
  $("files-error").textContent = msg;
  $("files-error").hidden = !msg;
}

function stop() {
  unsub?.();
  unsub = null;
}

/**
 * Ouvre la zone de dépôt d'un projet.
 * @param {string} projectId
 */
export async function openFiles(projectId) {
  if (!state.projects.get(projectId)) return;
  const dlg = $("dlg-files");
  if (pid !== projectId) {
    stop();
    pid = projectId;
    files = new Map();
    showError("");
    $("files-status").textContent = "";
  }
  render();
  if (!dlg.open) dlg.showModal();
  if (unsub) return;

  const ok = await ensureTicket(projectId);
  if (pid !== projectId || unsub) return;
  if (!ok) {
    showError("Accès aux fichiers impossible pour le moment : réessaie dans un instant.");
    return;
  }
  unsub = onSnapshot(
    query(collection(db, "projects", projectId, "files"), orderBy("createdAt", "desc"), limit(MAX_FILES)),
    (snap) => {
      files = new Map(snap.docs.map((d) => [d.id, d.data({ serverTimestamps: "estimate" })]));
      if (!uploading) showError("");
      syncNames();
      render();
      renderView();
    },
    (err) => {
      console.error("Lecture des fichiers impossible", err);
      showError("Lecture des fichiers impossible : " + (err.code === "permission-denied"
        ? "tu n'as plus accès à ce projet." : err.message));
    },
  );
}

$("dlg-files").addEventListener("close", () => {
  stop();
  pid = null;
  files = new Map();
  if ($("dlg-file-view").open) $("dlg-file-view").close();
});

// Personnes à suivre dans l'annuaire des noms (app.js, syncNames) : auteurs des fichiers.
export function fileUids() {
  const uids = new Set();
  for (const f of files.values()) if (typeof f.createdBy === "string") uids.add(f.createdBy);
  return uids;
}

// Projet, noms ou accès modifiés : réaffiche la liste ouverte, ou la ferme si le projet a disparu.
export function renderFiles() {
  if (!pid) return;
  const mine = [...state.conversations.values()].some((c) => c.projectId === pid);
  if (!state.projects.get(pid) || (!state.isAdmin && !mine)) {
    $("dlg-files").close();
    return;
  }
  render();
  renderView();
}

// Fermeture à la déconnexion.
export function teardownFiles() {
  if ($("dlg-files").open) $("dlg-files").close();
  pid = null;
  stop();
  files = new Map();
}

/* ---------- Liste ---------- */

/** @returns {boolean} données d'un fichier utilisables (jamais supposées bien formées) */
const valid = (f) => typeof f?.name === "string" && f.name !== "" && typeOf(f.name) !== null;

function metaText(f) {
  const d = toDate(f.createdAt);
  return [
    typeof f.size === "number" ? formatSize(f.size) : "",
    typeof f.createdBy === "string" ? `déposé par ${who(f.createdBy)}` + (d ? " le " + whenFmt.format(d) : "") : "",
  ].filter(Boolean).join(" · ");
}

function render() {
  if (!pid) return;
  const p = state.projects.get(pid);
  $("dlg-files").style.setProperty("--proj", projectColor(pid));
  $("files-title").textContent = `Fichiers de « ${p?.title || "(sans titre)"} »`;
  const list = [...files.entries()].filter(([, f]) => valid(f));
  $("files-count").textContent = list.length ? String(list.length) : "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = unsub ? "Aucun fichier pour l'instant." : "Chargement…";
    $("files-list").replaceChildren(li);
    return;
  }
  $("files-list").replaceChildren(...list.map(([id, f]) => fileItem(id, f)));
}

function fileItem(id, f) {
  const li = document.createElement("li");
  li.className = "file";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "file-open";
  open.title = `Ouvrir « ${f.name} »`;
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ICONS[typeOf(f.name)[1]];
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = f.name;
  const meta = document.createElement("span");
  meta.className = "file-meta muted small";
  meta.textContent = metaText(f);
  open.append(icon, name, meta);
  open.addEventListener("click", () => openFile(id));
  li.append(open);
  if (canManage(f.createdBy)) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "file-delete";
    del.textContent = "✕";
    del.title = `Supprimer « ${f.name} »`;
    del.setAttribute("aria-label", del.title);
    del.addEventListener("click", () => removeFile(id));
    li.append(del);
  }
  return li;
}

/* ---------- Dépôt ---------- */

/**
 * Dépose un fichier. Renvoie le motif du refus, ou null s'il est enregistré.
 * @param {string} projectId
 * @param {File} file
 * @returns {Promise<string | null>}
 */
async function uploadOne(projectId, file) {
  const name = file.name.trim();
  if (!name) return "nom vide.";
  if (name.length > MAX_NAME) return `nom trop long (${MAX_NAME} caractères au plus).`;
  if (/[/\\]/.test(name)) return "nom invalide.";
  if (!typeOf(name)) return "type non accepté (HTML, Markdown, texte, CSV, JSON, code…).";
  if (file.size > FILE_MAX) return `trop lourd (${formatSize(file.size)}, ${formatSize(FILE_MAX)} au plus).`;
  if (files.size >= MAX_FILES) return `${MAX_FILES} fichiers au plus par projet : supprimes-en d'abord.`;
  let text;
  try {
    // Le texte doit être de l'UTF-8 valide (sinon c'est un fichier binaire mal nommé).
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return "ce n'est pas un fichier texte (UTF-8).";
  }
  await rateReady();
  const wait = rateWait();
  if (wait) return `trop d'envois en une minute : réessaie dans ${wait} s.`;
  try {
    const ref = doc(collection(db, "projects", projectId, "files"));
    const batch = writeBatch(db);
    batch.set(ref, { name, size: file.size, createdBy: me(), createdAt: serverTimestamp() });
    batch.set(doc(db, "projects", projectId, "fileData", ref.id), { text, createdBy: me(), createdAt: serverTimestamp() });
    addLog(batch, "file.create", { projectId, label: name });
    bumpRate(batch);
    await batch.commit();
    return null;
  } catch (err) {
    console.error(err);
    return err.code === "permission-denied" ? "refusé (accès au projet perdu ?)." : err.message;
  }
}

/** @param {FileList | File[]} list */
async function upload(list) {
  const projectId = pid;
  const todo = [...list];
  if (!projectId || !todo.length || uploading) return;
  if (!unsub) return showError("Les fichiers ne sont pas encore chargés : réessaie dans un instant.");
  uploading = true;
  $("files-drop").classList.add("busy");
  showError("");
  const errors = [];
  let added = 0;
  for (const [k, file] of todo.entries()) {
    if (pid !== projectId) break;
    $("files-status").textContent = todo.length > 1 ? `Envoi ${k + 1} / ${todo.length} : ${file.name}…` : `Envoi de ${file.name}…`;
    const err = await uploadOne(projectId, file);
    if (err) errors.push(`${file.name} : ${err}`);
    else added++;
  }
  uploading = false;
  $("files-drop").classList.remove("busy");
  if (pid !== projectId) return;
  $("files-status").textContent = added ? `${added} fichier${added > 1 ? "s" : ""} déposé${added > 1 ? "s" : ""}.` : "";
  showError(errors.join("\n"));
  if (added) announce($("files-status").textContent);
}

$("files-input").addEventListener("change", () => {
  const input = /** @type {HTMLInputElement} */ ($("files-input"));
  const list = [...(input.files ?? [])];
  input.value = ""; // le même fichier pourra être redéposé
  upload(list);
});

// Glisser-déposer : sur tout le dialogue (la zone s'allume), pour qu'un fichier lâché à côté ne
// soit pas ouvert par le navigateur à la place de l'application.
{
  const dlg = $("dlg-files");
  const zone = $("files-drop");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  dlg.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add("over");
  });
  dlg.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  dlg.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove("over");
  });
  dlg.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove("over");
    upload([...(e.dataTransfer?.files ?? [])]);
  });
}

/* ---------- Suppression ---------- */

async function removeFile(id) {
  const projectId = pid;
  const f = files.get(id);
  if (!projectId || !f || !canManage(f.createdBy)) return;
  if (!await confirmDialog(`Supprimer le fichier « ${f.name} » ?`, { ok: "Supprimer", danger: true })) return;
  await rateReady();
  const wait = rateWait();
  if (wait) return toast(`Trop de modifications en une minute : réessaie dans ${wait} s.`, { error: true });
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "projects", projectId, "files", id));
    batch.delete(doc(db, "projects", projectId, "fileData", id)); // son contenu part avec lui
    addLog(batch, "file.delete", { projectId, label: f.name });
    bumpRate(batch);
    await batch.commit();
    if (viewId === id && $("dlg-file-view").open) $("dlg-file-view").close();
    announce("Fichier supprimé.");
  } catch (err) {
    console.error(err);
    toast("Suppression impossible : " + err.message, { error: true });
  }
}

/* ---------- Ouverture d'un fichier ---------- */

/** @type {string | null} fichier affiché */
let viewId = null;
/** @type {string | null} son contenu (null tant qu'il n'est pas chargé) */
let viewText = null;
let showSource = false;
/** @type {HTMLIFrameElement | null} aperçu HTML en cours */
let frame = null;
let frameSent = false;

async function openFile(id) {
  const projectId = pid;
  const f = files.get(id);
  if (!projectId || !valid(f)) return;
  viewId = id;
  viewText = null;
  showSource = false;
  renderView();
  $("dlg-file-view").showModal();
  try {
    const snap = await getDoc(doc(db, "projects", projectId, "fileData", id));
    if (viewId !== id || !$("dlg-file-view").open) return;
    const text = snap.exists() ? snap.data().text : null;
    if (typeof text !== "string") return viewMessage("Contenu introuvable : le fichier a peut-être été supprimé.");
    viewText = text;
    renderView();
  } catch (err) {
    if (viewId !== id) return;
    console.error(err);
    viewMessage("Lecture impossible : " + err.message);
  }
}

function viewMessage(text) {
  const p = document.createElement("p");
  p.className = "muted file-view-msg";
  p.textContent = text;
  frame = null;
  $("file-view-body").replaceChildren(p);
}

// En-tête (nom, auteur, boutons) et contenu du fichier ouvert. Le contenu n'est refait que s'il change :
// un aperçu HTML n'est pas rechargé quand la liste ou les noms changent.
function renderView() {
  if (!viewId || !$("dlg-file-view").open) return;
  const f = files.get(viewId);
  if (!valid(f)) {
    $("dlg-file-view").close();
    toast("Ce fichier a été supprimé.");
    return;
  }
  const kind = typeOf(f.name)[1];
  $("file-view-title").textContent = f.name;
  $("file-view-meta").textContent = metaText(f);
  $("file-view-delete").hidden = !canManage(f.createdBy);
  const source = $("file-view-source");
  source.hidden = kind === "text";
  source.textContent = showSource ? "Aperçu" : "Source";
  source.setAttribute("aria-pressed", String(showSource));
  for (const b of ["file-view-copy", "file-view-download", "file-view-source"]) $(b).disabled = viewText === null;

  const body = $("file-view-body");
  const mode = viewText === null ? "loading" : showSource || kind === "text" ? "text" : kind;
  if (body.dataset.mode === mode && body.dataset.file === viewId) return;
  body.dataset.mode = mode;
  body.dataset.file = viewId;
  body.className = "file-view-body " + mode;
  frame = null;
  if (mode === "loading") return viewMessage("Chargement…");
  if (mode === "text") {
    const pre = document.createElement("pre");
    pre.className = "file-text";
    pre.textContent = viewText;
    body.replaceChildren(pre);
  } else if (mode === "md") {
    const div = document.createElement("div");
    div.className = "md-body";
    div.append(renderMarkdown(viewText));
    body.replaceChildren(div);
  } else {
    // Page HTML : cadre isolé (origine opaque). apercu.html annonce qu'il est prêt, puis reçoit la page.
    frame = document.createElement("iframe");
    frame.className = "file-frame";
    frame.title = `Aperçu de « ${f.name} »`;
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frameSent = false;
    frame.src = "apercu.html";
    body.replaceChildren(frame);
  }
}

window.addEventListener("message", (e) => {
  if (!frame || frameSent || e.source !== frame.contentWindow || e.data !== "apercu-pret" || viewText === null) return;
  frameSent = true; // une seule fois : la page affichée pourrait renvoyer le même message
  frame.contentWindow.postMessage({ html: viewText }, "*");
});

$("dlg-file-view").addEventListener("close", () => {
  viewId = null;
  viewText = null;
  frame = null;
  const body = $("file-view-body");
  body.replaceChildren();
  delete body.dataset.mode;
  delete body.dataset.file;
});

$("file-view-source").addEventListener("click", () => {
  showSource = !showSource;
  renderView();
});

$("file-view-copy").addEventListener("click", async () => {
  if (viewText === null) return;
  try {
    await navigator.clipboard.writeText(viewText);
    toast("Contenu copié.");
  } catch {
    toast("Copie impossible : utilise « Télécharger ».", { error: true });
  }
});

$("file-view-download").addEventListener("click", () => {
  const f = viewId && files.get(viewId);
  if (!valid(f) || viewText === null) return;
  const url = URL.createObjectURL(new Blob([viewText], { type: typeOf(f.name)[0] + ";charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

$("file-view-delete").addEventListener("click", () => {
  if (viewId) removeFile(viewId);
});

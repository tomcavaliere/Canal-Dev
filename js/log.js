// Journal d'activité (logs/{id}) : une entrée par action (création d'un projet, ajout d'un membre,
// tâche cochée…). Écrite dans le même batch que l'action quand c'est possible, pour qu'il n'y ait
// d'entrée que si l'action a réussi. Les règles imposent l'auteur et l'heure du serveur, et réservent
// la lecture aux admins (voir firestore.rules). Conservation : 12 mois.
import {
  collection, doc, getDocs, limit, orderBy, query, serverTimestamp, startAfter, Timestamp, where, writeBatch,
} from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { state } from "./state.js";
import { nameOf } from "./names.js";
import { $ } from "./ui.js";

// Durée de conservation des entrées (voir confidentialite.html).
export const LOG_RETENTION_MS = 365 * 24 * 3600 * 1000;
const PAGE = 50;
const MAX_LABEL = 200;

/**
 * @typedef {{ projectId?: string, convId?: string, about?: string, label?: string }} LogFields
 */

/**
 * Ajoute l'entrée au batch de l'action. Pour un membre (non admin), le batch doit aussi
 * mettre à jour son compteur anti-abus (bumpRate) : les règles l'exigent.
 * @param {import("./sdk/firebase-firestore.js").WriteBatch} batch
 * @param {string} action « objet.verbe », par exemple "task.create"
 * @param {LogFields} [fields]
 */
export function addLog(batch, action, fields = {}) {
  /** @type {Record<string, unknown>} */
  const data = { action, uid: state.user.uid, at: serverTimestamp() };
  for (const key of /** @type {const} */ (["projectId", "convId", "about"])) {
    if (fields[key]) data[key] = fields[key];
  }
  if (fields.label) data.label = String(fields.label).slice(0, MAX_LABEL);
  batch.set(doc(collection(db, "logs")), data);
}

/**
 * Journalise une action d'admin déjà faite (écritures hors batch). L'échec n'interrompt rien.
 * @param {string} action
 * @param {LogFields} [fields]
 */
export function log(action, fields = {}) {
  const batch = writeBatch(db);
  addLog(batch, action, fields);
  batch.commit().catch((err) => console.error("Journal : entrée impossible", action, err));
}

/* ---------- Conservation ---------- */

// Supprime les entrées de plus de 12 mois (admin, à l'ouverture de l'application).
export async function purgeOldLogs() {
  const cutoff = Timestamp.fromMillis(Date.now() - LOG_RETENTION_MS);
  const q = query(collection(db, "logs"), where("at", "<", cutoff), limit(400));
  try {
    for (;;) {
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) {
    console.error("Purge du journal impossible", err);
  }
}

/* ---------- Affichage (admin) ---------- */

const timeFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

// Nom d'une personne : annuaire, sinon « quelqu'un » (compte supprimé depuis).
const who = (uid) => (uid && nameOf(uid)) || "un ancien membre";
const quoted = (s) => `« ${s || "sans titre"} »`;

/**
 * Phrase décrivant l'entrée (après le nom de son auteur).
 * @param {Record<string, any>} e
 * @param {(id: string) => string} projectTitle
 */
function describe(e, projectTitle) {
  const l = quoted(e.label);
  const p = e.projectId ? quoted(projectTitle(e.projectId)) : "";
  switch (e.action) {
    case "project.create": return `a créé le projet ${l}`;
    case "project.update": return `a modifié le projet ${l}`;
    case "project.delete": return `a supprimé le projet ${l}`;
    case "conv.create": return `a créé la conversation ${l}` + (p ? ` dans le projet ${p}` : "");
    case "conv.update": return `a renommé la conversation ${l}`;
    case "conv.move": return `a déplacé la conversation ${l} ` + (p ? `dans le projet ${p}` : "hors projet");
    case "conv.delete": return `a supprimé la conversation ${l}`;
    case "member.add": return `a ajouté ${who(e.about)} à la conversation ${l}`;
    case "member.remove": return `a retiré ${who(e.about)} de la conversation ${l}`;
    case "invite.create": return `a invité ${l}`;
    case "invite.update": return `a modifié l'invitation de ${l}`;
    case "invite.delete": return `a annulé l'invitation de ${l}`;
    case "name.update": return `a changé le nom affiché de ${who(e.about)} en ${l}`;
    case "admin.grant": return `a donné les droits d'administration à ${who(e.about)}`;
    case "admin.revoke": return `a retiré les droits d'administration de ${who(e.about)}`;
    case "user.delete": return "a supprimé un compte utilisateur et ses données";
    case "link.create": return `a ajouté le lien ${l} à une conversation`;
    case "link.delete": return `a retiré le lien ${l} d'une conversation`;
    case "pin.create": return `a épinglé un message dans ${l}`;
    case "pin.delete": return `a retiré une épingle dans ${l}`;
    case "task.create": return `a ajouté la tâche ${l}`;
    case "task.update": return `a modifié la tâche ${l}`;
    case "task.done": return `a terminé la tâche ${l}`;
    case "task.reopen": return `a rouvert la tâche ${l}`;
    case "task.assign":
      if (!e.about) return `a retiré le responsable de la tâche ${l}`;
      return e.about === e.uid ? `s'occupe de la tâche ${l}` : `a confié la tâche ${l} à ${who(e.about)}`;
    case "task.delete": return `a supprimé la tâche ${l}`;
    case "goal.create": return `a ajouté l'objectif ${l}`;
    case "goal.update": return `a modifié l'objectif ${l}`;
    case "goal.done": return `a atteint l'objectif ${l}`;
    case "goal.reopen": return `a rouvert l'objectif ${l}`;
    case "goal.delete": return `a supprimé l'objectif ${l}`;
    case "event.create": return `a créé la réunion ${l}`;
    case "event.update": return `a modifié la réunion ${l}`;
    case "event.delete": return `a supprimé la réunion ${l}`;
    default: return `${e.action} ${l}`;
  }
}

/**
 * Branche le dialogue « Journal » (admin). Renvoie la fonction qui le détache.
 * @param {{ getProjects: () => Map<string, any> }} opts
 */
export function setupLogView({ getProjects }) {
  const dlg = /** @type {HTMLDialogElement} */ ($("dlg-logs"));
  const select = /** @type {HTMLSelectElement} */ ($("logs-project"));
  /** @type {import("./sdk/firebase-firestore.js").QueryDocumentSnapshot | null} */
  let last = null;
  let loading = 0; // numéro du dernier chargement : un changement de filtre annule le précédent

  const projectTitle = (id) => getProjects().get(id)?.title || "projet supprimé";

  function fillProjects() {
    const opts = [...getProjects().entries()]
      .filter(([, p]) => p)
      .sort((a, b) => (a[1].title || "").localeCompare(b[1].title || "", "fr"))
      .map(([id, p]) => new Option(p.title || "(sans titre)", id));
    const keep = select.value;
    select.replaceChildren(new Option("Tous les projets", ""), ...opts);
    select.value = getProjects().has(keep) ? keep : "";
  }

  function row(e) {
    const li = document.createElement("li");
    li.className = "log-row";
    const at = e.at?.toDate?.();
    const time = document.createElement("time");
    time.className = "muted small";
    if (at) {
      time.dateTime = at.toISOString();
      time.textContent = timeFmt.format(at);
    }
    const text = document.createElement("span");
    const author = document.createElement("strong");
    author.textContent = who(e.uid);
    text.append(author, " " + describe(e, projectTitle));
    if (e.projectId && !e.action.startsWith("project.") && !e.action.startsWith("conv.") && !select.value) {
      const proj = document.createElement("span");
      proj.className = "muted small";
      proj.textContent = ` — ${projectTitle(e.projectId)}`;
      text.append(proj);
    }
    li.append(time, text);
    return li;
  }

  async function load(more = false) {
    const run = ++loading;
    $("logs-error").hidden = true;
    $("btn-logs-more").disabled = true;
    if (!more) {
      last = null;
      $("logs-list").replaceChildren();
    }
    const filters = [
      ...(select.value ? [where("projectId", "==", select.value)] : []),
      orderBy("at", "desc"),
      ...(last ? [startAfter(last)] : []),
      limit(PAGE),
    ];
    try {
      const snap = await getDocs(query(collection(db, "logs"), ...filters));
      if (run !== loading) return;
      last = snap.docs.at(-1) ?? last;
      $("logs-list").append(...snap.docs.map((d) => row(d.data())));
      $("btn-logs-more").hidden = snap.size < PAGE;
      $("logs-empty").hidden = $("logs-list").childElementCount > 0;
    } catch (err) {
      if (run !== loading) return;
      console.error(err);
      $("logs-error").textContent = "Lecture du journal impossible : " + err.message;
      $("logs-error").hidden = false;
    } finally {
      if (run === loading) $("btn-logs-more").disabled = false;
    }
  }

  const open = () => {
    fillProjects();
    dlg.showModal();
    load();
  };
  const onChange = () => load();
  const onMore = () => load(true);
  $("btn-logs").addEventListener("click", open);
  select.addEventListener("change", onChange);
  $("btn-logs-more").addEventListener("click", onMore);
  return () => {
    $("btn-logs").removeEventListener("click", open);
    select.removeEventListener("change", onChange);
    $("btn-logs-more").removeEventListener("click", onMore);
    if (dlg.open) dlg.close();
    $("logs-list").replaceChildren();
  };
}

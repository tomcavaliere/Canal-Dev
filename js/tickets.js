// Fiches de membre des projets (projects/{p}/members/{uid}) : elles ouvrent l'accès au calendrier
// du projet et forment la liste des personnes invitables à une réunion. Chaque fiche nomme une
// conversation du projet dont la personne est membre (`via`) ; les règles la revérifient à chaque
// accès (voir firestore.rules, isProjectMember).
//   - Chacun écrit la sienne dès qu'il voit une conversation d'un projet.
//   - L'admin les tient à jour pour tout le monde : il crée celles qui manquent (membres qui n'ont
//     pas encore ouvert l'application) et supprime celles des personnes retirées.
import {
  collection, doc, getDoc, getDocs, serverTimestamp, writeBatch,
} from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";
import { bumpRate, rateReady, rateWait } from "./rate.js";
import { state } from "./state.js";

const ensured = new Map(); // projet -> conversation de sa fiche, vérifiée dans cette session
const inflight = new Map(); // projet -> Promise<boolean>

/**
 * Conversations de l'utilisateur, par projet, triées (la fiche nomme toujours la même).
 * @returns {Map<string, string[]>}
 */
function myConvsByProject() {
  const map = new Map();
  for (const [id, c] of state.conversations) {
    if (typeof c.projectId !== "string" || !c.projectId) continue;
    if (!state.isAdmin && !c.members?.includes(state.user?.uid)) continue;
    if (!map.has(c.projectId)) map.set(c.projectId, []);
    map.get(c.projectId).push(id);
  }
  for (const ids of map.values()) ids.sort();
  return map;
}

/**
 * Vérifie (et au besoin écrit) sa propre fiche du projet. L'admin n'en a pas besoin.
 * @param {string} projectId
 * @returns {Promise<boolean>} true si l'accès au calendrier est ouvert
 */
export function ensureTicket(projectId) {
  if (state.isAdmin) return Promise.resolve(true);
  const uid = state.user?.uid;
  const convs = myConvsByProject().get(projectId) || [];
  if (!uid || !convs.length) return Promise.resolve(false);
  if (convs.includes(ensured.get(projectId))) return Promise.resolve(true);
  if (inflight.has(projectId)) return inflight.get(projectId);

  const run = (async () => {
    const ref = doc(db, "projects", projectId, "members", uid);
    const snap = await getDoc(ref);
    const via = snap.exists() ? snap.data().via : null;
    if (convs.includes(via)) {
      ensured.set(projectId, via);
      return true;
    }
    await rateReady();
    if (rateWait()) return false; // réessayé au prochain changement des conversations
    const batch = writeBatch(db);
    batch.set(ref, { uid, via: convs[0], at: serverTimestamp() });
    bumpRate(batch);
    await batch.commit();
    ensured.set(projectId, convs[0]);
    return true;
  })().catch((err) => {
    console.warn("Fiche de membre du projet non enregistrée", projectId, err);
    return false;
  }).finally(() => inflight.delete(projectId));
  inflight.set(projectId, run);
  return run;
}

// Non-admin : sa fiche dans chacun de ses projets (appelé à chaque changement des conversations).
export function syncMyTickets() {
  if (state.isAdmin || !state.user) return;
  for (const pid of myConvsByProject().keys()) ensureTicket(pid);
}

export function resetTickets() {
  ensured.clear();
  inflight.clear();
  adminSig = "";
}

/* ---------- Admin : fiches de tous les membres ---------- */

let adminSig = "";
let adminRun = Promise.resolve();

// Appelé quand les conversations ou les projets changent. Ne relit les fiches que si les membres
// d'un projet ont changé (pas à chaque nouveau message).
export function adminSyncTickets() {
  if (!state.isAdmin || !state.convsLoaded || !state.projectsLoaded) return;
  /** @type {Map<string, Map<string, string[]>>} projet -> uid -> conversations du projet dont il est membre */
  const expected = new Map();
  for (const pid of state.projects.keys()) expected.set(pid, new Map());
  for (const [id, c] of [...state.conversations].sort((a, b) => a[0].localeCompare(b[0]))) {
    const members = expected.get(c.projectId);
    if (!members) continue;
    for (const uid of c.members || []) {
      if (typeof uid !== "string" || !uid || uid.includes("/")) continue;
      if (!members.has(uid)) members.set(uid, []);
      members.get(uid).push(id);
    }
  }
  const sig = JSON.stringify([...expected].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([pid, m]) => [pid, [...m].sort((a, b) => a[0].localeCompare(b[0]))]));
  if (sig === adminSig) return;
  adminSig = sig;
  const session = state.user;
  adminRun = adminRun
    .then(() => (state.user === session ? writeAllTickets(expected) : null))
    .catch((err) => {
      console.error("Mise à jour des membres des projets impossible", err);
      adminSig = ""; // nouvel essai au prochain changement
    });
}

/** @param {Map<string, Map<string, string[]>>} expected */
async function writeAllTickets(expected) {
  for (const [pid, members] of expected) {
    const snap = await getDocs(collection(db, "projects", pid, "members"));
    /** @type {((b: import("./sdk/firebase-firestore.js").WriteBatch) => void)[]} */
    const ops = [];
    const seen = new Set();
    for (const d of snap.docs) {
      const convs = members.get(d.id);
      seen.add(d.id);
      if (!convs) ops.push((b) => b.delete(d.ref));
      else if (!convs.includes(d.data().via)) ops.push((b) => b.set(d.ref, { uid: d.id, via: convs[0], at: serverTimestamp() }));
    }
    for (const [uid, convs] of members) {
      if (seen.has(uid)) continue;
      ops.push((b) => b.set(doc(db, "projects", pid, "members", uid), { uid, via: convs[0], at: serverTimestamp() }));
    }
    // Petits lots : chaque fiche fait lire sa conversation aux règles (20 lectures au plus par lot).
    for (let i = 0; i < ops.length; i += 10) {
      const batch = writeBatch(db);
      ops.slice(i, i + 10).forEach((op) => op(batch));
      await batch.commit();
    }
  }
}

/**
 * Admin : supprime les fiches, réunions et objectifs d'un projet (avant de supprimer le projet).
 * @param {string} projectId
 */
export async function deleteProjectCalendar(projectId) {
  for (const sub of ["events", "goals", "members"]) {
    const snap = await getDocs(collection(db, "projects", projectId, sub));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

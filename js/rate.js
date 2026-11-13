// Compteur anti-abus rate/{uid} : chaque envoi ou modification de message le met à jour dans le
// même batch (les règles l'exigent) ; au plus RATE_MAX écritures par fenêtre d'une minute.
// L'écoute de son propre compteur permet de prévenir avant que le serveur ne refuse.
import { doc, increment, onSnapshot, serverTimestamp } from "./sdk/firebase-firestore.js";
import { db } from "./firebase.js";

const RATE_MAX = 30;
const WINDOW_MS = 60_000;
const MARGIN_MS = 2_000; // horloge du navigateur un peu en avance sur celle du serveur

/** @type {{ windowStart: number, count: number } | null | undefined} undefined : pas encore lu */
let current;
let unsub = null;
let uid = null;
let ready = Promise.resolve();

/** @param {string} userId */
export function listenRate(userId) {
  stopRate();
  uid = userId;
  current = undefined;
  let resolve;
  ready = new Promise((r) => { resolve = r; });
  unsub = onSnapshot(doc(db, "rate", userId), (snap) => {
    const d = snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : null;
    current = d ? { windowStart: d.windowStart?.toMillis?.() ?? 0, count: d.count ?? 0 } : null;
    resolve();
  }, (err) => {
    console.error("Lecture du compteur d'envois impossible", err);
    current = null;
    resolve();
  });
}

export function stopRate() {
  unsub?.();
  unsub = null;
  uid = null;
  current = undefined;
}

// Attendre la première lecture du compteur (quasi immédiate) avant le premier envoi.
export function rateReady() {
  return ready;
}

/**
 * Secondes à attendre avant de pouvoir écrire à nouveau (0 : possible tout de suite).
 * @returns {number}
 */
export function rateWait() {
  if (!current || current.count < RATE_MAX) return 0;
  const left = current.windowStart + WINDOW_MS + MARGIN_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Ajoute la mise à jour du compteur au batch.
 * @param {import("./sdk/firebase-firestore.js").WriteBatch} batch
 */
export function bumpRate(batch) {
  const ref = doc(db, "rate", uid);
  if (current && current.count < RATE_MAX) {
    // Fenêtre en cours (même expirée côté serveur : un incrément sous la limite reste accepté).
    batch.update(ref, { count: increment(1), at: serverTimestamp() });
  } else {
    // Pas encore de compteur, ou limite atteinte et minute écoulée : nouvelle fenêtre.
    batch.set(ref, { windowStart: serverTimestamp(), count: 1, at: serverTimestamp() });
  }
}

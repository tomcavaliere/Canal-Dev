// Initialisation partagée de Firebase (importée par app.js et admin.js).
import { initializeApp } from "./sdk/firebase-app.js";
import { getAuth } from "./sdk/firebase-auth.js";
import { getFirestore } from "./sdk/firebase-firestore.js";
import { firebaseConfig, ADMIN_UID } from "./firebase-config.js";

export const isConfigured = !String(firebaseConfig.apiKey).startsWith("REMPLACER");

export const app = isConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export { ADMIN_UID };

export const GMAIL_RE = /@gmail\.com$/i;

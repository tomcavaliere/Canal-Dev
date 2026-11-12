// Initialisation partagée de Firebase (importée par app.js et admin.js).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_UID } from "./firebase-config.js?v=9";

export const isConfigured = !String(firebaseConfig.apiKey).startsWith("REMPLACER");

export const app = isConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export { ADMIN_UID };

export const GMAIL_RE = /@gmail\.com$/i;

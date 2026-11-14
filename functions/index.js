// Cloud Functions de Canal Dev.
//
// Notifications push : à chaque nouveau message, une notification est envoyée aux appareils des
// autres membres de la conversation (et des administrateurs, qui voient toutes les conversations),
// même quand l'application est fermée. Protocole Web Push standard (clés VAPID), sans SDK côté site :
// chaque appareil s'abonne avec PushManager et enregistre son abonnement dans users/{uid}/push/{id}.
// Le contenu est chiffré de bout en bout pour l'appareil (RFC 8291) : le service de push du
// navigateur (Google, Mozilla, Apple, Microsoft) ne le lit pas.

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import webpush from "web-push";
import { excerpt, PUSH_ENDPOINT_RE, recipientsOf } from "./push-utils.js";

// Base Firestore en multirégion « eur3 » : fonctions en Europe (Belgique).
// maxInstances : garde-fou contre une facture inattendue (boucle, rafale de messages).
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

initializeApp();
const db = getFirestore();

// Identiques à ADMIN_UID et VAPID_PUBLIC_KEY dans js/firebase-config.js (vérifié par les tests).
const ADMIN_UID = "WcAMpEXuhYbQjgeUnIsyMxJsO5f1";
const VAPID_PUBLIC_KEY = "BGIfDsUMg9u-DlSvdSZZw_X9j586Bf45DJdojiN4a6Z4KBux9iyvPhHOXkQBm4cep8uFBlKBGheZWVJ9UM-OixU";
// Clé privée : secret Cloud Secret Manager, jamais dans le dépôt
// (`npx firebase functions:secrets:set VAPID_PRIVATE_KEY`, voir README).
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");
// Contact exigé par le protocole VAPID : l'adresse du site (pas d'adresse e-mail).
const VAPID_SUBJECT = "https://canal-dev-c18d7.web.app";

// Abonnements lus par destinataire (les plus récents) : quelques appareils par personne suffisent.
const MAX_DEVICES = 10;

async function adminUids() {
  const snap = await db.collection("admins").select().get();
  return [ADMIN_UID, ...snap.docs.map((d) => d.id)];
}

// Nom de l'auteur : l'annuaire tenu par l'admin fait foi ; à défaut, le nom saisi (non vérifié).
async function authorLabel(m) {
  const n = await db.doc(`names/${m.authorUid}`).get();
  const name = n.get("name");
  if (typeof name === "string" && name) return name;
  const claimed = typeof m.authorName === "string" && m.authorName ? m.authorName : "?";
  return m.authorUid === ADMIN_UID ? claimed : `${claimed} (non vérifié)`;
}

async function sendTo(uid, payload, topic) {
  const subs = await db.collection(`users/${uid}/push`).orderBy("updatedAt", "desc").limit(MAX_DEVICES).get();
  await Promise.all(subs.docs.map(async (d) => {
    const { endpoint, p256dh, auth } = d.data();
    if (typeof endpoint !== "string" || !PUSH_ENDPOINT_RE.test(endpoint)) {
      await d.ref.delete();
      return;
    }
    try {
      await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, payload, {
        vapidDetails: { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY.value() },
        TTL: 24 * 3600, // non distribuée au-delà d'un jour (appareil éteint)
        urgency: "normal",
        topic, // une seule notification en attente par conversation
      });
    } catch (err) {
      // Abonnement expiré ou retiré par le navigateur : on l'oublie.
      if (err?.statusCode === 404 || err?.statusCode === 410) await d.ref.delete();
      else logger.warn("Envoi push impossible", { status: err?.statusCode });
    }
  }));
}

export const notifyNewMessage = onDocumentCreated(
  { document: "conversations/{convId}/messages/{msgId}", secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const m = event.data?.data();
    // Annonces « X a rejoint / a quitté » : pas de notification (comme dans l'application).
    if (!m || m.event || typeof m.authorUid !== "string") return;
    const { convId } = event.params;
    const conv = await db.doc(`conversations/${convId}`).get();
    if (!conv.exists) return;

    const recipients = recipientsOf(conv.get("members"), await adminUids(), m.authorUid);
    if (!recipients.length) return;
    const payload = JSON.stringify({
      title: `${await authorLabel(m)} · ${conv.get("title") || "Canal Dev"}`,
      body: excerpt(m),
      conv: convId,
    });
    const topic = /^[A-Za-z0-9_-]{1,32}$/.test(convId) ? convId : undefined;
    await Promise.all(recipients.map((uid) => sendTo(uid, payload, topic)));
  },
);

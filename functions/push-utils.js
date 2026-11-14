// Fonctions pures des notifications push (testées par tests/functions.test.mjs, sans Firebase).

// Services de push des navigateurs. Les règles Firestore n'acceptent que ces adresses ;
// revérifié ici pour ne jamais envoyer de requête ailleurs.
export const PUSH_ENDPOINT_RE =
  /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\//;

/** Extrait du message affiché dans la notification (comme excerpt() dans js/messages.js). */
export function excerpt(m) {
  const t = String(m.text || "").replace(/\s+/g, " ").trim();
  if (t) return t.length > 140 ? t.slice(0, 140) + "…" : t;
  return m.image ? "📷 Photo" : "";
}

/**
 * Destinataires : membres et administrateurs, sauf l'auteur, sans doublon. Seuls les UID bien formés
 * sont gardés : ils servent à construire un chemin Firestore (users/{uid}/push).
 */
export function recipientsOf(members, admins, authorUid) {
  const all = new Set([...(Array.isArray(members) ? members : []), ...admins]);
  all.delete(authorUid);
  return [...all].filter((uid) => typeof uid === "string" && /^[A-Za-z0-9]{1,128}$/.test(uid));
}

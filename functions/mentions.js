// Mention en tête de message : « @Prénom Nom blabla » ne notifie que la personne nommée.
// Fichier copié à l'identique dans functions/mentions.js (vérifié par tests/functions.test.mjs) :
// l'application (notifications locales, son) et la Cloud Function (push) décident de la même façon.

// Comparaison sans tenir compte de la casse ni des accents.
const fold = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");

/**
 * Personne mentionnée au tout début du message, parmi les candidats (nom de l'annuaire).
 * Le nom doit être suivi de la fin du texte, d'une espace ou d'une ponctuation ; le plus long
 * nom qui convient l'emporte (« @Jean Dupont » plutôt que « @Jean »).
 * @param {string} text
 * @param {Iterable<{ uid: string, name: unknown }>} candidates
 * @returns {string | null} UID de la personne mentionnée, ou null
 */
export function mentionedUid(text, candidates) {
  const t = fold(String(text || "").trimStart());
  if (!t.startsWith("@")) return null;
  const rest = t.slice(1);
  let best = null;
  let bestLen = 0;
  for (const { uid, name } of candidates) {
    if (typeof name !== "string") continue;
    const n = fold(name.trim());
    if (!n || n.length <= bestLen || !rest.startsWith(n)) continue;
    if (/[\p{L}\p{N}_]/u.test(rest.charAt(n.length))) continue; // « @Jean » ne vise pas « Jeanne »
    best = uid;
    bestLen = n.length;
  }
  return best;
}

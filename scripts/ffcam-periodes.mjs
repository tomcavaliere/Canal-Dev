// Analyse du texte « Période de gardiennage » des mini-sites FFCAM (texte libre écrit par chaque refuge) :
//   « Printemps : du 27 mars au 3 mai 2026 (selon conditions) | Été : début juin à début septembre »
// donne deux périodes : 2026-03-27 → 2026-05-03 (exacte) et 06-01 → 09-01 (chaque année, approximative).
// Utilisé par scripts/ffcam-refuges.mjs ; testé par tests/periodes.test.mjs. Le texte d'origine est
// toujours gardé et affiché : l'analyse sert au filtre par dates, elle ne le remplace pas.

const MONTHS = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const MONTH = MONTHS.join("|");

/**
 * @typedef {{ debut: string, fin: string, approx: boolean }} Periode
 *   debut, fin : « AAAA-MM-JJ » (dates d'une année précise) ou « MM-JJ » (chaque année) ;
 *   approx : la date vient de « début / mi / fin » ou d'un mois seul.
 * @typedef {"garde" | "annee" | "non-garde" | "ferme" | "inconnu"} Statut
 */

function plain(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`]/g, "'");
}

const lastDay = (m, y = 2001) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m : 1 à 12 (2001 : pas bissextile)
const pad = (n) => String(n).padStart(2, "0");

// Une date du texte : « 3 mai 2026 », « 1er juin », « mi-juin », « fin septembre », « juin », « 26/02/2027 ».
const DATE_RE = new RegExp(
  String.raw`(?:\b(debut|mi|fin)\s*-?\s*(?:de\s+|d')?)?(?:\b(\d{1,2})(?:er)?\s+)?\b(${MONTH})\b(?:\s+(\d{4}))?`
  + String.raw`|\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b`, "g");

/**
 * @returns {{ index: number, end: number, month: number, day: number|null, qual: string|null, year: number|null }[]}
 */
function dateTokens(text) {
  const out = [];
  for (const m of text.matchAll(DATE_RE)) {
    if (m[3]) {
      out.push({ index: m.index, end: m.index + m[0].length, month: MONTHS.indexOf(m[3]) + 1,
        day: m[2] ? Number(m[2]) : null, qual: m[1] ?? null, year: m[4] ? Number(m[4]) : null });
    } else {
      const month = Number(m[6]);
      if (month < 1 || month > 12) continue;
      out.push({ index: m.index, end: m.index + m[0].length, month, day: Number(m[5]), qual: null, year: m[7] ? Number(m[7]) : null });
    }
  }
  return out;
}

// Jour d'une borne : le jour écrit, sinon d'après « début / mi / fin », sinon le 1er (début) ou le dernier jour (fin).
function dayOf(t, isEnd) {
  if (t.day) return { day: Math.min(t.day, lastDay(t.month, t.year ?? 2001)), approx: false };
  if (t.qual === "debut") return { day: 1, approx: true };
  if (t.qual === "mi") return { day: 15, approx: true };
  if (t.qual === "fin") return { day: lastDay(t.month, t.year ?? 2001), approx: true };
  return { day: isEnd ? lastDay(t.month, t.year ?? 2001) : 1, approx: true };
}

// Ce qui peut séparer les deux bornes d'une période : « au », « à », « - », « jusqu'au »,
// éventuellement précédés d'une parenthèse (« (selon conditions) ») et suivis de quelques mots.
const LINK_RE = /^\s*(?:\([^)|]*\)\s*)?(?:au|a|-|jusqu'?\s*(?:au|a))\s[^|\d.;:]{0,24}$/;

/**
 * @param {string} raw  texte de la période de gardiennage, lignes séparées par « | » ou des retours à la ligne
 * @returns {{ statut: Statut, periodes: Periode[] }}
 */
export function parsePeriodes(raw) {
  let text = plain(raw || "").replace(/\s*\n\s*/g, " | ").replace(/\s+/g, " ").trim();
  if (!text) return { statut: "inconnu", periodes: [] };

  // Formes à ramener au cas général.
  text = text
    .replace(/ouverture du refuge au public le/g, "du")
    .replace(/\s*\|?\s*fermeture du refuge au public le/g, " au")
    // « du 19 au 23 mai 2026 », « du 29-30-31 janvier 2027 », « (14-17 mai) »
    .replace(new RegExp(String.raw`\b(\d{1,2})(?:er)?\s*(?:au|-)\s*(?:\d{1,2}\s*-\s*)*(\d{1,2})(?:er)?\s+(${MONTH})\b`, "g"), "$1 $3 au $2 $3");

  // Une ligne qui annonce une fermeture durable ne donne pas de période (« fermé pour travaux de fin août 2026
  // à juin 2027 ») ; les autres lignes gardent les leurs (ouvert en juin, puis fermé pour travaux).
  const CLOSED = /travaux|renovation|nouvel ordre|actuellement ferme|ferme et inaccessible/;
  const lines = text.split("|");
  const closed = lines.some((l) => CLOSED.test(l));
  text = lines.filter((l) => !CLOSED.test(l)).join("|");

  const tokens = dateTokens(text);
  /** @type {Periode[]} */
  const periodes = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const gap = text.slice(a.end, b.index);
    const bareMonths = !a.day && !a.qual && !b.day && !b.qual;
    if (!LINK_RE.test(gap) && !(bareMonths && /^\s*et\s*$/.test(gap))) continue;

    const s = dayOf(a, false);
    const e = dayOf(b, true);
    let ya = a.year;
    let yb = b.year;
    const wraps = a.month > b.month || (a.month === b.month && s.day > e.day);
    if (yb && !ya) ya = wraps ? yb - 1 : yb;
    if (ya && !yb) yb = wraps ? ya + 1 : ya;
    const md = (t, d) => `${pad(t.month)}-${pad(d)}`;
    periodes.push(ya
      ? { debut: `${ya}-${md(a, s.day)}`, fin: `${yb}-${md(b, e.day)}`, approx: s.approx || e.approx }
      : { debut: md(a, s.day), fin: md(b, e.day), approx: s.approx || e.approx });
    i++; // la fin de cette période n'est pas le début de la suivante
  }
  if (periodes.length) return { statut: "garde", periodes };
  if (closed) return { statut: "ferme", periodes: [] };

  if (/non gard|autogestion|gestion libre|bivouac/.test(text)) return { statut: "non-garde", periodes: [] };
  if (/toute l'annee|a l'annee|ouvert en permanence/.test(text)) return { statut: "annee", periodes: [] };
  if (/\bferme\b/.test(text)) return { statut: "ferme", periodes: [] };
  return { statut: "inconnu", periodes: [] };
}

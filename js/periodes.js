// Filtre « gardé du … au … » de l'outil Refuges FFCAM : compare les périodes de gardiennage d'un refuge
// (analysées par scripts/ffcam-periodes.mjs) à une plage de dates. Sans accès à la page : testé par
// tests/periodes.test.mjs.

/**
 * @typedef {{ debut: string, fin: string, approx?: boolean }} Periode  « AAAA-MM-JJ », ou « MM-JJ » chaque année
 * @typedef {{ statut: string, periodes?: Periode[] }} Gardiennage
 * @typedef {"oui" | "non" | "inconnu"} Reponse
 */

const DAY = 86400000;
/** @param {string} iso « AAAA-MM-JJ » */
const toDay = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / DAY);
const yearOf = (iso) => Number(iso.slice(0, 4));
const isYearly = (p) => /^\d{2}-\d{2}$/.test(p.debut);

// Intervalles [début, fin] (en jours) des périodes, dépliées sur les années utiles pour une recherche
// de `from` à `to` : une période annuelle qui chevauche le nouvel an (« mi-décembre à mi-avril ») est
// prise aussi depuis l'année précédente.
function intervals(periodes, from, to) {
  const out = [];
  for (const p of periodes) {
    if (isYearly(p)) {
      for (let y = yearOf(from) - 1; y <= yearOf(to); y++) {
        const endYear = p.fin < p.debut ? y + 1 : y;
        out.push([toDay(`${y}-${p.debut}`), toDay(`${endYear}-${p.fin}`)]);
      }
    } else {
      out.push([toDay(p.debut), toDay(p.fin)]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// La plage [a, b] est-elle couverte jour par jour par les intervalles (triés) ? Deux périodes qui se
// suivent (fin le 9, reprise le 10) se raccordent.
function covers(list, a, b) {
  let reach = a - 1;
  for (const [s, e] of list) {
    if (s > reach + 1) break;
    reach = Math.max(reach, e);
    if (reach >= b) return true;
  }
  return reach >= b;
}

/**
 * Le refuge est-il gardé sur la plage ? « inconnu » quand ses dates de l'année demandée ne sont pas publiées
 * (dates d'une autre année seulement) ou que son texte n'a pas pu être lu.
 * @param {Gardiennage | null | undefined} g
 * @param {string} from  « AAAA-MM-JJ »
 * @param {string} to    « AAAA-MM-JJ », pas avant `from`
 * @param {{ entiere: boolean }} options  entiere : gardé tous les jours de la plage (sinon : au moins un)
 * @returns {Reponse}
 */
export function gardeSur(g, from, to, { entiere }) {
  if (!g) return "inconnu";
  if (g.statut === "annee") return "oui";
  if (g.statut === "non-garde" || g.statut === "ferme") return "non";
  const periodes = Array.isArray(g.periodes) ? g.periodes : [];
  if (g.statut !== "garde" || !periodes.length) return "inconnu";

  const list = intervals(periodes, from, to);
  const a = toDay(from);
  const b = toDay(to);
  const ok = entiere ? covers(list, a, b) : list.some(([s, e]) => s <= b && e >= a);
  if (ok) return "oui";

  // Dates publiées pour d'autres années seulement : on ne sait pas.
  if (periodes.some(isYearly)) return "non";
  const years = new Set(periodes.flatMap((p) => [yearOf(p.debut), yearOf(p.fin)]));
  for (let y = yearOf(from); y <= yearOf(to); y++) if (!years.has(y)) return "inconnu";
  return "non";
}

/**
 * Le refuge a-t-il une période approximative (« mi-juin », « début septembre ») qui touche la plage ?
 * @param {Gardiennage | null | undefined} g
 * @param {string} from
 * @param {string} to
 */
export function approxSur(g, from, to) {
  const periodes = Array.isArray(g?.periodes) ? g.periodes : [];
  return periodes.some((p) => p.approx && intervals([p], from, to).some(([s, e]) => s <= toDay(to) + 15 && e >= toDay(from) - 15));
}

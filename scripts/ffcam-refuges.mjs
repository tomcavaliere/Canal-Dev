// Relève les refuges et chalets de la FFCAM et écrit data/refuges-ffcam.json, lu par l'outil
// « Refuges FFCAM » (js/refuges.js). Le navigateur ne peut pas lire ffcam.fr directement (CORS) :
// on relance ce script à la main quand la liste change, puis on commite le fichier produit.
//
//   node scripts/ffcam-refuges.mjs                 télécharge la page de recherche
//   node scripts/ffcam-refuges.mjs page.html       lit une copie locale de cette page
//
// Le nom des gardiens n'est pas repris (donnée personnelle inutile ici) : la fiche garde le
// téléphone du refuge et renvoie vers son site.

import { readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://www.ffcam.fr/rechercher_refuge_chalet.html";
const OUT = new URL("../data/refuges-ffcam.json", import.meta.url);

// Chaîne de chaque massif FFCAM. Un massif absent de cette table est rangé dans « Autres » et
// signalé : il suffit de l'ajouter ici.
const CHAINES = {
  "Alpes": [
    "Alpes Grées-Charbonnel", "Bauges", "Beaufortain", "Belledonne", "Bornes-Aravis",
    "Cerces-Thabor-Mont Cenis", "Chablais", "Chartreuse", "Dévoluy", "Ecrins", "Grandes Rousses-Arves",
    "Haut Giffre-Aiguilles Rouges-Fiz", "Mercantour-Argentera", "Mont-Blanc", "Préalpes de Digne",
    "Queyras Nord-Brianconnais-Alpes Cottiennes", "Queyras Sud-Parpaillon-Ubaye-Orrenaye",
    "Taillefer-Matheysine", "Vanoise", "Vercors",
  ],
  "Pyrénées": [
    "Ariégeois", "Béarn", "Bigorre", "Cerdagne-Capcir", "Luchonnais", "Pays Basque",
    "Puigmal - Canigou - Albères",
  ],
  "Massif central": ["Auvergne", "Cévennes", "Grands Causses"],
  "Jura": ["Jura", "Les Rousses", "Mont d'Or"],
  "Vosges": ["Vosges"],
  "Autres": ["AUTRES MASSIFS", "Côte d'Or"],
};
const CHAINE_OF = new Map(Object.entries(CHAINES).flatMap(([c, ms]) => ms.map((m) => [m, c])));
const MASSIF_NAMES = { "AUTRES MASSIFS": "Divers" };

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function text(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// « REFUGE DE L'AIGLE (FFCAM) » → « Refuge de l'Aigle ».
const SMALL = new Set(["de", "des", "du", "la", "le", "les", "l", "d", "et", "en", "sur", "au", "aux", "à"]);
function niceName(raw) {
  const name = raw.replace(/\s*\(FFCAM\)\s*$/i, "").toLocaleLowerCase("fr");
  let first = true;
  return name.replace(/[\p{L}\p{N}]+/gu, (w) => {
    const keep = !first && SMALL.has(w);
    first = false;
    return keep ? w : w[0].toLocaleUpperCase("fr") + w.slice(1);
  });
}

function slug(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Seules les adresses web sont gardées (pas de javascript:, data:…).
function webUrl(href) {
  try {
    const u = new URL(href, SOURCE);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
}

function parse(html) {
  const refuges = [];
  const warnings = [];
  const ids = new Set();
  for (const block of html.split('<div class="seolanMap-item"').slice(1)) {
    const field = (cls) => {
      const m = block.match(new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>`));
      return m ? text(m[1]) : "";
    };
    const pos = block.match(/data-lat="(-?[\d.]+)"\s+data-lng="(-?[\d.]+)"/);
    const h3 = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!pos || !h3) { warnings.push("Fiche ignorée (nom ou position absent)"); continue; }
    const lat = Number(pos[1]);
    const lng = Number(pos[2]);
    const nom = niceName(text(h3[1]));
    if (!(lat > 41 && lat < 51.5 && lng > -5.5 && lng < 10)) { warnings.push(`${nom} : position hors de France, ignorée`); continue; }

    // « Ecrins - 3440 m - 30 places » (le nom du massif peut lui-même contenir « - »).
    const infos = field("infos");
    const m = infos.match(/^(.*?)\s+-\s+(\d+)\s*m\b(?:\s+-\s+(\d+)\s*places?)?/i);
    const rawMassif = (m ? m[1] : infos).trim() || "AUTRES MASSIFS";
    const massif = MASSIF_NAMES[rawMassif] ?? rawMassif;
    const chaine = CHAINE_OF.get(rawMassif) ?? "Autres";
    if (!CHAINE_OF.has(rawMassif)) {
      warnings.push(`Massif inconnu « ${rawMassif} » (${nom}) : à ranger dans CHAINES`);
    }

    const links = {};
    for (const a of block.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const label = text(a[2]).toLowerCase();
      const url = webUrl(text(a[1]));
      if (!url) continue;
      if (label.includes("tarif")) links.tarifs ??= url;
      else if (label.includes("site")) links.site ??= url;
    }

    let id = slug(nom);
    for (let i = 2; ids.has(id); i++) id = `${slug(nom)}-${i}`;
    ids.add(id);

    refuges.push({
      id, nom, chaine, massif,
      altitude: m ? Number(m[2]) : null,
      places: m?.[3] ? Number(m[3]) : null,
      telephone: field("phone").replace(/^T[ée]l\s*:\s*/i, "") || null,
      description: field("description") || null,
      site: links.site ?? null,
      tarifs: links.tarifs ?? null,
      lat, lng,
    });
  }
  return { refuges, warnings };
}

const html = process.argv[2]
  ? await readFile(process.argv[2], "utf8")
  : await (async () => {
    const res = await fetch(SOURCE, { headers: { "User-Agent": "Mozilla/5.0 (compatible; refuges-script)" } });
    if (!res.ok) throw new Error(`${SOURCE} : HTTP ${res.status}`);
    return res.text();
  })();

const { refuges, warnings } = parse(html);
for (const w of warnings) console.warn("⚠️ ", w);
if (refuges.length < 50) throw new Error(`Seulement ${refuges.length} refuges trouvés : la page a sans doute changé, fichier non écrit.`);

refuges.sort((a, b) => a.chaine.localeCompare(b.chaine, "fr") || a.massif.localeCompare(b.massif, "fr")
  || a.nom.localeCompare(b.nom, "fr"));
const data = { source: SOURCE, releve: new Date().toISOString().slice(0, 10), refuges };
await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
console.log(`${refuges.length} refuges écrits dans data/refuges-ffcam.json`);

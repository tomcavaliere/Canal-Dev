// Relève les refuges et chalets de la FFCAM et écrit data/refuges-ffcam.json, lu par l'outil
// « Refuges FFCAM » (js/refuges.js). Le navigateur ne peut pas lire ffcam.fr directement (CORS) :
// on relance ce script à la main (quelques minutes) quand les informations changent — en début de
// saison, pour les nouvelles dates de gardiennage —, puis on commite le fichier produit.
//
//   node scripts/ffcam-refuges.mjs                  télécharge tout (une page par seconde)
//   node scripts/ffcam-refuges.mjs --cache <dossier> garde les pages téléchargées dans ce dossier et
//                                                   les relit au lancement suivant (mise au point)
//
// Sources : la page de recherche (liste, position, massif, gardiens, téléphone), puis pour chaque refuge
// la page d'accueil de son mini-site (gardiennage, couchages, équipements, réglementation, contact) et
// sa page « Accès ». Les refuges sans mini-site FFCAM n'ont que les informations de la page de recherche.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parsePeriodes } from "./ffcam-periodes.mjs";

const SOURCE = "https://www.ffcam.fr/rechercher_refuge_chalet.html";
const OUT = new URL("../data/refuges-ffcam.json", import.meta.url);
const DELAY_MS = 1000; // politesse envers le serveur de la FFCAM

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

/* ---------- Texte ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Texte sur une ligne.
function text(html) {
  return decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Texte en gardant les retours à la ligne (<br>, paragraphes, éléments de liste).
function lines(html) {
  return decode(html
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

// « REFUGE DE L'AIGLE (FFCAM) » → « Refuge de l'Aigle » ; « BEATRICE LEITNER » → « Beatrice Leitner ».
const SMALL = new Set(["de", "des", "du", "la", "le", "les", "l", "d", "et", "en", "sur", "au", "aux", "à"]);
function niceName(raw, { small = true } = {}) {
  const name = raw.replace(/\s*\(FFCAM\)\s*$/i, "").trim().toLocaleLowerCase("fr");
  let first = true;
  return name.replace(/[\p{L}\p{N}]+/gu, (w) => {
    const keep = small && !first && SMALL.has(w);
    first = false;
    return keep ? w : w[0].toLocaleUpperCase("fr") + w.slice(1);
  });
}

function plain(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slug(s) {
  return plain(s).replace(/ /g, "-");
}

// Seules les adresses web sont gardées (pas de javascript:, data:…).
function webUrl(href, base = SOURCE) {
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
}

// Contenu d'un champ « <div class="field-xxx"><label>…</label> valeur</div> » (sans son libellé).
function field(html, name, { multiline = false } = {}) {
  const m = html.match(new RegExp(`<div class="(?:[a-z]+ )?field-${name}"[^>]*>([\\s\\S]*?)</div>`));
  if (!m) return null;
  const body = m[1].replace(/<label>[\s\S]*?<\/label>/, "");
  const v = multiline ? lines(body) : text(body);
  return v || null;
}

const number = (s) => {
  const m = s?.replace(/\s/g, "").match(/\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(",", ".")) : null;
};
// « 07:00 h » → « 7 h », « 02:30 h » → « 2 h 30 ».
const duration = (s) => {
  const m = s?.match(/(\d{1,2}):(\d{2})/);
  if (!m) return s || null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return min ? `${h} h ${String(min).padStart(2, "0")}` : `${h} h`;
};

/* ---------- Téléchargement ---------- */

const cacheArg = process.argv.indexOf("--cache");
const CACHE = cacheArg > 0 ? process.argv[cacheArg + 1] : null;
let lastFetch = 0;

async function get(url) {
  const key = CACHE ? `${CACHE}/${url.replace(/[^a-z0-9]+/gi, "_")}.html` : null;
  if (key) {
    try { return await readFile(key, "utf8"); } catch { /* pas encore en cache */ }
  }
  const wait = lastFetch + DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; refuges-script)" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  const html = await res.text();
  if (key) {
    await mkdir(CACHE, { recursive: true });
    await writeFile(key, html);
  }
  return html;
}

/* ---------- Page de recherche ---------- */

function parseSearch(html) {
  const refuges = [];
  const warnings = [];
  const ids = new Set();
  for (const block of html.split('<div class="seolanMap-item"').slice(1)) {
    const div = (cls) => {
      const m = block.match(new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>`));
      return m ? text(m[1]) : "";
    };
    const pos = block.match(/data-lat="(-?[\d.]+)"\s+data-lng="(-?[\d.]+)"/);
    const h3 = block.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!pos || !h3) { warnings.push("Fiche ignorée (nom ou position absent)"); continue; }
    const lat = Number(pos[1]);
    const lng = Number(pos[2]);
    const rawName = text(h3[1]);
    const nom = niceName(rawName);
    if (!(lat > 41 && lat < 51.5 && lng > -5.5 && lng < 10)) { warnings.push(`${nom} : position hors de France, ignorée`); continue; }

    // « Ecrins - 3440 m - 30 places » (le nom du massif peut lui-même contenir « - »).
    const infos = div("infos");
    const m = infos.match(/^(.*?)\s+-\s+(\d+)\s*m\b(?:\s+-\s+(\d+)\s*places?)?/i);
    const rawMassif = (m ? m[1] : infos).trim() || "AUTRES MASSIFS";
    if (!CHAINE_OF.has(rawMassif)) warnings.push(`Massif inconnu « ${rawMassif} » (${nom}) : à ranger dans CHAINES`);

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

    const gardiens = div("gardien").replace(/^Gardien\(ne\)s?\s*:\s*/i, "");
    refuges.push({
      id, nom, rawName,
      chaine: CHAINE_OF.get(rawMassif) ?? "Autres",
      massif: MASSIF_NAMES[rawMassif] ?? rawMassif,
      altitude: m ? Number(m[2]) : null,
      places: m?.[3] ? Number(m[3]) : null,
      telephone: div("phone").replace(/^T[ée]l\s*:\s*/i, "") || null,
      // « En cours de recrutement », « Non gardé »… ne sont pas des noms.
      gardiens: gardiens.split(/\s*(?:,|\bet\b|\/)\s*/i)
        .filter((g) => g && !/recrutement|gard[ée]|aucun|n\/?c\b|^-+$/i.test(g))
        .map((g) => niceName(g, { small: false })),
      description: div("description") || null,
      site: links.site ?? null,
      tarifs: links.tarifs ?? null,
      lat, lng,
    });
  }
  return { refuges, warnings };
}

/* ---------- Mini-site d'un refuge ---------- */

// Partie de la page qui décrit ce refuge : un mini-site peut en présenter plusieurs (« Voie normale du
// Mont Blanc » : Goûter, Tête Rousse, Nid d'Aigle), chacun dans son bloc.
function refugeBlock(html, rawName) {
  const blocks = html.split('<div class="block-refuge').slice(1);
  if (!blocks.length) {
    const i = html.indexOf('<h2 class="notranslate">');
    return i < 0 ? null : html.slice(i, i + 6000);
  }
  const want = plain(rawName.replace(/\(FFCAM\)/i, ""));
  return blocks.find((b) => {
    const h = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) ?? b.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    return h && plain(text(h[1]).replace(/\(FFCAM\)/i, "")) === want;
  }) ?? null;
}

// Équipements signalés « disponibles » (pictogrammes) dans une partie de la page.
function equipements(html) {
  const out = [];
  for (const m of html.matchAll(/<div class="picto [^"]*\bavailable\b[^"]*"[^>]*>\s*<img[^>]*alt="([^"]*)"/g)) {
    const name = decode(m[1]).trim();
    if (name && !name.includes("+") && !out.includes(name)) out.push(name);
  }
  return out;
}

function parseHome(html, r, base) {
  const block = refugeBlock(html, r.rawName);
  const info = {};
  if (block) {
    // Adresse : « 05320 LA GRAVE<br>ALPES > Ecrins > Vallée de la Romanche<br>3440 m<br>… ».
    const p = block.match(/<p class="notranslate">([\s\S]*?)<\/p>/);
    if (p) {
      for (const l of lines(p[1]).split("\n")) {
        if (/^\d{5}\s/.test(l)) info.adresse = l.replace(/^(\d{5})\s+(.*)$/, (_, cp, v) => `${cp} ${niceName(v)}`);
        else if (l.includes(">")) info.localisation = l.split(/\s*>\s*/).map((x, i) => (i ? x : niceName(x))).join(" › ");
      }
    }
    const per = block.match(/<div class="(?:ouverture|periode)">([\s\S]*?)<\/div>/);
    if (per) info.periodeTexte = lines(per[1].replace(/<strong>\s*Période de gardiennage\s*<\/strong>/i, "")) || null;
  }

  // Couchages et équipements : en période gardée, puis hors gardiennage.
  const split = html.search(/<div class="hors-gardiennag/);
  const garde = split > 0 ? html.slice(0, split) : html;
  const hors = split > 0 ? html.slice(split) : "";
  const couchage = (part, prefix) => {
    const places = number(field(part, `com_${prefix}_nbcouchage`));
    const dortoirs = number(field(part, `com_${prefix}_nbdortoir`));
    return places || dortoirs ? { places, dortoirs } : null;
  };
  info.couchages = { garde: couchage(garde, "pg"), horsGardiennage: couchage(hors, "png") };
  info.equipements = { garde: equipements(garde.slice(garde.search(/<div class="gardiennage"/))), horsGardiennage: equipements(hors) };
  if (!info.equipements.garde.length && garde.search(/<div class="gardiennage"/) < 0) info.equipements.garde = [];
  info.descriptifCouchage = field(html, "descriptif_couchage", { multiline: true });
  info.infosComplementaires = field(html, "com_pg_infocomp", { multiline: true });
  info.refugeHiver = field(html, "equipement_refuge_hiver_commentaire", { multiline: true });
  info.mobilite = field(html, "mobilite_commentaire", { multiline: true });
  info.reglementation = field(html, "situation_reglementaire", { multiline: true });

  // Adresse électronique publiée : celle du refuge (@ffcam.fr) en priorité.
  const mails = [...new Set([...(block ?? html).matchAll(/mailto:([^"?\s]+)/g)].map((m) => decode(m[1]).trim().toLowerCase()))]
    .filter((m) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(m));
  info.email = mails.find((m) => m.endsWith("@ffcam.fr")) ?? mails[0] ?? null;
  info.site = webUrl(base, base);
  return info;
}

function parseAcces(html) {
  const gps = field(html, "gps_latitude");
  const dec = gps?.match(/(-?\d+\.\d+)\s*N\s*-\s*(-?\d+\.\d+)\s*E/);
  const saison = (s) => {
    const v = {
      distance: field(html, `distance_${s}`),
      denivelePositif: number(field(html, `denivele_positif_${s}`)),
      deniveleNegatif: number(field(html, `denivele_negatif_${s}`)),
      montee: duration(field(html, `temps_vers_refuge_${s}`)),
      descente: duration(field(html, s === "ete" ? "temps_depuis_refuge_pedestre" : "temps_depuis_refuge_ski")),
      difficulte: field(html, `difficulte_acces_${s}_link`),
      parkingVersRefuge: field(html, `description_acces_${s}_parkingrefuge`, { multiline: true }),
      refugeVersParking: field(html, `description_acces_${s}_refugeparking`, { multiline: true }),
    };
    return Object.values(v).some((x) => x != null) ? v : null;
  };
  const acces = {
    depart: dec || field(html, "altitude")
      ? { lat: dec ? Number(dec[1]) : null, lng: dec ? Number(dec[2]) : null, altitude: number(field(html, "altitude")) }
      : null,
    routier: field(html, "description_acces_routier", { multiline: true }),
    transportsCommun: field(html, "description_acces_transport_commun", { multiline: true }),
    ete: saison("ete"),
    hiver: saison("hiver"),
  };
  return Object.values(acces).some((x) => x != null) ? acces : null;
}

/* ---------- Programme ---------- */

const { refuges, warnings } = parseSearch(await get(SOURCE));
if (refuges.length < 50) throw new Error(`Seulement ${refuges.length} refuges trouvés : la page a sans doute changé, fichier non écrit.`);

let done = 0;
for (const r of refuges) {
  done++;
  const base = r.site && new URL(r.site).hostname.endsWith(".ffcam.fr") ? new URL("/", r.site).href : null;
  let info = {};
  let acces = null;
  if (base) {
    try {
      info = parseHome(await get(base), r, base);
      acces = parseAcces(await get(new URL("acces.html", base).href));
    } catch (err) {
      warnings.push(`${r.nom} : mini-site illisible (${err.message})`);
    }
  }
  const periodeTexte = info.periodeTexte ?? null;
  Object.assign(r, {
    adresse: info.adresse ?? null,
    localisation: info.localisation ?? null,
    email: info.email ?? null,
    gardiennage: { texte: periodeTexte, ...parsePeriodes(periodeTexte ?? "") },
    couchages: info.couchages ?? null,
    descriptifCouchage: info.descriptifCouchage ?? null,
    equipements: info.equipements ?? null,
    refugeHiver: info.refugeHiver ?? null,
    infosComplementaires: info.infosComplementaires ?? null,
    mobilite: info.mobilite ?? null,
    reglementation: info.reglementation ?? null,
    acces,
  });
  delete r.rawName;
  if (base && !periodeTexte) warnings.push(`${r.nom} : période de gardiennage introuvable sur ${base}`);
  process.stdout.write(`\r${done}/${refuges.length} `);
}
process.stdout.write("\n");
for (const w of warnings) console.warn("⚠️ ", w);

refuges.sort((a, b) => a.chaine.localeCompare(b.chaine, "fr") || a.massif.localeCompare(b.massif, "fr")
  || a.nom.localeCompare(b.nom, "fr"));
const data = { source: SOURCE, releve: new Date().toISOString().slice(0, 10), refuges };
await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
const counts = Object.groupBy(refuges, (r) => r.gardiennage.statut);
console.log(`${refuges.length} refuges écrits dans data/refuges-ffcam.json (gardiennage : `
  + Object.entries(counts).map(([k, v]) => `${k} ${v.length}`).join(", ") + ")");

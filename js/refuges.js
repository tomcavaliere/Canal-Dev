// Outil de projet « Refuges FFCAM » (js/tools.js) : carte OpenStreetMap et liste par chaîne et massif des refuges et chalets
// du Club alpin, filtre « gardé pendant mon séjour », et fiche complète d'un refuge dans un dialogue. Les données viennent
// de data/refuges-ffcam.json, produit par scripts/ffcam-refuges.mjs. Leaflet (vendor/leaflet) n'est chargé qu'à la
// première ouverture. Tout le texte du fichier est inséré comme texte (jamais comme HTML).

import { approxSur, gardeSur } from "./periodes.js";
import { $ } from "./ui.js";

const DATA_URL = "data/refuges-ffcam.json";
const LEAFLET_URL = new URL("../vendor/leaflet/leaflet-src.esm.js", import.meta.url).href;
const LEAFLET_CSS = "vendor/leaflet/leaflet.css";
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
  + ' · données <a href="https://www.ffcam.fr/rechercher_refuge_chalet.html" target="_blank" rel="noopener noreferrer">FFCAM</a>';
const FRANCE = [[42.2, -1.9], [49.2, 8.3]];

// Ordre d'affichage des chaînes, et couleur de leurs points sur la carte.
const CHAINES = ["Alpes", "Pyrénées", "Massif central", "Jura", "Vosges", "Autres"];
const CHAINE_CLASS = new Map(CHAINES.map((c, i) => [c, `chaine-${i}`]));

const STATUTS = {
  garde: "Gardé en saison",
  annee: "Gardé toute l'année",
  "non-garde": "Non gardé",
  ferme: "Fermé",
  inconnu: "Gardiennage non précisé",
};

/**
 * Forme de data/refuges-ffcam.json (voir scripts/ffcam-refuges.mjs) ; chaque champ peut manquer ou valoir null.
 * @typedef {{ id: string, nom: string, chaine: string, massif: string, lat: number, lng: number, [k: string]: any }} Refuge
 */

let open = false;
/** @type {Promise<void>|null} */
let loading = null;
/** @type {Refuge[]} */
let refuges = [];
/** @type {Map<string, Refuge>} */
let byId = new Map();
let releve = "";
/** @type {any} */
let L = null;
/** @type {any} */
let map = null;
/** @type {Map<string, any>} */
const markers = new Map();
/** @type {string|null} */
let selected = null;

// Ouvre la vue (à la place de la conversation). L'appelant (openProjectTool) a fermé la conversation
// et le calendrier, et vérifié que le projet a cet outil.
export function openRefuges() {
  open = true;
  $("chat-empty").hidden = true;
  $("refuges-view").hidden = false;
  loading ??= load().catch((err) => {
    loading = null;
    console.error("Chargement des refuges impossible", err);
    showError("Chargement des refuges impossible. Vérifie ta connexion puis rouvre l'outil.");
  });
  // La carte a pu être créée vue masquée : elle recalcule sa taille une fois affichée.
  requestAnimationFrame(() => map?.invalidateSize());
}

export function closeRefuges() {
  if (!open) return;
  open = false;
  if ($("dlg-refuge").open) $("dlg-refuge").close();
  $("refuges-view").hidden = true;
  if ($("chat-view").hidden && $("cal-view").hidden) $("chat-empty").hidden = false;
}

function showError(msg) {
  $("refuges-error").textContent = msg;
  $("refuges-error").hidden = !msg;
}

async function load() {
  showError("");
  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = LEAFLET_CSS;
    document.head.append(link);
  }
  const [data, leaflet] = await Promise.all([
    fetch(DATA_URL).then((r) => {
      if (!r.ok) throw new Error(`${DATA_URL} : HTTP ${r.status}`);
      return r.json();
    }),
    import(LEAFLET_URL),
  ]);
  L = leaflet;
  refuges = Array.isArray(data.refuges) ? data.refuges.filter(valid) : [];
  byId = new Map(refuges.map((r) => [r.id, r]));
  releve = typeof data.releve === "string" ? data.releve : "";
  renderSource();
  createMap();
  renderList();
}

// Garde-fou : le fichier est produit par le script, mais la page ne fait confiance qu'aux formes attendues.
function valid(r) {
  return r && typeof r.id === "string" && typeof r.nom === "string" && typeof r.chaine === "string"
    && typeof r.massif === "string" && Number.isFinite(r.lat) && Number.isFinite(r.lng);
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v) => (Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);

const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const formatDay = (iso) => dayFmt.format(new Date(iso + "T00:00:00Z"));

function renderSource() {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releve) ? formatDay(releve) : "";
  $("refuges-source").textContent = `${refuges.length} refuges et chalets du Club alpin (FFCAM)`
    + (date ? `, relevés le ${date}.` : ".");
}

/* ---------- Carte ---------- */

function createMap() {
  map = L.map($("refuges-map"), { zoomControl: true, attributionControl: true });
  L.tileLayer(TILES, {
    maxZoom: 17,
    attribution: ATTRIBUTION,
    // Le site n'envoie aucun référent ; OpenStreetMap demande au moins l'origine des requêtes de tuiles.
    referrerPolicy: "strict-origin-when-cross-origin",
  }).addTo(map);
  map.attributionControl.setPrefix(false);

  for (const r of refuges) {
    const m = L.circleMarker([r.lat, r.lng], {
      radius: 7, weight: 2, fillOpacity: .85, className: `refuge-dot ${CHAINE_CLASS.get(r.chaine) ?? "chaine-5"}`,
    });
    const tip = document.createElement("span");
    tip.textContent = r.nom;
    m.bindTooltip(tip, { direction: "top", offset: [0, -6] });
    m.on("click", () => showRefuge(r.id, { pan: false }));
    m.addTo(map);
    markers.set(r.id, m);
  }
  map.fitBounds(markers.size ? L.featureGroup([...markers.values()]).getBounds().pad(0.05) : FRANCE);
}

function highlight(id) {
  if (selected) markers.get(selected)?.setStyle({ radius: 7 });
  selected = id;
  const m = markers.get(id);
  if (m) {
    m.setStyle({ radius: 11 });
    m.bringToFront();
  }
  for (const b of $("refuges-groups").querySelectorAll("button.refuge-item")) {
    b.classList.toggle("active", b.dataset.id === id);
  }
}

/* ---------- Liste par chaîne et massif ---------- */

function renderList() {
  /** @type {Map<string, Map<string, Refuge[]>>} */
  const byChaine = new Map();
  for (const r of refuges) {
    if (!byChaine.has(r.chaine)) byChaine.set(r.chaine, new Map());
    const massifs = byChaine.get(r.chaine);
    if (!massifs.has(r.massif)) massifs.set(r.massif, []);
    massifs.get(r.massif).push(r);
  }
  const order = (c) => (CHAINES.includes(c) ? CHAINES.indexOf(c) : CHAINES.length);
  const chaines = [...byChaine.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b, "fr"));

  const groups = chaines.map((chaine) => {
    const massifs = byChaine.get(chaine);
    const details = document.createElement("details");
    details.className = `refuges-chaine ${CHAINE_CLASS.get(chaine) ?? "chaine-5"}`;
    details.open = true;
    const summary = document.createElement("summary");
    summary.append(dot(), document.createTextNode(chaine), count(0));
    details.append(summary);

    for (const massif of [...massifs.keys()].sort((a, b) => a.localeCompare(b, "fr"))) {
      const items = massifs.get(massif).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      const sub = document.createElement("details");
      sub.className = "refuges-massif";
      const s = document.createElement("summary");
      s.append(document.createTextNode(massif), count(0));
      const ul = document.createElement("ul");
      ul.className = "refuges-items";
      for (const r of items) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "refuge-item";
        b.dataset.id = r.id;
        b.dataset.search = normalize(`${r.nom} ${r.massif} ${r.chaine} ${list(r.gardiens).join(" ")} ${str(r.adresse) ?? ""}`);
        const name = document.createElement("span");
        name.className = "refuge-item-name";
        name.textContent = r.nom;
        const tag = document.createElement("span");
        tag.className = "refuge-tag";
        tag.hidden = true;
        const alt = document.createElement("span");
        alt.className = "muted small";
        alt.textContent = num(r.altitude) ? `${r.altitude} m` : "";
        b.append(name, tag, alt);
        b.addEventListener("click", () => showRefuge(r.id, { pan: true }));
        li.append(b);
        ul.append(li);
      }
      sub.append(s, ul);
      details.append(sub);
    }
    return details;
  });
  $("refuges-groups").replaceChildren(...groups);
  applyFilter();
}

function dot() {
  const d = document.createElement("span");
  d.className = "refuges-dot";
  d.setAttribute("aria-hidden", "true");
  return d;
}

function count(n) {
  const c = document.createElement("span");
  c.className = "group-count";
  c.textContent = String(n);
  return c;
}

function normalize(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/* ---------- Filtres : texte et dates de séjour ---------- */

// Plage de dates choisie (« AAAA-MM-JJ »), ou null. Une seule date : ce jour-là.
function dateRange() {
  let from = $("refuges-from").value;
  let to = $("refuges-to").value;
  if (!from && !to) return null;
  from ||= to;
  to ||= from;
  if (to < from) [from, to] = [to, from];
  return { from, to, entiere: /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="refuges-mode"]:checked'))?.value !== "un" };
}

/**
 * Ce que le filtre par dates dit d'un refuge : visible ou non, et la mention à afficher.
 * @returns {{ show: boolean, tag: string, title: string, kind: string }}
 */
function dateVerdict(r, range) {
  if (!range) return { show: true, tag: "", title: "", kind: "" };
  const g = r.gardiennage;
  const answer = gardeSur(g, range.from, range.to, { entiere: range.entiere });
  if (answer === "oui") {
    return approxSur(g, range.from, range.to)
      ? { show: true, tag: "≈", title: "Dates approximatives (« mi-juin », « début septembre »…) : vérifie auprès du refuge", kind: "approx" }
      : { show: true, tag: "", title: "", kind: "" };
  }
  if (answer === "inconnu") {
    return { show: $("refuges-unknown").checked, tag: "dates ?", title: "Dates de gardiennage non publiées pour cette période", kind: "unknown" };
  }
  if (g?.statut === "non-garde") {
    return { show: $("refuges-free").checked, tag: "non gardé", title: "Refuge non gardé (accès libre ou sur réservation)", kind: "free" };
  }
  return { show: false, tag: "", title: "", kind: "" };
}

// Applique le texte et les dates : masque les refuges écartés (liste et carte), ouvre les massifs qui en ont.
function applyFilter() {
  const q = normalize($("refuges-filter").value.trim());
  const range = dateRange();
  $("btn-refuges-dates-clear").hidden = !range;
  let shown = 0;
  let unknown = 0;
  const visible = new Set();
  for (const chaine of $("refuges-groups").querySelectorAll(".refuges-chaine")) {
    let inChaine = 0;
    for (const massif of chaine.querySelectorAll(".refuges-massif")) {
      let inMassif = 0;
      for (const b of massif.querySelectorAll("button.refuge-item")) {
        const r = byId.get(b.dataset.id);
        const v = dateVerdict(r, range);
        if (range && v.kind === "unknown") unknown++;
        const ok = (!q || b.dataset.search.includes(q)) && v.show;
        b.parentElement.hidden = !ok;
        const tag = b.querySelector(".refuge-tag");
        tag.textContent = v.tag;
        tag.title = v.title;
        tag.className = `refuge-tag ${v.kind}`;
        tag.hidden = !v.tag;
        if (ok) {
          inMassif++;
          visible.add(r.id);
        }
      }
      massif.hidden = !inMassif;
      massif.querySelector(":scope > summary .group-count").textContent = String(inMassif);
      if (q || range) massif.open = inMassif > 0 && (!!q || inMassif <= 8);
      inChaine += inMassif;
    }
    chaine.hidden = !inChaine;
    chaine.querySelector(":scope > summary .group-count").textContent = String(inChaine);
    if (q || range) chaine.open = inChaine > 0;
    shown += inChaine;
  }
  for (const [id, m] of markers) {
    const ok = visible.has(id);
    if (ok && !map.hasLayer(m)) m.addTo(map);
    else if (!ok && map.hasLayer(m)) m.remove();
    if (ok) m.getElement()?.classList.toggle("unknown", !!range && dateVerdict(byId.get(id), range).kind !== "");
  }
  $("refuges-empty").hidden = shown > 0 || !refuges.length;
  renderDatesSummary(range, shown, unknown);
}

function renderDatesSummary(range, shown, unknown) {
  const el = $("refuges-dates-summary");
  if (!range) {
    el.textContent = "Choisis tes dates pour ne voir que les refuges gardés.";
    return;
  }
  const when = range.from === range.to ? `le ${formatDay(range.from)}` : `du ${formatDay(range.from)} au ${formatDay(range.to)}`;
  let txt = `${shown} refuge${shown > 1 ? "s" : ""} ${when}`;
  if (unknown && !$("refuges-unknown").checked) {
    txt += ` · ${unknown} autre${unknown > 1 ? "s" : ""} sans dates publiées pour cette période`;
  }
  el.textContent = txt + ". D'après les périodes publiées par la FFCAM : vérifie auprès du refuge.";
}

$("refuges-filter").addEventListener("input", applyFilter);
for (const id of ["refuges-from", "refuges-to", "refuges-unknown", "refuges-free"]) {
  $(id).addEventListener("change", () => { if (refuges.length) applyFilter(); });
}
for (const radio of document.querySelectorAll('input[name="refuges-mode"]')) {
  radio.addEventListener("change", () => { if (refuges.length) applyFilter(); });
}
$("refuges-from").addEventListener("change", () => {
  // Date d'arrivée choisie : la date de départ ne peut pas la précéder.
  $("refuges-to").min = $("refuges-from").value;
  if ($("refuges-to").value && $("refuges-to").value < $("refuges-from").value) $("refuges-to").value = $("refuges-from").value;
});
$("btn-refuges-dates-clear").addEventListener("click", () => {
  $("refuges-from").value = "";
  $("refuges-to").value = "";
  $("refuges-to").min = "";
  applyFilter();
});

/* ---------- Fiche d'un refuge ---------- */

// « 09.74.77.66.52 (période gardée) - 06.88… » : chaque numéro devient un lien tel:, le reste du texte est gardé tel quel.
const PHONE_RE = /(?:\+\s?33\s?(?:\(0\)\s?)?|0)\(?[1-9]\)?(?:[\s.]?\d{2}){4}/g;
/** @param {string} v */
function phoneNodes(v) {
  /** @type {(Node|string)[]} */
  const nodes = [];
  let last = 0;
  for (const m of v.matchAll(PHONE_RE)) {
    if (m.index > last) nodes.push(v.slice(last, m.index));
    const a = document.createElement("a");
    a.href = "tel:" + m[0].replace("(0)", "").replace(/[^\d+]/g, "");
    a.textContent = m[0];
    nodes.push(a);
    last = m.index + m[0].length;
  }
  if (last < v.length) nodes.push(v.slice(last));
  return nodes;
}

/**
 * Élément avec sa classe et son texte. Typé `any` : selon la balise, c'est un lien, une liste…
 * @param {string} tag @param {string} [cls] @param {string|null} [text]
 * @returns {any}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Liste de définitions ; les valeurs vides sont omises. @param {[string, string|(string|Node)[]|null][]} rows */
function facts(rows) {
  const dl = el("dl", "refuge-facts");
  for (const [k, v] of rows) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const dd = el("dd");
    if (Array.isArray(v)) dd.append(...v); else dd.textContent = v;
    dl.append(el("dt", "", k), dd);
  }
  return dl.childElementCount ? dl : null;
}

/** Section titrée ; omise si elle n'a aucun contenu. @param {string} title @param {(Node|null)[]} parts */
function section(title, parts) {
  const kept = parts.filter(Boolean);
  if (!kept.length) return null;
  const s = el("section", "refuge-section");
  s.append(el("h3", "", title), ...kept);
  return s;
}

const para = (text, cls = "refuge-text") => (str(text) ? el("p", cls, str(text)) : null);

// Texte long replié (accès routier, itinéraires…).
function more(summary, text) {
  if (!str(text)) return null;
  const d = el("details", "refuge-more");
  d.append(el("summary", "", summary), el("p", "refuge-text", str(text)));
  return d;
}

function chips(items) {
  if (!items.length) return null;
  const ul = el("ul", "refuge-chips");
  for (const i of items) ul.append(el("li", "", i));
  return ul;
}

function couchage(c) {
  if (!c || (!num(c.places) && !num(c.dortoirs))) return null;
  return [num(c.places) && `${c.places} places`, num(c.dortoirs) && `${c.dortoirs} dortoir${c.dortoirs > 1 ? "s" : ""}`]
    .filter(Boolean).join(", ");
}

function osmLink(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
}

function link(label, href) {
  const a = el("a", "", label);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function accesSaison(title, s) {
  if (!s || typeof s !== "object") return null;
  const deniv = [num(s.denivelePositif) && `+${s.denivelePositif} m`, num(s.deniveleNegatif) && `−${s.deniveleNegatif} m`]
    .filter(Boolean).join(" / ");
  return section(title, [
    facts([
      ["Distance", str(s.distance)],
      ["Dénivelé", deniv || null],
      ["Montée", str(s.montee)],
      ["Descente", str(s.descente)],
      ["Difficulté", str(s.difficulte)],
    ]),
    more("Itinéraire parking → refuge", s.parkingVersRefuge),
    more("Itinéraire refuge → parking", s.refugeVersParking),
  ]);
}

/**
 * @param {string} id
 * @param {{ pan: boolean }} options  pan : centrer la carte sur le refuge (clic dans la liste)
 */
function showRefuge(id, { pan }) {
  const r = byId.get(id);
  if (!r) return;
  highlight(id);
  if (pan && map) map.setView([r.lat, r.lng], Math.max(map.getZoom(), 12));

  $("refuge-title").textContent = r.nom;
  $("refuge-where").textContent = str(r.localisation) ?? `${r.chaine} › ${r.massif}`;

  const g = r.gardiennage && typeof r.gardiennage === "object" ? r.gardiennage : null;
  const statut = STATUTS[g?.statut] ? g.statut : "inconnu";
  const range = dateRange();
  let rangeLine = null;
  if (range) {
    const answer = gardeSur(g, range.from, range.to, { entiere: range.entiere });
    const when = range.from === range.to ? `Le ${formatDay(range.from)}` : `Du ${formatDay(range.from)} au ${formatDay(range.to)}`;
    const words = { oui: "gardé", non: "pas gardé", inconnu: "dates non publiées" };
    rangeLine = el("p", `refuge-range ${answer}`, `${when} : ${words[answer]}`
      + (answer === "oui" && approxSur(g, range.from, range.to) ? " (dates approximatives)" : "") + ".");
  }
  const equip = r.equipements && typeof r.equipements === "object" ? r.equipements : {};
  const couch = r.couchages && typeof r.couchages === "object" ? r.couchages : {};
  const acces = r.acces && typeof r.acces === "object" ? r.acces : {};
  const depart = acces.depart && Number.isFinite(acces.depart.lat) ? acces.depart : null;
  const gardiens = list(r.gardiens);

  const body = [
    facts([
      ["Altitude", num(r.altitude) ? `${r.altitude} m` : null],
      ["Places", num(r.places) ? String(r.places) : null],
      ["Adresse", str(r.adresse)],
      ["Téléphone", str(r.telephone) ? phoneNodes(str(r.telephone)) : null],
      ["Courriel", str(r.email) && /^[^@\s]+@[^@\s]+$/.test(r.email) ? [(() => {
        const a = el("a", "", r.email);
        a.href = "mailto:" + r.email;
        return a;
      })()] : null],
      ["Position", `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`],
    ]),
    para(r.description),
    section("Gardiennage", [
      el("p", `refuge-statut ${statut}`, STATUTS[statut]),
      rangeLine,
      facts([[gardiens.length > 1 ? "Gardien(ne)s" : "Gardien(ne)", gardiens.join(", ") || null]]),
      para(g?.texte),
    ]),
    section("Couchages", [
      facts([
        ["En période gardée", couchage(couch.garde)],
        ["Hors gardiennage", couchage(couch.horsGardiennage)],
      ]),
      para(r.descriptifCouchage),
    ]),
    section("Équipements en période gardée", [chips(list(equip.garde))]),
    section("Équipements hors gardiennage", [chips(list(equip.horsGardiennage)), para(r.refugeHiver)]),
    section("Accès", [
      facts([
        ["Départ", depart ? [
          document.createTextNode(num(depart.altitude) ? `${depart.altitude} m · ` : ""),
          link("voir sur la carte", osmLink(depart.lat, depart.lng)),
        ] : null],
      ]),
      more("Accès routier", acces.routier),
      more("Transports en commun", acces.transportsCommun),
    ]),
    accesSaison("Accès en été", acces.ete),
    accesSaison("Accès en hiver", acces.hiver),
    section("Accessibilité", [para(r.mobilite)]),
    section("Réglementation et particularités", [para(r.reglementation)]),
    section("Informations complémentaires", [para(r.infosComplementaires)]),
  ];
  $("refuge-body").replaceChildren(...body.filter(Boolean));

  const links = [];
  if (r.site) links.push(["Site du refuge", r.site]);
  if (r.tarifs) links.push(["Tarifs et réservation", r.tarifs]);
  links.push(["Voir sur OpenStreetMap", osmLink(r.lat, r.lng)]);
  $("refuge-links").replaceChildren(...links.filter(([, href]) => /^https?:\/\//.test(href)).map(([label, href]) => {
    const li = el("li");
    li.append(link(label, href));
    return li;
  }));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releve) ? ` le ${formatDay(releve)}` : "";
  $("refuge-source").textContent = `Source : FFCAM (site du refuge), relevé${date}. Vérifie l'ouverture et réserve auprès du refuge.`;

  // Le dialogue s'ouvre (ou, déjà ouvert, revient) en haut de la fiche, le focus sur son titre.
  if (!$("dlg-refuge").open) $("dlg-refuge").showModal();
  $("refuge-title").focus({ preventScroll: true });
  $("dlg-refuge").scrollTop = 0;
}

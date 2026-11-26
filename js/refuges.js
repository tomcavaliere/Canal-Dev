// Outil « Refuges FFCAM » : carte OpenStreetMap et liste par chaîne et massif des refuges et chalets
// du Club alpin, et fiche d'un refuge dans un dialogue. Les données viennent de data/refuges-ffcam.json,
// produit par scripts/ffcam-refuges.mjs. Leaflet (vendor/leaflet) n'est chargé qu'à la première ouverture.

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

/**
 * @typedef {{ id: string, nom: string, chaine: string, massif: string, altitude: number|null,
 *   places: number|null, telephone: string|null, description: string|null, site: string|null,
 *   tarifs: string|null, lat: number, lng: number }} Refuge
 */

let open = false;
/** @type {Promise<void>|null} */
let loading = null;
/** @type {Refuge[]} */
let refuges = [];
let releve = "";
/** @type {any} */
let L = null;
/** @type {any} */
let map = null;
/** @type {Map<string, any>} */
const markers = new Map();
/** @type {string|null} */
let selected = null;

export function isRefugesOpen() {
  return open;
}

// Ouvre la vue (à la place de la conversation). L'appelant a fermé la conversation et le calendrier.
export function openRefuges() {
  open = true;
  $("chat-empty").hidden = true;
  $("refuges-view").hidden = false;
  $("btn-tool-refuges").classList.add("active");
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
  $("btn-tool-refuges").classList.remove("active");
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
  releve = typeof data.releve === "string" ? data.releve : "";
  renderSource();
  renderList();
  createMap();
}

// Garde-fou : le fichier est produit par le script, mais la page ne fait confiance qu'aux formes attendues.
function valid(r) {
  return r && typeof r.id === "string" && typeof r.nom === "string" && typeof r.chaine === "string"
    && typeof r.massif === "string" && Number.isFinite(r.lat) && Number.isFinite(r.lng);
}

function renderSource() {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releve)
    ? new Date(releve + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })
    : "";
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
    summary.append(dot(), document.createTextNode(chaine), count([...massifs.values()].flat().length));
    details.append(summary);

    for (const massif of [...massifs.keys()].sort((a, b) => a.localeCompare(b, "fr"))) {
      const list = massifs.get(massif).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
      const sub = document.createElement("details");
      sub.className = "refuges-massif";
      const s = document.createElement("summary");
      s.append(document.createTextNode(massif), count(list.length));
      const ul = document.createElement("ul");
      ul.className = "refuges-items";
      for (const r of list) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "refuge-item";
        b.dataset.id = r.id;
        b.dataset.search = normalize(`${r.nom} ${r.massif} ${r.chaine}`);
        const name = document.createElement("span");
        name.textContent = r.nom;
        b.append(name);
        if (r.altitude) {
          const alt = document.createElement("span");
          alt.className = "muted small";
          alt.textContent = `${r.altitude} m`;
          b.append(alt);
        }
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

// Filtre : masque les refuges qui ne correspondent pas et ouvre les massifs qui en ont.
function applyFilter() {
  const q = normalize($("refuges-filter").value.trim());
  let shown = 0;
  for (const chaine of $("refuges-groups").querySelectorAll(".refuges-chaine")) {
    let inChaine = 0;
    for (const massif of chaine.querySelectorAll(".refuges-massif")) {
      let inMassif = 0;
      for (const b of massif.querySelectorAll("button.refuge-item")) {
        const ok = !q || b.dataset.search.includes(q);
        b.parentElement.hidden = !ok;
        if (ok) inMassif++;
      }
      massif.hidden = !inMassif;
      if (q) massif.open = inMassif > 0;
      inChaine += inMassif;
    }
    chaine.hidden = !inChaine;
    if (q) chaine.open = inChaine > 0;
    shown += inChaine;
  }
  for (const [id, m] of markers) {
    const r = refuges.find((x) => x.id === id);
    const ok = !q || normalize(`${r.nom} ${r.massif} ${r.chaine}`).includes(q);
    if (ok && !map.hasLayer(m)) m.addTo(map);
    else if (!ok && map.hasLayer(m)) m.remove();
  }
  $("refuges-empty").hidden = shown > 0 || !refuges.length;
}

$("refuges-filter").addEventListener("input", applyFilter);

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
 * @param {string} id
 * @param {{ pan: boolean }} options  pan : centrer la carte sur le refuge (clic dans la liste)
 */
function showRefuge(id, { pan }) {
  const r = refuges.find((x) => x.id === id);
  if (!r) return;
  highlight(id);
  if (pan && map) map.setView([r.lat, r.lng], Math.max(map.getZoom(), 12));

  $("refuge-title").textContent = r.nom;
  $("refuge-where").textContent = `${r.massif} · ${r.chaine}`;

  const facts = [];
  if (r.altitude) facts.push(["Altitude", `${r.altitude} m`]);
  if (r.places) facts.push(["Places", String(r.places)]);
  if (r.telephone) facts.push(["Téléphone", r.telephone]);
  facts.push(["Position", `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`]);
  $("refuge-facts").replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    if (k === "Téléphone") dd.append(...phoneNodes(v));
    else dd.textContent = v;
    return [dt, dd];
  }));

  $("refuge-desc").textContent = r.description || "";
  $("refuge-desc").hidden = !r.description;

  const links = [];
  if (r.site) links.push(["Site du refuge", r.site]);
  if (r.tarifs) links.push(["Tarifs et réservation", r.tarifs]);
  links.push(["Voir sur OpenStreetMap", `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=15/${r.lat}/${r.lng}`]);
  $("refuge-links").replaceChildren(...links.filter(([, href]) => /^https?:\/\//.test(href)).map(([label, href]) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    li.append(a);
    return li;
  }));

  if (!$("dlg-refuge").open) $("dlg-refuge").showModal();
}

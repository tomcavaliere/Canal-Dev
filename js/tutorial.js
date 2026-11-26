// Tutoriel : quelques étapes qui présentent l'application. Il s'ouvre seul à la première arrivée
// sur l'application (une fois par compte et par navigateur), puis sur demande (⚙️ Paramètres →
// Mon compte → « Revoir le tutoriel »). Le fait de l'avoir vu est gardé dans ce navigateur seulement
// (clé « canal-dev.tutorial.<uid> », effacée avec les autres à la suppression du compte).

import { $ } from "./ui.js";
import { state } from "./state.js";

const KEY_PREFIX = "canal-dev.tutorial.";

/**
 * @typedef {{ icon: string, title: string, items: string[], admin?: boolean }} Step
 * `admin` : étape montrée à l'administrateur seulement.
 */

/** @type {Step[]} */
const STEPS = [
  {
    icon: "👋",
    title: "Bienvenue sur Canal Dev",
    items: [
      "Canal Dev réunit les échanges sur le développement de l'outil : conversations, projets, calendrier et tâches.",
      "Ce tutoriel tient en quelques étapes. Tu peux le revoir à tout moment avec le bouton « ? » en haut de l'écran.",
    ],
  },
  {
    icon: "💬",
    title: "Les conversations",
    items: [
      "La liste à gauche montre les conversations auxquelles l'administrateur t'a donné accès, rangées par projet et triées par dernière activité.",
      "Une pastille indique les messages non lus, synchronisés entre tes appareils.",
      "Sur téléphone, la flèche ← en haut ramène à la liste.",
    ],
  },
  {
    icon: "✏️",
    title: "Écrire un message",
    items: [
      "Entrée envoie le message, Maj + Entrée va à la ligne.",
      "📷 joint une photo (ses métadonnées sont retirées), 😊 insère un emoji, 👍 envoie un pouce levé.",
      "Sous chaque message : « Répondre », 🙂+ pour réagir, et « Modifier » ou « Supprimer » sur les tiens.",
      "Les liens deviennent cliquables et le texte entre `accents graves` s'affiche comme du code.",
    ],
  },
  {
    icon: "🔍",
    title: "Retrouver une information",
    items: [
      "🔍 en haut d'une conversation cherche dans ses messages chargés.",
      "📌 regroupe les messages épinglés par l'administrateur, sous l'en-tête de la conversation.",
      "🔗 rassemble les liens utiles de la conversation, juste au-dessus de la zone de saisie.",
    ],
  },
  {
    icon: "📁",
    title: "Les projets",
    items: [
      "Sous le nom d'un projet, la barre latérale affiche ses rôles (et qui les tient) et ses liens.",
      "🏢 ouvre l'organigramme du projet : les rôles du plus haut niveau au plus bas.",
    ],
  },
  {
    icon: "📅",
    title: "Le calendrier",
    items: [
      "📅 à côté du nom d'un projet ouvre son calendrier, partagé par tous ses membres.",
      "Crée une réunion et invites-y des membres : chacun répond « présent » ou « absent ». Une pastille sur le 📅 compte tes invitations sans réponse.",
      "Ajoute des objectifs, avec ou sans échéance, et coche-les une fois atteints.",
    ],
  },
  {
    icon: "✅",
    title: "Les tâches",
    items: [
      "✅ à côté du nom d'un projet ouvre sa liste de tâches.",
      "Ajoute une tâche, nomme un responsable ou laisse-la libre : « Je m'en occupe » permet de la prendre.",
      "Une tâche cochée passe dans « Terminées », avec qui l'a faite et quand : l'historique du projet est gardé.",
    ],
  },
  {
    icon: "📁",
    title: "Les fichiers",
    items: [
      "📁 à côté du nom d'un projet ouvre sa zone de dépôt, partagée par tous ses membres.",
      "Glisse-y des fichiers HTML, Markdown, texte, CSV, JSON ou de code (900 Ko au plus chacun).",
      "Un clic sur un fichier l'affiche : le Markdown est mis en forme, une page HTML s'ouvre dans un aperçu isolé. Tu peux aussi le copier ou le télécharger.",
    ],
  },
  {
    icon: "🛠️",
    title: "Administration",
    admin: true,
    items: [
      "« + Conversation » et « + Projet » en haut de la barre latérale ; le ✎ d'un projet règle son logo, ses rôles, son organigramme et ses liens.",
      "En haut d'une conversation : « Membres », « Renommer », « Déplacer » et « Supprimer ». « Épingler » apparaît sous chaque message.",
      "La liste « Utilisateurs » montre les comptes en attente d'accès et fixe le nom affiché de chacun ; « + Inviter » prépare l'accès d'une adresse Gmail avant sa première connexion.",
      "L'administrateur principal donne ou retire les droits d'administration depuis le ✎ d'un utilisateur.",
    ],
  },
  {
    icon: "⚙️",
    title: "Paramètres",
    items: [
      "⚙️ en haut à droite ouvre les paramètres : ton compte, le tutoriel, le téléchargement ou la suppression de tes données.",
      "« Notifications » coupe ou remet le son des nouveaux messages et active les notifications, même application fermée (sur iPhone : après l'ajout à l'écran d'accueil).",
      "« Apparence » règle le thème clair ou sombre ; « Confidentialité », les accusés de lecture et la présence « en ligne ».",
      "Canal Dev s'installe comme une application depuis le menu de ton navigateur.",
    ],
  },
];

/** @type {Step[]} */
let steps = [];
let index = 0;
let initialized = false;

/** @param {string} uid */
function storageKey(uid) {
  return KEY_PREFIX + uid;
}

function markSeen() {
  if (!state.user) return;
  try { localStorage.setItem(storageKey(state.user.uid), "1"); } catch { /* stockage indisponible */ }
}

/** @param {string} uid */
function seen(uid) {
  try { return localStorage.getItem(storageKey(uid)) === "1"; } catch { return true; } // sans stockage : pas d'ouverture à chaque visite
}

function draw() {
  const step = steps[index];
  const last = index === steps.length - 1;
  $("tuto-icon").textContent = step.icon;
  $("tuto-title").textContent = step.title;
  $("tuto-items").replaceChildren(...step.items.map((text) => {
    const li = document.createElement("li");
    // Texte entre accents graves : affiché comme du code, comme dans les messages.
    text.split(/(`[^`]+`)/).forEach((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        li.append(Object.assign(document.createElement("code"), { textContent: part.slice(1, -1) }));
      } else if (part) {
        li.append(part);
      }
    });
    return li;
  }));
  $("tuto-progress").textContent = `Étape ${index + 1} sur ${steps.length}`;
  $("tuto-dots").replaceChildren(...steps.map((_, i) => {
    const dot = document.createElement("span");
    dot.className = "tuto-dot" + (i === index ? " current" : "");
    return dot;
  }));
  /** @type {HTMLButtonElement} */ ($("btn-tuto-prev")).hidden = index === 0;
  $("btn-tuto-skip").hidden = last;
  $("btn-tuto-next").textContent = last ? "C'est parti !" : "Suivant";
}

/** @param {number} delta */
function go(delta) {
  const next = index + delta;
  if (next < 0) return;
  if (next >= steps.length) {
    /** @type {HTMLDialogElement} */ ($("dlg-tutorial")).close();
    return;
  }
  index = next;
  draw();
  $("btn-tuto-next").focus();
}

function init() {
  if (initialized) return;
  initialized = true;
  const dlg = /** @type {HTMLDialogElement} */ ($("dlg-tutorial"));
  $("btn-tuto-next").addEventListener("click", () => go(1));
  $("btn-tuto-prev").addEventListener("click", () => go(-1));
  $("btn-tuto-skip").addEventListener("click", () => dlg.close());
  // Fermé de n'importe quelle façon (bouton, Échap) : considéré comme vu.
  dlg.addEventListener("close", markSeen);
  dlg.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
  });
}

// Ouvre le tutoriel à la première étape.
export function openTutorial() {
  init();
  steps = STEPS.filter((s) => !s.admin || state.isAdmin);
  index = 0;
  draw();
  const dlg = /** @type {HTMLDialogElement} */ ($("dlg-tutorial"));
  if (!dlg.open) dlg.showModal();
  $("btn-tuto-next").focus();
}

// À l'arrivée sur l'application : ouvre le tutoriel s'il n'a jamais été vu avec ce compte dans ce
// navigateur, et si aucun autre dialogue n'est déjà ouvert (notification, lien direct…).
export function maybeShowTutorial() {
  if (!state.user || seen(state.user.uid)) return;
  if (document.querySelector("dialog[open]")) return;
  openTutorial();
}

// Bouton « Revoir le tutoriel » des paramètres (⚙️ → Mon compte).
export function initTutorial() {
  $("btn-account-tutorial").addEventListener("click", () => {
    /** @type {HTMLDialogElement} */ ($("dlg-settings")).close();
    openTutorial();
  });
}

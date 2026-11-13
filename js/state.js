// État partagé de la session (utilisateur, conversations, conversation ouverte…) et petits
// prédicats d'affichage. Les modules lisent et modifient directement cet objet.

import { $ } from "./ui.js";

export const state = {
  user: null,
  isAdmin: false,
  conversations: new Map(), // id -> data
  convsLoaded: false,
  projects: new Map(), // id -> data (null si le projet n'existe plus)
  projectsLoaded: false, // admin : liste complète des projets reçue
  selectedId: null,
  calendarProjectId: null, // projet dont le calendrier est affiché (à la place d'une conversation)
  unsubConvs: null,
  unsubProjects: null, // admin : écoute de toute la collection
  projectSubs: new Map(), // non-admin : id -> unsubscribe (un écouteur par projet visible)
  unsubMessages: null,
  unsubReads: null,
  reads: null, // conversation ouverte : uid -> { name, t } (null tant que non chargé)
  myReads: null, // ses propres accusés, toutes conversations : id -> date de lecture (null tant que non chargé)
  unsubMyReads: null,
  unsubInvite: null,
  readWrite: 0, // date du dernier message dont on a déjà envoyé l'accusé de lecture
  msgWatchers: new Map(), // id de conversation -> unsubscribe (écoute des messages non lus)
  recent: new Map(), // id de conversation -> [{ t, authorUid }] messages reçus depuis la dernière lecture
  unread: new Map(), // id de conversation -> nombre de messages non lus
  msgById: new Map(), // messages chargés de la conversation ouverte : id -> data
  msgDocs: null, // derniers documents affichés (pour réafficher quand l'annuaire des noms change)
  pending: new Set(), // identifiants des messages de la conversation ouverte pas encore confirmés par le serveur
  msgLimit: 0, // taille de la fenêtre de messages écoutée (agrandie par « Charger les messages précédents »)
  hasMore: false, // la fenêtre est pleine : il existe peut-être des messages plus anciens
  loadingMore: false,
  revealId: null, // message cité à montrer dès qu'il sera chargé
  replyTo: null, // identifiant du message auquel on répond
  editing: null, // { id, draft } : son message en cours de modification
  admin: null, // API renvoyée par admin.js
  noReceipts: false, // réglage du profil : ne pas envoyer d'accusés de lecture
  noPresence: false, // réglage du profil : ne pas montrer sa présence « en ligne »
};

export function isViewing(convId) {
  return !document.hidden && convId === state.selectedId
    && (!isMobile() || $("screen-app").classList.contains("show-chat"));
}

export function isMobile() {
  return window.matchMedia("(max-width: 720px)").matches;
}

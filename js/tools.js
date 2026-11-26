// Outils qu'un administrateur attache à un projet (champ `tools` du projet, liste d'identifiants).
// Un outil n'est montré qu'aux membres des conversations de ce projet (et aux admins), sous le nom du projet
// dans la barre latérale. Ajouter un outil : une entrée ici, son identifiant dans validProject() de
// firestore.rules, et son ouverture dans openProjectTool (js/app.js).

import { state } from "./state.js";

/** @typedef {{ id: string, icon: string, name: string, description: string }} Tool */

/** @type {Tool[]} */
export const TOOLS = [
  {
    id: "refuges-ffcam",
    icon: "⛰️",
    name: "Refuges FFCAM",
    description: "Carte OpenStreetMap et liste par massif des refuges et chalets du Club alpin",
  },
];

// Outils d'un projet, dans l'ordre du catalogue ; les identifiants inconnus sont ignorés.
/** @returns {Tool[]} */
export function toolsOf(p) {
  if (!p || !Array.isArray(p.tools)) return [];
  return TOOLS.filter((t) => p.tools.includes(t.id));
}

// L'utilisateur peut-il ouvrir cet outil ? Le projet doit l'avoir, et lui être visible : admin, ou
// membre d'une de ses conversations.
/**
 * @param {string} projectId
 * @param {string} toolId
 */
export function canUseTool(projectId, toolId) {
  const p = state.projects.get(projectId);
  if (!toolsOf(p).some((t) => t.id === toolId)) return false;
  return state.isAdmin || [...state.conversations.values()].some((c) => c.projectId === projectId);
}

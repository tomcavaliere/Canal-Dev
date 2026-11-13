// Organigramme d'un projet : ses rôles rangés par niveau (défini par l'admin dans le dialogue
// du projet), avec les personnes qui les tiennent. Lecture seule, ouvert depuis la barre latérale.

import { $ } from "./ui.js";
import { state } from "./state.js";
import { holderNames, projectColor, projectOrgLevels } from "./sidebar.js";

/** @type {string | null} */
let openProjectId = null;

export function openOrgChart(projectId) {
  openProjectId = projectId;
  const dlg = /** @type {HTMLDialogElement} */ ($("dlg-org"));
  if (draw(dlg) && !dlg.open) dlg.showModal();
}

// Réaffiche l'organigramme ouvert (projet modifié, noms arrivés).
export function renderOrgChart() {
  const dlg = /** @type {HTMLDialogElement} */ ($("dlg-org"));
  if (dlg.open) draw(dlg);
}

// Faux (et dialogue fermé) si le projet a disparu ou n'a plus d'organigramme.
function draw(dlg) {
  const p = openProjectId ? state.projects.get(openProjectId) : null;
  const levels = projectOrgLevels(p);
  if (!p || !levels.length) {
    if (dlg.open) dlg.close();
    return false;
  }
  dlg.style.setProperty("--proj", projectColor(openProjectId));
  $("org-title").textContent = `Organigramme de « ${p.title || "(sans titre)"} »`;
  // Le niveau n'est pas écrit : il se lit à la position de la ligne.
  const items = levels.map((level, i) => {
    const li = document.createElement("li");
    li.className = "org-level";
    li.setAttribute("aria-label", `Niveau ${i + 1}`);
    const cards = document.createElement("ul");
    cards.className = "org-cards";
    for (const role of level.roles) {
      const card = document.createElement("li");
      card.className = "org-card";
      const name = document.createElement("span");
      name.className = "org-role";
      name.textContent = role.name;
      const names = holderNames(role.uids);
      const people = document.createElement("span");
      people.className = "org-people small" + (names.length ? "" : " muted");
      people.textContent = names.length ? names.join(", ") : "à pourvoir";
      card.append(name, people);
      cards.append(card);
    }
    if (!level.roles.length) {
      cards.append(Object.assign(document.createElement("li"), { className: "muted small", textContent: "Aucun rôle." }));
    }
    li.append(cards);
    return li;
  });
  $("org-levels").replaceChildren(...items);
  return true;
}

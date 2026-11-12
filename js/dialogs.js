// Remplace alert() et confirm() : dialogues et messages intégrés à la page, au style du site,
// sans bloquer les écoutes en temps réel pendant qu'ils sont affichés.

let dlg = null;

function confirmElement() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "confirm-dlg";
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "stack";
  const text = document.createElement("p");
  text.className = "confirm-text";
  const row = document.createElement("div");
  row.className = "row end";
  const cancel = document.createElement("button");
  cancel.className = "btn confirm-cancel";
  cancel.value = "cancel";
  cancel.textContent = "Annuler";
  const ok = document.createElement("button");
  ok.className = "btn confirm-ok";
  ok.value = "ok";
  row.append(cancel, ok);
  form.append(text, row);
  dlg.append(form);
  document.body.append(dlg);
  return dlg;
}

// Résout true si la personne confirme, false si elle annule (bouton, Échap).
// `cancel: false` : simple information, avec un seul bouton.
/**
 * @param {string} message
 * @param {{ ok?: string, danger?: boolean, cancel?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message, { ok = "Confirmer", danger = false, cancel = true } = {}) {
  const d = confirmElement();
  if (d.open) d.close();
  d.querySelector(".confirm-text").textContent = message;
  const okBtn = d.querySelector(".confirm-ok");
  const cancelBtn = d.querySelector(".confirm-cancel");
  okBtn.textContent = ok;
  okBtn.className = "btn confirm-ok " + (danger ? "danger" : "primary");
  cancelBtn.hidden = !cancel;
  d.returnValue = "";
  d.showModal();
  // Action destructrice : le focus reste sur « Annuler », une validation au clavier par réflexe ne supprime rien.
  (danger && cancel ? cancelBtn : okBtn).focus();
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
  });
}

// Zone des messages : dans le dialogue modal ouvert s'il y en a un (sinon le message serait
// caché derrière son fond), dans la page sinon.
function toastBox() {
  const modals = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal"));
  const host = modals.at(-1) || document.body;
  let box = [...host.children].find((el) => el.classList.contains("toasts"));
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    host.append(box);
  }
  return box;
}

// Message bref en bas de l'écran, qui disparaît seul (les erreurs restent plus longtemps).
/**
 * @param {string} message
 * @param {{ error?: boolean, timeout?: number }} [options] durée d'affichage en millisecondes
 */
export function toast(message, { error = false, timeout = error ? 10000 : 5000 } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  const text = document.createElement("span");
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Fermer le message");
  close.addEventListener("click", () => el.remove());
  el.append(text, close);
  toastBox().append(el);
  setTimeout(() => el.remove(), timeout);
}

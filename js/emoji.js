// Emojis : réactions aux messages (liste fixe, vérifiée par les règles), sélecteur pour la
// saisie, et petit menu flottant commun aux deux.

// Doit rester identique à la liste de firestore.rules (validReaction).
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Sélecteur de la zone de saisie : emojis courants, par groupe.
const GROUPS = Object.entries({
  Visages: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤭 🤔 🤨 😐 😑 😶 🙄 😏 😬 😌 😴 😷 🤒 🤯 🥳 😎 🤓 🧐 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😤 😡 🤬 😈 💀 🤡 👻 🤖",
  Gestes: "👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 👋 👏 🙌 🤝 🙏 💪 ✍️ 👀",
  Cœurs: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 💯 💥 💫 ✨ 🔥 ⭐ 🌟",
  Objets: "🎉 🎊 🎁 🏆 🥇 ⚽ 🚴 🏃 ☕ 🍺 🍕 🍰 💻 📱 📷 📌 📎 ✅ ❌ ⚠️ ❓ ❗ 💡 🔔 ⏰ 📅 🚀 🌍 ☀️ 🌧️ ❄️ 🌈",
}).map(([name, list]) => /** @type {[string, string[]]} */ ([name, list.split(" ")]));

// Message composé uniquement de quelques emojis : affiché en grand.
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\s)+$/u;
const segmenter = new Intl.Segmenter("fr", { granularity: "grapheme" });

/** @param {string} text */
export function isJumbo(text) {
  const t = text.trim();
  if (!t || t.length > 40 || !EMOJI_ONLY_RE.test(t)) return false;
  let n = 0;
  for (const s of segmenter.segment(t)) if (s.segment.trim() && ++n > 3) return false;
  return n > 0;
}

/* ---------- Menu flottant ---------- */

let menu = null; // { el, anchor, close }

export function closeEmojiMenu() {
  if (!menu) return;
  const { el, anchor } = menu;
  menu = null;
  el.remove();
  anchor.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", closeEmojiMenu);
  document.getElementById("messages")?.removeEventListener("scroll", closeEmojiMenu);
}

function onOutside(e) {
  if (menu && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeEmojiMenu();
}

function onKey(e) {
  if (!menu) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    const { anchor } = menu;
    closeEmojiMenu();
    anchor.focus();
    return;
  }
  // Flèches : déplacement entre les emojis du menu.
  const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: menu.cols, ArrowUp: -menu.cols };
  if (!(e.key in keys) || !menu.el.contains(document.activeElement)) return;
  e.preventDefault();
  const btns = [...menu.el.querySelectorAll("button")];
  const i = btns.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  btns[Math.max(0, Math.min(btns.length - 1, i + keys[e.key]))]?.focus();
}

function emojiButton(emoji, label, onPick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "emoji-btn";
  b.textContent = emoji;
  b.setAttribute("aria-label", label || emoji);
  b.addEventListener("click", () => onPick(emoji));
  return b;
}

/**
 * Ouvre (ou referme, si déjà ouvert sur ce bouton) un menu d'emojis sous/au-dessus de `anchor`.
 * @param {HTMLElement} anchor
 * @param {{ emojis?: string[], label: string, keepOpen?: boolean, onPick: (emoji: string) => void }} opts
 *   `emojis` : liste simple (réactions) ; sinon le sélecteur complet par groupes.
 */
export function toggleEmojiMenu(anchor, { emojis, label, keepOpen = false, onPick }) {
  if (menu?.anchor === anchor) {
    closeEmojiMenu();
    return;
  }
  closeEmojiMenu();
  const el = document.createElement("div");
  el.className = "emoji-menu" + (emojis ? " compact" : "");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", label);
  const pick = (emoji) => {
    if (!keepOpen) closeEmojiMenu();
    onPick(emoji);
  };
  if (emojis) {
    for (const e of emojis) el.append(emojiButton(e, null, pick));
  } else {
    for (const [name, list] of GROUPS) {
      const h = document.createElement("p");
      h.className = "emoji-group";
      h.textContent = name;
      const grid = document.createElement("div");
      grid.className = "emoji-grid";
      for (const e of list) grid.append(emojiButton(e, null, pick));
      el.append(h, grid);
    }
  }
  document.body.append(el);
  menu = { el, anchor, cols: emojis ? emojis.length : 8 };
  anchor.setAttribute("aria-expanded", "true");
  place(el, anchor);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", closeEmojiMenu);
  document.getElementById("messages")?.addEventListener("scroll", closeEmojiMenu);
  /** @type {HTMLElement | null} */ (el.querySelector("button"))?.focus({ preventScroll: true });
}

// Au-dessus du bouton s'il y a la place, sinon en dessous ; toujours dans l'écran.
function place(el, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const margin = 8;
  const left = Math.min(Math.max(margin, r.right - w), window.innerWidth - w - margin);
  const top = r.top - h - 6 >= margin ? r.top - h - 6 : Math.min(r.bottom + 6, window.innerHeight - h - margin);
  el.style.left = `${Math.max(margin, left)}px`;
  el.style.top = `${Math.max(margin, top)}px`;
}

// Effet sonore à la réception d'un message (activable / désactivable, préférence locale).
// Le son est synthétisé avec Web Audio : aucun fichier à charger.

const KEY = "canal-dev.sound";
let enabled = (() => {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
})();
let ctx = null;

// Les navigateurs n'autorisent l'audio qu'après une interaction de l'utilisateur :
// le contexte est créé (ou relancé) au premier clic ou à la première touche.
function unlock() {
  if (!enabled) return;
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
  } catch { /* audio indisponible */ }
}
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);

export function isSoundEnabled() {
  return enabled;
}

export function setSoundEnabled(on) {
  enabled = on;
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* ignoré */ }
  if (on) unlock();
}

// Petit « ding » à deux notes.
export function playMessageSound() {
  if (!enabled || !ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  [[880, 0], [1320, 0.09]].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + delay;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  });
}

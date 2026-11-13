// Préparation des photos avant envoi.
// Le ré-encodage via <canvas> produit un JPEG neuf : toutes les métadonnées de
// l'original (EXIF : position GPS, date, appareil, etc.) sont supprimées.
// Une miniature est produite en même temps : c'est elle qui est affichée dans le fil.

const MAX_CHARS = 900_000;          // limite des règles Firestore (document < 1 Mio)
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const SIDES = [1600, 1280, 1024, 800];
const QUALITIES = [0.82, 0.7, 0.55];

const THUMB_MAX_CHARS = 60_000;     // limite des règles (miniature d'environ 45 Ko)
const THUMB_SIDES = [480, 400, 320];
const THUMB_QUALITIES = [0.7, 0.55, 0.4];

/**
 * @typedef {{ data: string, w: number, h: number, thumb: string }} PreparedImage
 * `data` : JPEG en data URL ; `thumb` : miniature JPEG en data URL.
 */

/**
 * @param {File} file
 * @returns {Promise<PreparedImage>}
 */
export async function prepareImage(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Ce fichier n'est pas une image.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("Image trop lourde (30 Mo maximum).");

  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Format d'image non pris en charge : utilise du JPEG, PNG ou WebP.");
  }
  try {
    const full = encode(bmp, SIDES, QUALITIES, MAX_CHARS);
    const thumb = encode(bmp, THUMB_SIDES, THUMB_QUALITIES, THUMB_MAX_CHARS);
    if (!full || !thumb) throw new Error("Impossible de compresser suffisamment cette image.");
    return { ...full, thumb: thumb.data };
  } finally {
    bmp.close();
  }
}

/* ---------- Logo de projet ---------- */

const LOGO_MAX_CHARS = 60_000;      // limite des règles (projects/{id}.logo)
const LOGO_SIDES = [256, 192, 128, 96];

/**
 * Logo de projet : réduit à 256 px au plus et ré-encodé (métadonnées supprimées).
 * PNG en priorité (transparence conservée), sinon WebP, sinon JPEG sur fond blanc.
 * @param {File} file
 * @returns {Promise<string>} data URL
 */
export async function prepareLogo(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Ce fichier n'est pas une image.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("Image trop lourde (30 Mo maximum).");
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Format d'image non pris en charge : utilise du PNG, JPEG ou WebP.");
  }
  try {
    for (const side of LOGO_SIDES) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL("image/png");
      if (png.length <= LOGO_MAX_CHARS) return png;
      // Navigateur sans encodeur WebP : toDataURL renvoie du PNG, écarté par le préfixe.
      const webp = canvas.toDataURL("image/webp", 0.85);
      if (webp.startsWith("data:image/webp") && webp.length <= LOGO_MAX_CHARS) return webp;
    }
    const jpeg = encode(bmp, LOGO_SIDES, QUALITIES, LOGO_MAX_CHARS);
    if (!jpeg) throw new Error("Impossible de compresser suffisamment ce logo.");
    return jpeg.data;
  } finally {
    bmp.close();
  }
}

/**
 * Logo affichable : uniquement une image en data URL (jamais une adresse externe).
 * @param {unknown} v
 * @returns {v is string}
 */
export function isLogo(v) {
  return typeof v === "string" && /^data:image\/(png|webp|jpeg);base64,/.test(v);
}

// Premier encodage (du plus grand au plus petit, de la meilleure qualité à la moins bonne)
// qui tient dans `maxChars`.
function encode(bmp, sides, qualities, maxChars) {
  for (const side of sides) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // fond blanc pour les PNG transparents
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    for (const q of qualities) {
      const data = canvas.toDataURL("image/jpeg", q);
      if (data.length <= maxChars) return { data, w, h };
    }
  }
  return null;
}

// Préparation des photos avant envoi.
// Le ré-encodage via <canvas> produit un JPEG neuf : toutes les métadonnées de
// l'original (EXIF : position GPS, date, appareil, etc.) sont supprimées.

const MAX_CHARS = 900_000;          // limite des règles Firestore (document < 1 Mio)
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
const SIDES = [1600, 1280, 1024, 800];
const QUALITIES = [0.82, 0.7, 0.55];

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
    for (const side of SIDES) {
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
      for (const q of QUALITIES) {
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= MAX_CHARS) return { data, w, h };
      }
    }
  } finally {
    bmp.close();
  }
  throw new Error("Impossible de compresser suffisamment cette image.");
}

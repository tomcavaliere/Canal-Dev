// Consommation des quotas Firebase, lue dans Cloud Monitoring (API REST v3, lecture seule et gratuite).
// Appelée par la fonction `firebaseUsage` (index.js) pour le panneau « Quotas » des paramètres (admins).
//
// Les seuils sont les quotas gratuits du plan Blaze (au-delà, c'est facturé) :
// https://firebase.google.com/pricing
// Firestore se remet à zéro chaque jour à minuit, heure du Pacifique ; les quotas mensuels, au début du mois.

const MONITORING = "https://monitoring.googleapis.com/v3/projects";
const PACIFIC = "America/Los_Angeles";
const GB = 1e9;
const GIB = 1024 ** 3;
const DAY = 86400_000;

/**
 * @typedef {"count" | "bytes"} Unit
 * @typedef {{ id: string, group: string, label: string, metric: string, kind: "delta" | "gauge",
 *   period: "day" | "month" | "now", limit: number, unit: Unit, resource?: string, history?: boolean }} Quota
 */

/** @type {Quota[]} */
export const QUOTAS = [
  { id: "fs-reads", group: "Cloud Firestore", label: "Lectures", metric: "firestore.googleapis.com/document/read_count",
    kind: "delta", period: "day", limit: 50_000, unit: "count", history: true },
  { id: "fs-writes", group: "Cloud Firestore", label: "Écritures", metric: "firestore.googleapis.com/document/write_count",
    kind: "delta", period: "day", limit: 20_000, unit: "count", history: true },
  { id: "fs-deletes", group: "Cloud Firestore", label: "Suppressions", metric: "firestore.googleapis.com/document/delete_count",
    kind: "delta", period: "day", limit: 20_000, unit: "count", history: true },
  { id: "fs-storage", group: "Cloud Firestore", label: "Stockage (données et index)",
    metric: "firestore.googleapis.com/storage/data_and_index_storage_bytes", kind: "gauge", period: "now", limit: GIB, unit: "bytes" },
  { id: "rtdb-storage", group: "Realtime Database (présence)", label: "Stockage",
    metric: "firebasedatabase.googleapis.com/storage/total_bytes", kind: "gauge", period: "now", limit: GB, unit: "bytes" },
  { id: "rtdb-sent", group: "Realtime Database (présence)", label: "Téléchargements",
    metric: "firebasedatabase.googleapis.com/network/monthly_sent", kind: "gauge", period: "month", limit: 10 * GB, unit: "bytes" },
  { id: "rtdb-conn", group: "Realtime Database (présence)", label: "Connexions simultanées",
    metric: "firebasedatabase.googleapis.com/network/active_connections", kind: "gauge", period: "now", limit: 200_000, unit: "count" },
  { id: "hosting-storage", group: "Hosting", label: "Stockage",
    metric: "firebasehosting.googleapis.com/storage/total_bytes", kind: "gauge", period: "now", limit: 10 * GB, unit: "bytes" },
  { id: "hosting-sent", group: "Hosting", label: "Transfert",
    metric: "firebasehosting.googleapis.com/network/monthly_sent", kind: "gauge", period: "month", limit: 10 * GB, unit: "bytes" },
  { id: "fn-calls", group: "Cloud Functions", label: "Appels", metric: "run.googleapis.com/request_count",
    resource: "cloud_run_revision", kind: "delta", period: "month", limit: 2_000_000, unit: "count" },
];

// Décalage (ms) entre l'heure locale du fuseau `tz` et UTC, à l'instant `date`.
/** @param {string} tz @param {Date} date */
function tzOffset(tz, date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Début du jour (ou du mois) en cours dans le fuseau `tz`, en heure UTC.
/** @param {Date} now @param {"day" | "month"} unit @param {string} [tz] */
export function periodStart(now, unit, tz = PACIFIC) {
  const local = new Date(now.getTime() + tzOffset(tz, now));
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), unit === "month" ? 1 : local.getUTCDate());
  // Le décalage à minuit peut différer de celui de maintenant (changement d'heure) : on le recalcule.
  const guess = new Date(startLocal - tzOffset(tz, now));
  return new Date(startLocal - tzOffset(tz, guess));
}

// Valeur numérique d'un point Cloud Monitoring.
/** @param {any} point */
export function pointValue(point) {
  const v = point?.value ?? {};
  return Number(v.int64Value ?? v.doubleValue ?? 0) || 0;
}

/**
 * @param {(opts: { url: string, params: Record<string, string> }) => Promise<{ data: any }>} request
 * @param {string} project
 * @param {Record<string, string>} params
 */
async function listSeries(request, project, params) {
  const series = [];
  let pageToken;
  do {
    const { data } = await request({
      url: `${MONITORING}/${project}/timeSeries`,
      params: { ...params, ...(pageToken ? { pageToken } : {}) },
    });
    series.push(...(data.timeSeries ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return series;
}

/** @param {Quota} q */
function filterOf(q) {
  return `metric.type = "${q.metric}"` + (q.resource ? ` AND resource.type = "${q.resource}"` : "");
}

// Somme d'un compteur (DELTA) sur [start, end], découpée en tranches de `stepMs` (une seule par défaut).
// Les tranches sont alignées sur `end` : avec `end` à minuit (Pacifique), une tranche = un jour.
/** @returns {Promise<number[]>} une valeur par tranche, de la plus ancienne à la plus récente */
async function sumDelta(request, project, q, start, end, stepMs = end - start) {
  const step = Math.max(60, Math.round(stepMs / 1000));
  const n = Math.max(1, Math.round((end - start) / (step * 1000)));
  const from = new Date(end - n * step * 1000);
  const series = await listSeries(request, project, {
    filter: filterOf(q),
    "interval.startTime": from.toISOString(),
    "interval.endTime": new Date(end).toISOString(),
    "aggregation.alignmentPeriod": `${step}s`,
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
  });
  const buckets = new Array(n).fill(0);
  for (const s of series) {
    for (const p of s.points ?? []) {
      const t = Date.parse(p.interval?.endTime);
      const i = n - Math.round((end - t) / (step * 1000));
      if (i >= 1 && i <= n) buckets[i - 1] += pointValue(p);
    }
  }
  return buckets;
}

// Dernière valeur connue d'une jauge (somme sur les bases, domaines… concernés), sur les 3 derniers jours.
// Certaines ne sont relevées qu'une fois par jour (stockage de la Realtime Database).
async function lastGauge(request, project, q, now) {
  const series = await listSeries(request, project, {
    filter: filterOf(q),
    "interval.startTime": new Date(now - 3 * DAY).toISOString(),
    "interval.endTime": new Date(now).toISOString(),
  });
  if (!series.length) return { value: null, at: null };
  let value = 0;
  let at = null;
  for (const s of series) {
    const p = s.points?.[0]; // les points sont rendus du plus récent au plus ancien
    if (!p) continue;
    value += pointValue(p);
    const t = p.interval?.endTime;
    if (t && (!at || t > at)) at = t;
  }
  return { value, at };
}

/**
 * Relevé de tous les quotas. Une métrique en échec n'empêche pas les autres (`error` sur la ligne).
 * @param {Parameters<typeof listSeries>[0]} request client HTTP authentifié (google-auth-library)
 * @param {string} project identifiant du projet
 * @param {Date} [now]
 */
export async function collectUsage(request, project, now = new Date()) {
  const t = now.getTime();
  const dayStart = periodStart(now, "day").getTime();
  const monthStart = periodStart(now, "month").getTime();
  const rows = await Promise.all(QUOTAS.map(async (q) => {
    const row = { id: q.id, group: q.group, label: q.label, period: q.period, limit: q.limit, unit: q.unit,
      value: null, at: null, history: null, error: null };
    try {
      if (q.kind === "delta") {
        const start = q.period === "month" ? monthStart : dayStart;
        [row.value] = await sumDelta(request, project, q, start, t);
        row.at = now.toISOString();
        // 7 jours complets précédents (de minuit à minuit, heure du Pacifique).
        if (q.history) row.history = await sumDelta(request, project, q, dayStart - 7 * DAY, dayStart, DAY);
      } else {
        Object.assign(row, await lastGauge(request, project, q, t));
      }
    } catch (err) {
      const status = err?.response?.status ?? err?.status;
      row.error = status === 403 ? "forbidden" : "unavailable";
    }
    return row;
  }));
  return {
    at: now.toISOString(),
    // Prochaines remises à zéro (+ quelques heures de marge pour les jours de 23 ou 25 heures).
    resets: {
      day: periodStart(new Date(dayStart + DAY + 3 * 3600_000), "day").toISOString(),
      month: periodStart(new Date(monthStart + 32 * DAY), "month").toISOString(),
    },
    rows,
  };
}

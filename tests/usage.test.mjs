// Tests du relevé des quotas (functions/usage.js) : périodes, agrégation des réponses de Cloud Monitoring
// et erreurs. Cloud Monitoring est simulé : aucun appel réseau.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectUsage, periodStart, pointValue, QUOTAS } from "../functions/usage.js";

describe("Début de période (heure du Pacifique)", () => {
  it("jour en heure d'hiver (UTC−8)", () =>
    assert.equal(periodStart(new Date("2026-11-16T12:00:00Z"), "day").toISOString(), "2026-11-16T08:00:00.000Z"));
  it("jour en heure d'été (UTC−7)", () =>
    assert.equal(periodStart(new Date("2026-07-01T12:00:00Z"), "day").toISOString(), "2026-07-01T07:00:00.000Z"));
  it("avant minuit à Los Angeles, c'est encore la veille", () =>
    assert.equal(periodStart(new Date("2026-11-16T05:00:00Z"), "day").toISOString(), "2026-11-15T08:00:00.000Z"));
  it("jour du passage à l'heure d'hiver (minuit encore en heure d'été)", () =>
    assert.equal(periodStart(new Date("2026-11-01T20:00:00Z"), "day").toISOString(), "2026-11-01T07:00:00.000Z"));
  it("mois", () =>
    assert.equal(periodStart(new Date("2026-11-16T12:00:00Z"), "month").toISOString(), "2026-11-01T07:00:00.000Z"));
});

describe("Valeurs des points", () => {
  it("entiers (en texte) et décimaux", () => {
    assert.equal(pointValue({ value: { int64Value: "42" } }), 42);
    assert.equal(pointValue({ value: { doubleValue: 1.5 } }), 1.5);
    assert.equal(pointValue({}), 0);
  });
});

describe("Relevé", () => {
  const now = new Date("2026-11-16T12:00:00Z");

  it("additionne les séries, garde le dernier point des jauges et l'historique sur 7 jours", async () => {
    const calls = [];
    const request = async ({ params }) => {
      calls.push(params);
      const metric = params.filter.match(/metric.type = "([^"]+)"/)[1];
      if (metric.endsWith("read_count") && params["aggregation.alignmentPeriod"] === "86400s") {
        const end = Date.parse(params["interval.endTime"]);
        return { data: { timeSeries: [{ points: [6, 5, 4, 3, 2, 1, 0].map((k) => ({
          interval: { endTime: new Date(end - k * 86400_000).toISOString() }, value: { int64Value: String(100 * (7 - k)) },
        })) }] } };
      }
      if (metric.endsWith("read_count")) {
        return { data: { timeSeries: [{ points: [{ interval: { endTime: params["interval.endTime"] }, value: { int64Value: "1234" } }] }] } };
      }
      if (metric.endsWith("storage/total_bytes") && metric.startsWith("firebasedatabase")) {
        return { data: { timeSeries: [
          { points: [{ interval: { endTime: "2026-11-16T00:00:00Z" }, value: { int64Value: "300" } },
            { interval: { endTime: "2026-11-15T00:00:00Z" }, value: { int64Value: "200" } }] },
          { points: [{ interval: { endTime: "2026-11-15T12:00:00Z" }, value: { int64Value: "50" } }] },
        ] } };
      }
      return { data: {} };
    };
    const data = await collectUsage(request, "demo", now);
    const reads = data.rows.find((r) => r.id === "fs-reads");
    assert.equal(reads.value, 1234);
    assert.deepEqual(reads.history, [100, 200, 300, 400, 500, 600, 700]);
    const rtdb = data.rows.find((r) => r.id === "rtdb-storage");
    assert.equal(rtdb.value, 350);
    assert.equal(rtdb.at, "2026-11-16T00:00:00Z");
    assert.equal(data.rows.find((r) => r.id === "hosting-storage").value, null);
    assert.equal(data.rows.length, QUOTAS.length);
    // Le compteur du jour commence à minuit, heure du Pacifique.
    const daily = calls.find((p) => p.filter.includes("write_count") && p["aggregation.alignmentPeriod"] !== "86400s");
    assert.equal(daily["interval.startTime"], "2026-11-16T08:00:00.000Z");
    assert.equal(data.resets.day, "2026-11-17T08:00:00.000Z");
    assert.equal(data.resets.month, "2026-12-01T08:00:00.000Z");
    // Les fonctions se limitent aux révisions Cloud Run.
    assert.ok(calls.some((p) => p.filter.includes('resource.type = "cloud_run_revision"')));
  });

  it("suit la pagination", async () => {
    const request = async ({ params }) => {
      if (!params.filter.includes("active_connections")) return { data: {} };
      return params.pageToken
        ? { data: { timeSeries: [{ points: [{ interval: { endTime: "2026-11-16T11:00:00Z" }, value: { int64Value: "2" } }] }] } }
        : { data: { nextPageToken: "p2", timeSeries: [{ points: [{ interval: { endTime: "2026-11-16T11:00:00Z" }, value: { int64Value: "3" } }] }] } };
    };
    const data = await collectUsage(request, "demo", now);
    assert.equal(data.rows.find((r) => r.id === "rtdb-conn").value, 5);
  });

  it("une métrique en échec n'empêche pas les autres", async () => {
    const request = async ({ params }) => {
      if (params.filter.includes("firestore")) throw Object.assign(new Error("refusé"), { response: { status: 403 } });
      if (params.filter.includes("hosting")) throw new Error("réseau");
      return { data: {} };
    };
    const data = await collectUsage(request, "demo", now);
    assert.equal(data.rows.find((r) => r.id === "fs-reads").error, "forbidden");
    assert.equal(data.rows.find((r) => r.id === "hosting-sent").error, "unavailable");
    assert.equal(data.rows.find((r) => r.id === "fn-calls").error, null);
    assert.equal(data.rows.find((r) => r.id === "fn-calls").value, 0);
  });
});

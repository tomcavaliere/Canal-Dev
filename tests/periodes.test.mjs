// Tests des périodes de gardiennage des refuges FFCAM : analyse du texte libre des mini-sites
// (scripts/ffcam-periodes.mjs) et filtre « gardé du … au … » (js/periodes.js). Aucun appel réseau.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePeriodes } from "../scripts/ffcam-periodes.mjs";
import { gardeSur } from "../js/periodes.js";

const p = (debut, fin, approx = false) => ({ debut, fin, approx });

describe("Analyse des périodes de gardiennage", () => {
  it("dates exactes d'une année", () =>
    assert.deepEqual(parsePeriodes("Du 6 juin au 19 septembre 2026"),
      { statut: "garde", periodes: [p("2026-06-06", "2026-09-19")] }));
  it("plusieurs saisons, exactes et approximatives (chaque année)", () =>
    assert.deepEqual(parsePeriodes("Printemps : du 27 mars au 3 mai 2026 (selon conditions)\nÉté : début juin à début septembre"),
      { statut: "garde", periodes: [p("2026-03-27", "2026-05-03"), p("06-01", "09-01", true)] }));
  it("hiver à cheval sur deux années : l'année du début est déduite", () =>
    assert.deepEqual(parsePeriodes("Hiver : du 5 décembre au 18 avril 2027").periodes, [p("2026-12-05", "2027-04-18")]));
  it("« mi » et « fin », mois seuls, « mars et avril »", () => {
    assert.deepEqual(parsePeriodes("De mi-juin à fin septembre.").periodes, [p("06-15", "09-30", true)]);
    assert.deepEqual(parsePeriodes("De février à avril").periodes, [p("02-01", "04-30", true)]);
    assert.deepEqual(parsePeriodes("Hiver : mars et avril sur réservations").periodes, [p("03-01", "04-30", true)]);
  });
  it("dates numériques", () =>
    assert.deepEqual(parsePeriodes("hiver : du 26/02 au 24/04/2027 | été : du 04/06 au 19/09/2027").periodes,
      [p("2027-02-26", "2027-04-24"), p("2027-06-04", "2027-09-19")]));
  it("« du 19 au 23 mai » et « du 29-30-31 janvier »", () => {
    assert.deepEqual(parsePeriodes("puis du 19 au 23 mai 2026 inclus").periodes, [p("2026-05-19", "2026-05-23")]);
    assert.deepEqual(parsePeriodes("le week-end du 29-30-31 janvier 2027").periodes, [p("2027-01-29", "2027-01-31")]);
  });
  it("ouverture et fermeture au public (Goûter)", () =>
    assert.deepEqual(parsePeriodes("Ouverture du refuge au public le 29 mai 2027\nFermeture du refuge au public le 3 octobre 2027 à 7h").periodes,
      [p("2027-05-29", "2027-10-03")]));
  it("statuts sans dates", () => {
    assert.equal(parsePeriodes("Refuge non gardé").statut, "non-garde");
    assert.equal(parsePeriodes("Toute l'année").statut, "annee");
    assert.equal(parsePeriodes("Fermé jusqu'à nouvel ordre").statut, "ferme");
    assert.equal(parsePeriodes("Refuge gardé sur demande.").statut, "inconnu");
    assert.equal(parsePeriodes("").statut, "inconnu");
  });
  it("une fermeture pour travaux ne devient pas une période ouverte", () =>
    assert.deepEqual(parsePeriodes("Le refuge sera fermé pour travaux de fin-août 2026 à juin 2027"), { statut: "ferme", periodes: [] }));
  it("les dates des autres lignes restent valables malgré des travaux annoncés", () =>
    assert.deepEqual(parsePeriodes("30 mai 2026 au 28 juin 2026\nAprès le 28 juin 2026 voir les encarts travaux").periodes,
      [p("2026-05-30", "2026-06-28")]));
});

describe("Filtre « gardé du … au … »", () => {
  const ete = { statut: "garde", periodes: [p("06-15", "09-15", true)] };
  const hiver = { statut: "garde", periodes: [p("12-15", "04-15", true)] };
  const dates2026 = { statut: "garde", periodes: [p("2026-06-06", "2026-09-19")] };
  const coupe = { statut: "garde", periodes: [p("2026-03-01", "2026-05-09"), p("2026-05-10", "2026-05-20")] };
  const toute = { entiere: true };
  const unJour = { entiere: false };

  it("période annuelle : toute la plage, ou au moins un jour", () => {
    assert.equal(gardeSur(ete, "2027-07-01", "2027-07-10", toute), "oui");
    assert.equal(gardeSur(ete, "2027-09-10", "2027-09-20", toute), "non");
    assert.equal(gardeSur(ete, "2027-09-10", "2027-09-20", unJour), "oui");
    assert.equal(gardeSur(ete, "2027-11-01", "2027-11-05", unJour), "non");
  });
  it("période annuelle à cheval sur le nouvel an", () => {
    assert.equal(gardeSur(hiver, "2027-01-02", "2027-01-09", toute), "oui");
    assert.equal(gardeSur(hiver, "2026-12-28", "2027-01-03", toute), "oui");
    assert.equal(gardeSur(hiver, "2027-05-01", "2027-05-03", unJour), "non");
  });
  it("dates d'une année : connues pour cette année seulement", () => {
    assert.equal(gardeSur(dates2026, "2026-07-01", "2026-07-03", toute), "oui");
    assert.equal(gardeSur(dates2026, "2026-10-01", "2026-10-03", toute), "non");
    assert.equal(gardeSur(dates2026, "2027-07-01", "2027-07-03", toute), "inconnu");
  });
  it("deux périodes qui se suivent couvrent la plage", () =>
    assert.equal(gardeSur(coupe, "2026-05-08", "2026-05-12", toute), "oui"));
  it("statuts", () => {
    assert.equal(gardeSur({ statut: "annee" }, "2027-01-01", "2027-01-02", toute), "oui");
    assert.equal(gardeSur({ statut: "non-garde" }, "2027-07-01", "2027-07-02", unJour), "non");
    assert.equal(gardeSur({ statut: "ferme" }, "2027-07-01", "2027-07-02", unJour), "non");
    assert.equal(gardeSur({ statut: "inconnu" }, "2027-07-01", "2027-07-02", unJour), "inconnu");
    assert.equal(gardeSur(null, "2027-07-01", "2027-07-02", unJour), "inconnu");
  });
});

// Tests des règles Realtime Database (database.rules.json) : présence « en ligne ».
// Lancement : npm test (émulateurs Firestore + Realtime Database).
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails, assertSucceeds, initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { get, ref, remove, set } from "firebase/database";
import { ADMIN_UID } from "../js/firebase-config.js";

const RULES = readFileSync(new URL("../database.rules.json", import.meta.url), "utf8");
const CONN = "0b6f3c3e-4a5b-4c1d-9e8f-123456789abc";

let env;

before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-canal-dev", database: { rules: RULES } });
});
after(() => env?.cleanup());
beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database(), `status/bob/${CONN}`), true));
});

const user = (uid, email = `${uid}@gmail.com`, verified = true) =>
  env.authenticatedContext(uid, { email, email_verified: verified }).database();
const alice = () => user("alice");
const admin = () => user(ADMIN_UID, "admin@gmail.com");

describe("Présence (Realtime Database)", () => {
  it("on publie et retire sa propre présence", async () => {
    await assertSucceeds(set(ref(alice(), `status/alice/${CONN}`), true));
    await assertSucceeds(remove(ref(alice(), `status/alice/${CONN}`)));
    await assertSucceeds(remove(ref(alice(), "status/alice")));
  });
  it("seule la valeur true est acceptée, avec un identifiant de connexion court", async () => {
    await assertFails(set(ref(alice(), `status/alice/${CONN}`), false));
    await assertFails(set(ref(alice(), `status/alice/${CONN}`), { at: 1 }));
    await assertFails(set(ref(alice(), `status/alice/${"x".repeat(37)}`), true));
    await assertFails(set(ref(alice(), "status/alice"), { [CONN]: true }));
  });
  it("on ne peut ni écrire ni effacer la présence d'un autre", async () => {
    await assertFails(set(ref(alice(), `status/bob/${CONN}`), true));
    await assertFails(remove(ref(alice(), "status/bob")));
    await assertFails(remove(ref(alice(), `status/bob/${CONN}`)));
  });
  it("l'admin peut effacer la présence d'un autre (droit à l'effacement), pas l'écrire", async () => {
    await assertSucceeds(remove(ref(admin(), "status/bob")));
    await assertFails(set(ref(admin(), `status/bob/${CONN}`), true));
  });
  it("on lit la présence d'une personne par son UID, jamais la liste complète", async () => {
    await assertSucceeds(get(ref(alice(), "status/bob")));
    await assertFails(get(ref(alice(), "status")));
    await assertFails(get(ref(alice(), "/")));
  });
  it("non connecté, adresse non vérifiée ou hors Gmail : refusé", async () => {
    await assertFails(get(ref(env.unauthenticatedContext().database(), "status/bob")));
    await assertFails(set(ref(env.unauthenticatedContext().database(), `status/x/${CONN}`), true));
    await assertFails(get(ref(user("eve", "eve@gmail.com", false), "status/bob")));
    await assertFails(set(ref(user("eve", "eve@exemple.fr"), `status/eve/${CONN}`), true));
  });
});

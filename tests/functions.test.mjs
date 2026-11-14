// Tests de la Cloud Function des notifications push (functions/) : fonctions pures et cohérence
// de sa configuration avec celle du site. Aucun appel à Firebase.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ADMIN_UID, VAPID_PUBLIC_KEY } from "../js/firebase-config.js";
import { excerpt, PUSH_ENDPOINT_RE, recipientsOf } from "../functions/push-utils.js";

const SOURCE = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const constant = (name) => SOURCE.match(new RegExp(`const ${name} = "([^"]*)"`))?.[1];

describe("Configuration de la Cloud Function", () => {
  it("ADMIN_UID est identique dans functions/index.js et js/firebase-config.js", () =>
    assert.equal(constant("ADMIN_UID"), ADMIN_UID));
  it("VAPID_PUBLIC_KEY est identique dans functions/index.js et js/firebase-config.js", () =>
    assert.equal(constant("VAPID_PUBLIC_KEY"), VAPID_PUBLIC_KEY));
  it("la clé publique VAPID est une clé P-256 non compressée (65 octets)", () => {
    const key = Buffer.from(VAPID_PUBLIC_KEY, "base64url");
    assert.equal(key.length, 65);
    assert.equal(key[0], 4);
  });
  it("aucune clé privée VAPID dans le code", () =>
    assert.doesNotMatch(SOURCE, /privateKey:\s*"/));
});

describe("Destinataires", () => {
  it("membres et admins, sans l'auteur ni doublon", () =>
    assert.deepEqual(recipientsOf(["alice", "bob"], ["admin", "bob"], "alice"), ["bob", "admin"]));
  it("des membres absents ou invalides sont ignorés", () => {
    assert.deepEqual(recipientsOf(undefined, ["admin"], "x"), ["admin"]);
    assert.deepEqual(recipientsOf(["a/b", "", 3, "ok"], [], "x"), ["ok"]);
  });
});

describe("Texte de la notification", () => {
  it("raccourcit les longs messages et normalise les espaces", () => {
    assert.equal(excerpt({ text: "  a \n b " }), "a b");
    assert.equal(excerpt({ text: "x".repeat(200) }), "x".repeat(140) + "…");
  });
  it("une photo sans texte", () => assert.equal(excerpt({ text: "", image: { w: 1, h: 1 } }), "📷 Photo"));
});

describe("Adresses des services de push", () => {
  it("accepte Chrome, Firefox, Safari et Edge", () => {
    for (const u of [
      "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) assert.match(u, PUSH_ENDPOINT_RE);
  });
  it("refuse toute autre adresse", () => {
    for (const u of [
      "https://evil.example.com/x", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x",
      "https://web.push.apple.com@evil.example/x",
    ]) assert.doesNotMatch(u, PUSH_ENDPOINT_RE);
  });
});

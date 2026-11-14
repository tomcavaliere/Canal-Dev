// Tests des règles de sécurité Firestore (firestore.rules), exécutés dans l'émulateur.
// Lancement : npm test (démarre l'émulateur, exécute ces tests puis l'arrête). Java 21+ requis.
//
// Jeu de données (recréé avant chaque test) :
//   alice : membre de c1          carol : membre de c1
//   bob   : membre de c2 seulement dave  : ancien membre de c1 (a encore un message, une photo, un accusé)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails, assertSucceeds, initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  arrayRemove, arrayUnion, collection, collectionGroup, deleteDoc, deleteField, doc, getDoc, getDocs, increment,
  query, serverTimestamp, setDoc, setLogLevel, Timestamp, updateDoc, where, writeBatch,
} from "firebase/firestore";
import { ADMIN_UID } from "../js/firebase-config.js";

const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const ADMIN = RULES.match(/function adminUid\(\)\s*\{\s*return "([^"]+)"/)?.[1];
const T0 = Timestamp.fromMillis(Date.UTC(2026, 0, 1));
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

let env;

before(async () => {
  setLogLevel("error"); // les refus attendus ne doivent pas polluer la sortie
  env = await initializeTestEnvironment({ projectId: "demo-canal-dev", firestore: { rules: RULES } });
});
after(() => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(seed);
});

async function seed(ctx) {
  const db = ctx.firestore();
  const set = (path, data) => setDoc(doc(db, path), data);
  await Promise.all([
    set("users/alice", { email: "alice@gmail.com", displayName: "Alice", createdAt: T0, lastLogin: T0 }),
    set("names/alice", { name: "Alice", updatedAt: T0 }),
    set("projects/p1", { title: "Projet", description: "", createdAt: T0, updatedAt: T0 }),
    set("conversations/c1", {
      title: "Conv 1", description: "", members: ["alice", "carol"], projectId: "p1", createdAt: T0, updatedAt: T0,
    }),
    set("conversations/c2", { title: "Conv 2", description: "", members: ["bob"], createdAt: T0, updatedAt: T0 }),
    set("conversations/c1/messages/m1", { text: "Bonjour", authorUid: "alice", authorName: "Alice", createdAt: T0 }),
    set("conversations/c1/messages/m2", { text: "Salut", authorUid: "carol", authorName: "Carol", createdAt: T0 }),
    set("conversations/c1/messages/m3", {
      text: "", authorUid: "dave", authorName: "Dave", image: { w: 10, h: 10 }, createdAt: T0,
    }),
    set("conversations/c1/images/m3", { data: JPEG, authorUid: "dave", createdAt: T0 }),
    set("conversations/c1/reads/carol", { uid: "carol", lastRead: T0 }),
    // Ancien format (avec un nom) : doit rester lisible et supprimable.
    set("conversations/c1/reads/dave", { uid: "dave", name: "Dave", lastRead: T0 }),
    set("conversations/c2/messages/m4", { text: "Privé", authorUid: "bob", authorName: "Bob", createdAt: T0 }),
    // Calendrier du projet p1 : alice et carol (membres de c1) ont leur fiche ; celle de dave
    // (retiré de c1) est périmée.
    set("projects/p1/members/alice", { uid: "alice", via: "c1", at: T0 }),
    set("projects/p1/members/carol", { uid: "carol", via: "c1", at: T0 }),
    set("projects/p1/members/dave", { uid: "dave", via: "c1", at: T0 }),
    set("projects/p1/events/e1", {
      title: "Point", description: "", place: "", start: T0, end: T0, createdBy: "alice",
      attendees: ["carol"], createdAt: T0, updatedAt: T0,
    }),
    set("projects/p1/goals/g1", { title: "Version 1", done: false, createdBy: "alice", createdAt: T0, updatedAt: T0 }),
    set("projects/p1/tasks/t1", { title: "Écrire la doc", done: false, createdBy: "alice", createdAt: T0, updatedAt: T0 }),
  ]);
}

/* ---------- Contextes ---------- */

function as(uid, { email = `${uid}@gmail.com`, verified = true } = {}) {
  return env.authenticatedContext(uid, { email, email_verified: verified }).firestore();
}
const admin = () => as(ADMIN, { email: "admin@gmail.com" });
const alice = () => as("alice");
const bob = () => as("bob");
const dave = () => as("dave");
const anonymous = () => env.unauthenticatedContext().firestore();

const message = (uid, extra = {}) => ({
  text: "Coucou", authorUid: uid, authorName: "Nom", createdAt: serverTimestamp(), ...extra,
});
const newMessageRef = (db, conv = "c1") => doc(collection(db, `conversations/${conv}/messages`));

// Toute écriture de message doit mettre à jour, dans le même batch, le compteur rate/{uid}.
const freshRate = () => ({ windowStart: serverTimestamp(), count: 1, at: serverTimestamp() });
function rated(db, uid, write) {
  const batch = writeBatch(db);
  write(batch);
  batch.set(doc(db, `rate/${uid}`), freshRate());
  return batch.commit();
}
const post = (db, uid, data) => rated(db, uid, (b) => b.set(newMessageRef(db), data));
const change = (db, uid, path, data) => rated(db, uid, (b) => b.update(doc(db, path), data));
const changeRef = (ref, uid, data) => rated(ref.firestore, uid, (b) => b.update(ref, data));
// Entre deux écritures réussies du même compte : `rated` ouvre chaque fois une nouvelle fenêtre.
const clearRate = (uid) => env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), `rate/${uid}`)));

/* ---------- Tests ---------- */

describe("Configuration", () => {
  it("ADMIN_UID est identique dans firestore.rules et js/firebase-config.js", () => {
    assert.ok(ADMIN, "adminUid() introuvable dans firestore.rules");
    assert.equal(ADMIN, ADMIN_UID);
  });
});

describe("Profils (users)", () => {
  const profile = (email, extra = {}) => ({
    email, displayName: "Bob", createdAt: serverTimestamp(), lastLogin: serverTimestamp(), ...extra,
  });

  it("un utilisateur Gmail vérifié crée son profil", () =>
    assertSucceeds(setDoc(doc(bob(), "users/bob"), profile("bob@gmail.com"))));
  it("une adresse non Gmail est refusée", () =>
    assertFails(setDoc(doc(as("eve", { email: "eve@example.com" }), "users/eve"), profile("eve@example.com"))));
  it("une adresse non vérifiée est refusée", () =>
    assertFails(setDoc(doc(as("uv", { verified: false }), "users/uv"), profile("uv@gmail.com"))));
  it("un email différent de celui du compte est refusé", () =>
    assertFails(setDoc(doc(bob(), "users/bob"), profile("autre@gmail.com"))));
  it("un champ en plus (photo) est refusé", () =>
    assertFails(setDoc(doc(bob(), "users/bob"), profile("bob@gmail.com", { photoURL: "https://x" }))));
  it("créer le profil d'un autre est refusé", () =>
    assertFails(setDoc(doc(bob(), "users/carol"), profile("bob@gmail.com"))));
  it("la mise à jour à la connexion est acceptée", () =>
    assertSucceeds(updateDoc(doc(alice(), "users/alice"), { displayName: "Alice B", lastLogin: serverTimestamp() })));
  it("la date de création ne peut pas changer", () =>
    assertFails(updateDoc(doc(alice(), "users/alice"), { createdAt: serverTimestamp(), lastLogin: serverTimestamp() })));
  it("lire le profil d'un autre est refusé, l'admin lit tout", async () => {
    await assertFails(getDoc(doc(bob(), "users/alice")));
    await assertSucceeds(getDoc(doc(admin(), "users/alice")));
  });
  it("un utilisateur supprime son profil", () =>
    assertSucceeds(deleteDoc(doc(alice(), "users/alice"))));
});

describe("Conversations", () => {
  const conversation = (extra = {}) => ({
    title: "Nouvelle", description: "", members: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  });

  it("un membre lit sa conversation", () => assertSucceeds(getDoc(doc(alice(), "conversations/c1"))));
  it("un non-membre ne la lit pas", () => assertFails(getDoc(doc(bob(), "conversations/c1"))));
  it("l'admin lit toutes les conversations", () => assertSucceeds(getDoc(doc(admin(), "conversations/c2"))));
  it("un membre liste les siennes (filtre sur members)", () =>
    assertSucceeds(getDocs(query(collection(alice(), "conversations"), where("members", "array-contains", "alice")))));
  it("lister sans filtre est refusé à un membre", () =>
    assertFails(getDocs(collection(alice(), "conversations"))));
  it("seul l'admin crée une conversation", async () => {
    await assertFails(setDoc(doc(alice(), "conversations/c3"), conversation()));
    await assertSucceeds(setDoc(doc(admin(), "conversations/c3"), conversation()));
  });
  it("un champ inconnu est refusé, même pour l'admin", () =>
    assertFails(setDoc(doc(admin(), "conversations/c3"), conversation({ secret: true }))));
  it("un membre ne renomme pas la conversation", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { title: "Pirate" })));
  it("l'admin attache des liens à une conversation", () =>
    assertSucceeds(updateDoc(doc(admin(), "conversations/c1"), { links: [{ label: "sport", url: "https://www.basketusa.com/" }] })));
  it("un membre n'attache pas de lien", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { links: [{ label: "x", url: "https://x.fr/" }] })));
  it("plus de 30 liens sont refusés, même pour l'admin", () =>
    assertFails(updateDoc(doc(admin(), "conversations/c1"),
      { links: Array.from({ length: 31 }, (_, i) => ({ label: `l${i}`, url: `https://x.fr/${i}` })) })));
  it("des liens qui ne sont pas une liste sont refusés", () =>
    assertFails(updateDoc(doc(admin(), "conversations/c1"), { links: "https://x.fr/" })));
  it("l'admin épingle un message", () =>
    assertSucceeds(updateDoc(doc(admin(), "conversations/c1"), { pinned: ["m1"] })));
  it("un membre n'épingle pas de message", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { pinned: ["m1"] })));
  it("plus de 10 messages épinglés sont refusés, même pour l'admin", () =>
    assertFails(updateDoc(doc(admin(), "conversations/c1"), { pinned: Array.from({ length: 11 }, (_, i) => `m${i}`) })));
  it("des épingles qui ne sont pas une liste sont refusées", () =>
    assertFails(updateDoc(doc(admin(), "conversations/c1"), { pinned: "m1" })));
  it("l'admin supprime un message épinglé et retire l'épingle dans le même batch", async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "conversations/c1"), { pinned: ["m2"] }));
    const db = admin();
    const batch = writeBatch(db);
    batch.delete(doc(db, "conversations/c1/messages/m2"));
    batch.update(doc(db, "conversations/c1"), { pinned: arrayRemove("m2") });
    await assertSucceeds(batch.commit());
  });
  it("un membre se retire lui-même", () =>
    assertSucceeds(updateDoc(doc(alice(), "conversations/c1"), { members: arrayRemove("alice") })));
  it("un membre ne retire pas quelqu'un d'autre", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { members: arrayRemove("carol") })));
  it("un non-membre ne s'ajoute pas", () =>
    assertFails(updateDoc(doc(bob(), "conversations/c1"), { members: arrayUnion("bob") })));
  it("l'admin ajoute un membre", () =>
    assertSucceeds(updateDoc(doc(admin(), "conversations/c1"), { members: arrayUnion("bob"), updatedAt: serverTimestamp() })));
  it("un membre met à jour la date du dernier message, à l'heure du serveur", () =>
    assertSucceeds(change(alice(), "alice", "conversations/c1", { lastMessageAt: serverTimestamp() })));
  it("une date du dernier message fixée par le client est refusée", () =>
    assertFails(change(alice(), "alice", "conversations/c1", { lastMessageAt: Timestamp.now() })));
  it("un membre ne modifie rien d'autre en même temps", () =>
    assertFails(change(alice(), "alice", "conversations/c1", { lastMessageAt: serverTimestamp(), title: "Pirate" })));
  it("un non-membre ne touche pas à la date du dernier message", () =>
    assertFails(change(bob(), "bob", "conversations/c1", { lastMessageAt: serverTimestamp() })));
  it("l'admin met à jour la date du dernier message en envoyant un message", async () => {
    const db = admin();
    const batch = writeBatch(db);
    batch.set(newMessageRef(db), message(ADMIN));
    batch.update(doc(db, "conversations/c1"), { lastMessageAt: serverTimestamp() });
    batch.set(doc(db, `rate/${ADMIN}`), freshRate());
    await assertSucceeds(batch.commit());
  });
  it("seul l'admin supprime une conversation", async () => {
    await assertFails(deleteDoc(doc(alice(), "conversations/c1")));
    await assertSucceeds(deleteDoc(doc(admin(), "conversations/c1")));
  });
});

describe("Messages", () => {
  it("un membre écrit un message", () => assertSucceeds(post(alice(), "alice", message("alice"))));
  it("un non-membre n'écrit pas", () => assertFails(post(bob(), "bob", message("bob"))));
  it("écrire au nom d'un autre UID est refusé", () =>
    assertFails(post(alice(), "alice", message("carol"))));
  it("une date fixée par le client est refusée", () =>
    assertFails(post(alice(), "alice", message("alice", { createdAt: Timestamp.now() }))));
  it("un message vide sans photo est refusé", () =>
    assertFails(post(alice(), "alice", message("alice", { text: "" }))));
  it("un texte de plus de 4000 caractères est refusé", () =>
    assertFails(post(alice(), "alice", message("alice", { text: "x".repeat(4001) }))));
  it("un champ inconnu est refusé", () =>
    assertFails(post(alice(), "alice", message("alice", { pinned: true }))));
  const edit = (text, extra = {}) => ({ text, editedAt: serverTimestamp(), ...extra });
  it("l'auteur modifie le texte de son message", () =>
    assertSucceeds(change(alice(), "alice", "conversations/c1/messages/m1", edit("Bonjour à tous"))));
  it("une modification sans date serveur est refusée", async () => {
    await assertFails(change(alice(), "alice", "conversations/c1/messages/m1", { text: "modifié" }));
    await assertFails(change(alice(), "alice", "conversations/c1/messages/m1", edit("x", { editedAt: Timestamp.now() })));
  });
  it("un membre ne modifie pas le message d'un autre, l'admin non plus", async () => {
    await assertFails(change(alice(), "alice", "conversations/c1/messages/m2", edit("piraté")));
    await assertFails(change(admin(), ADMIN, "conversations/c1/messages/m2", edit("piraté")));
  });
  it("seul le texte peut changer (pas l'auteur, le nom, la date ni la réponse)", async () => {
    const ref = doc(alice(), "conversations/c1/messages/m1");
    await assertFails(changeRef(ref, "alice", edit("x", { authorUid: "carol" })));
    await assertFails(changeRef(ref, "alice", edit("x", { authorName: "Admin" })));
    await assertFails(changeRef(ref, "alice", edit("x", { createdAt: serverTimestamp() })));
    await assertFails(changeRef(ref, "alice", edit("x", { replyTo: "m2" })));
  });
  it("un texte vidé est refusé, sauf pour un message avec photo", async () => {
    await assertFails(change(alice(), "alice", "conversations/c1/messages/m1", edit("")));
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "conversations/c1/messages/photo"), message("alice", { text: "", image: { w: 10, h: 10 } })));
    await assertSucceeds(change(alice(), "alice", "conversations/c1/messages/photo", edit("")));
  });
  it("un ancien membre ne modifie plus ses messages", () =>
    assertFails(change(dave(), "dave", "conversations/c1/messages/m3", edit("tardif"))));
  it("une réponse à un message existant est acceptée", () =>
    assertSucceeds(post(alice(), "alice", message("alice", { replyTo: "m2" }))));
  it("une réponse à un message inexistant est refusée", () =>
    assertFails(post(alice(), "alice", message("alice", { replyTo: "inexistant" }))));
  it("l'auteur supprime son message", () =>
    assertSucceeds(deleteDoc(doc(alice(), "conversations/c1/messages/m1"))));
  it("un membre ne supprime pas le message d'un autre", () =>
    assertFails(deleteDoc(doc(alice(), "conversations/c1/messages/m2"))));
  it("l'admin supprime n'importe quel message", () =>
    assertSucceeds(deleteDoc(doc(admin(), "conversations/c1/messages/m2"))));
  it("un membre lit les messages, un non-membre non", async () => {
    await assertSucceeds(getDocs(collection(alice(), "conversations/c1/messages")));
    await assertFails(getDocs(collection(bob(), "conversations/c1/messages")));
  });
});

describe("Réactions", () => {
  const m2 = "conversations/c1/messages/m2"; // message de carol
  const react = (db, uid, emoji) => change(db, uid, m2, { [`reactions.${uid}`]: emoji });
  const withReactions = (reactions) => env.withSecurityRulesDisabled((ctx) =>
    updateDoc(doc(ctx.firestore(), m2), { reactions }));

  it("un membre réagit au message d'un autre", () => assertSucceeds(react(alice(), "alice", "👍")));
  it("l'auteur réagit à son propre message", () => assertSucceeds(react(as("carol"), "carol", "❤️")));
  it("un emoji hors de la liste est refusé", () => assertFails(react(alice(), "alice", "🍕")));
  it("une réaction qui n'est pas un emoji (texte) est refusée", () =>
    assertFails(react(alice(), "alice", "x".repeat(500))));
  it("réagir sans mettre à jour le compteur anti-abus est refusé", () =>
    assertFails(updateDoc(doc(alice(), m2), { "reactions.alice": "👍" })));
  it("réagir au nom d'un autre est refusé", () =>
    assertFails(change(alice(), "alice", m2, { "reactions.carol": "👍" })));
  it("un non-membre ne réagit pas", () => assertFails(react(bob(), "bob", "👍")));
  it("un ancien membre ne réagit plus", () => assertFails(react(dave(), "dave", "👍")));
  it("on ne modifie pas le texte en même temps qu'on réagit", () =>
    assertFails(change(alice(), "alice", m2, { "reactions.alice": "👍", text: "piraté" })));
  it("on ne réagit pas à une annonce « a rejoint »", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "conversations/c1/messages/join"),
      { event: "join", authorUid: "carol", createdAt: T0 }));
    await assertFails(change(alice(), "alice", "conversations/c1/messages/join", { "reactions.alice": "👍" }));
  });
  it("un membre change puis retire sa réaction (retrait sans compteur)", async () => {
    await withReactions({ alice: "👍", carol: "😂" });
    await assertSucceeds(react(alice(), "alice", "❤️"));
    await assertSucceeds(updateDoc(doc(alice(), m2), { "reactions.alice": deleteField() }));
    const after = await getDoc(doc(alice(), m2));
    assert.deepEqual(after.data().reactions, { carol: "😂" });
  });
  it("un membre ne retire pas la réaction d'un autre, l'admin oui", async () => {
    await withReactions({ carol: "😂" });
    await assertFails(updateDoc(doc(alice(), m2), { "reactions.carol": deleteField() }));
    await assertSucceeds(updateDoc(doc(admin(), m2), { "reactions.carol": deleteField() }));
  });
  it("l'admin ne met pas de réaction au nom d'un autre", () =>
    assertFails(change(admin(), ADMIN, m2, { "reactions.alice": "👍" })));
  it("un membre retrouve les messages où il a réagi (suppression de compte, export)", async () => {
    await withReactions({ alice: "👍" });
    const q = query(collection(alice(), "conversations/c1/messages"), where("reactions.alice", "in", ["👍", "❤️"]));
    const snap = await assertSucceeds(getDocs(q));
    assert.equal(snap.size, 1);
  });
  it("l'auteur modifie toujours son texte quand il y a des réactions", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "conversations/c1/messages/m1"), { reactions: { carol: "👍" } }));
    await assertSucceeds(change(alice(), "alice", "conversations/c1/messages/m1",
      { text: "Bonjour modifié", editedAt: serverTimestamp() }));
  });
});

describe("Photos", () => {
  function sendPhoto(db, uid, { data = JPEG, w = 800, h = 600 } = {}) {
    const ref = newMessageRef(db);
    const batch = writeBatch(db);
    batch.set(ref, message(uid, { image: { w, h } }));
    batch.set(doc(db, `conversations/c1/images/${ref.id}`), { data, authorUid: uid, createdAt: serverTimestamp() });
    batch.set(doc(db, `rate/${uid}`), freshRate());
    return batch.commit();
  }

  it("un message et sa photo dans le même batch sont acceptés", () => assertSucceeds(sendPhoto(alice(), "alice")));
  it("une photo qui n'est pas un JPEG est refusée", () =>
    assertFails(sendPhoto(alice(), "alice", { data: "data:image/png;base64,iVBORw0KGgo=" })));
  it("une photo de plus de 900 000 caractères est refusée", () =>
    assertFails(sendPhoto(alice(), "alice", { data: JPEG + "A".repeat(900_000) })));
  it("des dimensions au-delà de 1600 px sont refusées", () =>
    assertFails(sendPhoto(alice(), "alice", { w: 5000 })));
  it("une photo sans message est refusée", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/images/orpheline"), {
      data: JPEG, authorUid: "alice", createdAt: serverTimestamp(),
    })));
  it("un message qui annonce une photo absente est refusé", () =>
    assertFails(post(alice(), "alice", message("alice", { image: { w: 10, h: 10 } }))));
  it("une photo rattachée au message d'un autre est refusée", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/images/m2"), {
      data: JPEG, authorUid: "alice", createdAt: serverTimestamp(),
    })));
  it("un non-membre ne lit pas les photos", () =>
    assertFails(getDoc(doc(bob(), "conversations/c1/images/m3"))));

  function sendWithThumb(db, uid, { thumb = JPEG, declare = true, write = true } = {}) {
    const ref = newMessageRef(db);
    const batch = writeBatch(db);
    batch.set(ref, message(uid, { image: { w: 800, h: 600, ...(declare ? { thumb: true } : {}) } }));
    batch.set(doc(db, `conversations/c1/images/${ref.id}`), { data: JPEG, authorUid: uid, createdAt: serverTimestamp() });
    if (write) batch.set(doc(db, `conversations/c1/thumbs/${ref.id}`), { data: thumb, authorUid: uid, createdAt: serverTimestamp() });
    batch.set(doc(db, `rate/${uid}`), freshRate());
    return batch.commit();
  }
  it("une photo avec sa miniature dans le même batch est acceptée", () => assertSucceeds(sendWithThumb(alice(), "alice")));
  it("une miniature de plus de 60 000 caractères est refusée", () =>
    assertFails(sendWithThumb(alice(), "alice", { thumb: JPEG + "A".repeat(60_000) })));
  it("un message qui annonce une miniature absente est refusé", () =>
    assertFails(sendWithThumb(alice(), "alice", { write: false })));
  it("une miniature rattachée au message d'un autre est refusée", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/thumbs/m2"), {
      data: JPEG, authorUid: "alice", createdAt: serverTimestamp(),
    })));
  it("un non-membre ne lit pas les miniatures", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "conversations/c1/thumbs/m3"), { data: JPEG, authorUid: "dave", createdAt: T0 }));
    await assertFails(getDoc(doc(bob(), "conversations/c1/thumbs/m3")));
    await assertSucceeds(getDoc(doc(alice(), "conversations/c1/thumbs/m3")));
  });
});

describe("Accusés de lecture", () => {
  const read = (uid, extra = {}) => ({ uid, lastRead: serverTimestamp(), ...extra });

  it("un membre enregistre sa lecture", () =>
    assertSucceeds(setDoc(doc(alice(), "conversations/c1/reads/alice"), read("alice"))));
  it("un nom dans l'accusé est refusé (il vient de l'annuaire)", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/reads/alice"), read("alice", { name: "Admin" }))));
  it("enregistrer la lecture d'un autre est refusé", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/reads/carol"), read("carol"))));
  it("une date fixée par le client est refusée", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/reads/alice"), read("alice", { lastRead: Timestamp.now() }))));
  it("un non-membre ne lit pas les accusés", () =>
    assertFails(getDocs(collection(bob(), "conversations/c1/reads"))));
});

describe("Annuaire des noms (names)", () => {
  const entry = (name, extra = {}) => ({ name, updatedAt: serverTimestamp(), ...extra });

  it("un utilisateur connecté lit une entrée par son UID, pas un visiteur", async () => {
    await assertSucceeds(getDoc(doc(bob(), "names/alice")));
    await assertFails(getDoc(doc(anonymous(), "names/alice")));
  });
  it("seul l'admin liste l'annuaire", async () => {
    await assertFails(getDocs(collection(alice(), "names")));
    await assertSucceeds(getDocs(collection(admin(), "names")));
  });
  it("un membre ne change pas son propre nom", () =>
    assertFails(setDoc(doc(alice(), "names/alice"), entry("Administrateur"))));
  it("un membre ne s'attribue pas le nom d'un autre", () =>
    assertFails(setDoc(doc(bob(), "names/carol"), entry("Carol"))));
  it("l'admin crée et renomme une entrée", async () => {
    await assertSucceeds(setDoc(doc(admin(), "names/carol"), entry("Carol")));
    await assertSucceeds(setDoc(doc(admin(), "names/alice"), entry("Alice Martin")));
  });
  it("un nom vide, trop long ou un champ inconnu est refusé", async () => {
    await assertFails(setDoc(doc(admin(), "names/carol"), entry("")));
    await assertFails(setDoc(doc(admin(), "names/carol"), entry("x".repeat(201))));
    await assertFails(setDoc(doc(admin(), "names/carol"), entry("Carol", { email: "carol@gmail.com" })));
  });
  it("une date fixée par le client est refusée", () =>
    assertFails(setDoc(doc(admin(), "names/carol"), entry("Carol", { updatedAt: Timestamp.now() }))));
  it("un utilisateur supprime sa propre entrée, pas celle d'un autre", async () => {
    await assertFails(deleteDoc(doc(bob(), "names/alice")));
    await assertSucceeds(deleteDoc(doc(alice(), "names/alice")));
  });
});

describe("Limitation anti-abus (rate)", () => {
  const seedRate = (data) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "rate/alice"), data));
  const bump = () => ({ count: increment(1), at: serverTimestamp() });

  it("un message sans mise à jour du compteur est refusé", () =>
    assertFails(setDoc(newMessageRef(alice()), message("alice"))));
  it("une modification ou une date d'activité sans compteur est refusée", async () => {
    await assertFails(updateDoc(doc(alice(), "conversations/c1/messages/m1"), { text: "x", editedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(alice(), "conversations/c1"), { lastMessageAt: serverTimestamp() }));
  });
  it("le compteur avance d'un, jusqu'à 30 par minute", async () => {
    await seedRate({ windowStart: Timestamp.now(), count: 29, at: Timestamp.now() });
    const send = () => rated2(alice());
    function rated2(db) {
      const batch = writeBatch(db);
      batch.set(newMessageRef(db), message("alice"));
      batch.update(doc(db, "rate/alice"), bump());
      return batch.commit();
    }
    await assertSucceeds(send());
    await assertFails(send());
  });
  it("la fenêtre ne repart de zéro qu'après une minute", async () => {
    await seedRate({ windowStart: Timestamp.now(), count: 30, at: Timestamp.now() });
    await assertFails(post(alice(), "alice", message("alice")));
    const old = Timestamp.fromMillis(Date.now() - 61_000);
    await seedRate({ windowStart: old, count: 30, at: old });
    await assertSucceeds(post(alice(), "alice", message("alice")));
  });
  it("le compteur ne peut être ni falsifié, ni écrit pour un autre, ni supprimé par son titulaire", async () => {
    await seedRate({ windowStart: Timestamp.now(), count: 5, at: Timestamp.now() });
    await assertFails(updateDoc(doc(alice(), "rate/alice"), { count: 0, at: serverTimestamp() }));
    await assertFails(setDoc(doc(bob(), "rate/alice"), freshRate()));
    await assertFails(deleteDoc(doc(alice(), "rate/alice")));
    await assertSucceeds(deleteDoc(doc(admin(), "rate/alice")));
  });
  it("un profil n'est mis à jour qu'une fois par minute", async () => {
    const db = bob();
    const profile = { email: "bob@gmail.com", displayName: "Bob", createdAt: serverTimestamp(), lastLogin: serverTimestamp() };
    await assertSucceeds(setDoc(doc(db, "users/bob"), profile));
    await assertFails(updateDoc(doc(db, "users/bob"), { lastLogin: serverTimestamp() }));
  });
});

describe("Réglage des accusés de lecture (noReceipts)", () => {
  it("le titulaire change le réglage, avec le compteur anti-abus", () =>
    assertSucceeds(change(alice(), "alice", "users/alice", { noReceipts: true })));
  it("sans compteur, ou avec un autre champ, c'est refusé", async () => {
    await assertFails(updateDoc(doc(alice(), "users/alice"), { noReceipts: true }));
    await assertFails(change(alice(), "alice", "users/alice", { noReceipts: true, displayName: "Autre" }));
  });
  it("le réglage de présence (noPresence) suit les mêmes règles", async () => {
    await assertSucceeds(change(alice(), "alice", "users/alice", { noPresence: true }));
    await assertFails(change(alice(), "alice", "users/alice", { noPresence: "oui" }));
    await assertFails(change(bob(), "bob", "users/alice", { noPresence: true }));
  });
  it("une valeur non booléenne est refusée, le profil d'un autre aussi", async () => {
    await assertFails(change(alice(), "alice", "users/alice", { noReceipts: "oui" }));
    await assertFails(change(bob(), "bob", "users/alice", { noReceipts: true }));
  });
});

describe("Invitations", () => {
  // erin n'est encore membre de rien ; l'admin l'a invitée dans c1.
  const erin = () => as("erin");
  const invite = (extra = {}) => ({
    email: "erin@gmail.com", name: "Erin", convIds: ["c1"], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  });
  beforeEach(() => env.withSecurityRulesDisabled((ctx) =>
    setDoc(doc(ctx.firestore(), "invites/erin@gmail.com"), { ...invite(), createdAt: T0, updatedAt: T0 })));

  function join(db, conv = "c1", { updateInvite = true } = {}) {
    const batch = writeBatch(db);
    batch.update(doc(db, `conversations/${conv}`), { members: arrayUnion("erin") });
    if (updateInvite) batch.delete(doc(db, "invites/erin@gmail.com"));
    return batch.commit();
  }

  it("seul l'admin crée une invitation", async () => {
    await assertFails(setDoc(doc(alice(), "invites/frank@gmail.com"), invite({ email: "frank@gmail.com" })));
    await assertSucceeds(setDoc(doc(admin(), "invites/frank@gmail.com"), invite({ email: "frank@gmail.com" })));
  });
  it("une adresse non Gmail, en majuscules ou différente de l'identifiant est refusée", async () => {
    await assertFails(setDoc(doc(admin(), "invites/frank@example.com"), invite({ email: "frank@example.com" })));
    await assertFails(setDoc(doc(admin(), "invites/Frank@gmail.com"), invite({ email: "Frank@gmail.com" })));
    await assertFails(setDoc(doc(admin(), "invites/frank@gmail.com"), invite()));
  });
  it("la personne invitée lit son invitation, personne d'autre (sauf l'admin)", async () => {
    await assertSucceeds(getDoc(doc(erin(), "invites/erin@gmail.com")));
    await assertFails(getDoc(doc(bob(), "invites/erin@gmail.com")));
    await assertFails(getDocs(collection(erin(), "invites")));
    await assertSucceeds(getDocs(collection(admin(), "invites")));
  });
  it("la personne invitée rejoint la conversation en consommant l'invitation", () => assertSucceeds(join(erin())));
  it("invitée dans deux conversations, elle retire de l'invitation celle qu'elle rejoint", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "invites/erin@gmail.com"), { convIds: ["c1", "c2"] }));
    const db = erin();
    const wrong = writeBatch(db);
    wrong.update(doc(db, "conversations/c1"), { members: arrayUnion("erin") });
    wrong.update(doc(db, "invites/erin@gmail.com"), { convIds: arrayRemove("c2") });
    await assertFails(wrong.commit());
    const batch = writeBatch(db);
    batch.update(doc(db, "conversations/c1"), { members: arrayUnion("erin") });
    batch.update(doc(db, "invites/erin@gmail.com"), { convIds: arrayRemove("c1") });
    await assertSucceeds(batch.commit());
  });
  it("rejoindre sans consommer l'invitation est refusé", () =>
    assertFails(join(erin(), "c1", { updateInvite: false })));
  it("une conversation absente de l'invitation est refusée", () => assertFails(join(erin(), "c2")));
  it("sans invitation, impossible de s'ajouter", async () => {
    const db = as("frank");
    const batch = writeBatch(db);
    batch.update(doc(db, "conversations/c1"), { members: arrayUnion("frank") });
    await assertFails(batch.commit());
  });
  it("la personne invitée n'ajoute pas de conversation à son invitation", () =>
    assertFails(updateDoc(doc(erin(), "invites/erin@gmail.com"), { convIds: ["c1", "c2"] })));
  it("elle crée son entrée d'annuaire avec le nom choisi par l'admin, pas un autre", async () => {
    const entry = (name) => ({ name, updatedAt: serverTimestamp() });
    await assertFails(setDoc(doc(erin(), "names/erin"), entry("Administrateur")));
    await assertSucceeds(setDoc(doc(erin(), "names/erin"), entry("Erin")));
    await assertFails(setDoc(doc(bob(), "names/bob"), entry("Bob")));
  });
  it("la personne invitée ou l'admin supprime l'invitation", async () => {
    await assertFails(deleteDoc(doc(bob(), "invites/erin@gmail.com")));
    await assertSucceeds(deleteDoc(doc(erin(), "invites/erin@gmail.com")));
  });
});

describe("Annonce « a rejoint la conversation »", () => {
  const joinEvent = (uid) => ({ event: "join", authorUid: uid, createdAt: serverTimestamp() });
  function addMember(db, uid, { conv = "c1", event = joinEvent(uid), members = true } = {}) {
    const batch = writeBatch(db);
    if (members) batch.update(doc(db, `conversations/${conv}`), { members: arrayUnion(uid), updatedAt: serverTimestamp() });
    batch.set(newMessageRef(db, conv), event);
    return batch.commit();
  }

  it("l'admin l'écrit en ajoutant un membre, sans compteur anti-abus", () => assertSucceeds(addMember(admin(), "bob")));
  it("sans ajout aux membres dans le même batch, elle est refusée", () =>
    assertFails(addMember(admin(), "bob", { members: false })));
  it("pour quelqu'un qui est déjà membre, elle est refusée", () =>
    assertFails(addMember(admin(), "alice", { members: false })));
  it("pour une autre personne que celle ajoutée, elle est refusée", () =>
    assertFails(addMember(admin(), "bob", { event: joinEvent("dave") })));
  it("un champ en plus (texte) ou une date client sont refusés", async () => {
    await assertFails(addMember(admin(), "bob", { event: { ...joinEvent("bob"), text: "x" } }));
    await assertFails(addMember(admin(), "bob", { event: { ...joinEvent("bob"), createdAt: Timestamp.now() } }));
  });
  it("un membre n'annonce pas l'arrivée d'un autre", () =>
    assertFails(post(alice(), "alice", joinEvent("carol"))));
  it("la personne invitée l'écrit en rejoignant la conversation", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "invites/erin@gmail.com"), {
      email: "erin@gmail.com", name: "Erin", convIds: ["c1"], createdAt: T0, updatedAt: T0,
    }));
    const db = as("erin");
    const batch = writeBatch(db);
    batch.update(doc(db, "conversations/c1"), { members: arrayUnion("erin") });
    batch.set(newMessageRef(db), joinEvent("erin"));
    batch.delete(doc(db, "invites/erin@gmail.com"));
    await assertSucceeds(batch.commit());
  });
  const leave = (db, uid, { event = { ...joinEvent(uid), event: "leave" }, members = true } = {}) => {
    const batch = writeBatch(db);
    if (members) batch.update(doc(db, "conversations/c1"), { members: arrayRemove(uid), updatedAt: serverTimestamp() });
    batch.set(newMessageRef(db), event);
    return batch.commit();
  };
  it("l'admin annonce le départ d'un membre qu'il retire", () => assertSucceeds(leave(admin(), "alice")));
  it("un départ sans retrait des membres dans le même batch est refusé", () =>
    assertFails(leave(admin(), "alice", { members: false })));
  it("le départ de quelqu'un qui n'était pas membre est refusé", () => assertFails(leave(admin(), "bob")));
  it("une annonce d'arrivée pour un membre qu'on retire est refusée", () =>
    assertFails(leave(admin(), "alice", { event: joinEvent("alice") })));
  it("un membre qui se retire annonce son propre départ, pas celui d'un autre", async () => {
    const db = alice();
    const other = writeBatch(db);
    other.update(doc(db, "conversations/c1"), { members: arrayRemove("alice") });
    other.set(newMessageRef(db), { ...joinEvent("carol"), event: "leave" });
    await assertFails(other.commit());
    const self = writeBatch(db);
    self.update(doc(db, "conversations/c1"), { members: arrayRemove("alice") });
    self.set(newMessageRef(db), { ...joinEvent("alice"), event: "leave" });
    await assertSucceeds(self.commit());
  });
  it("un type d'annonce inconnu est refusé", () =>
    assertFails(leave(admin(), "alice", { event: { ...joinEvent("alice"), event: "kick" } })));
  it("on ne transforme pas une annonce en message", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "conversations/c1/messages/j1"), { event: "join", authorUid: "alice", createdAt: T0 }));
    await assertFails(change(alice(), "alice", "conversations/c1/messages/j1", { text: "piraté", editedAt: serverTimestamp() }));
  });
});

describe("Projets", () => {
  const project = { title: "P", description: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp() };

  it("seul l'admin liste les projets", async () => {
    await assertFails(getDocs(collection(alice(), "projects")));
    await assertSucceeds(getDocs(collection(admin(), "projects")));
  });
  it("un utilisateur connecté lit un projet par son identifiant, pas un visiteur", async () => {
    await assertSucceeds(getDoc(doc(bob(), "projects/p1")));
    await assertFails(getDoc(doc(anonymous(), "projects/p1")));
  });
  it("seul l'admin crée un projet", async () => {
    await assertFails(setDoc(doc(alice(), "projects/p2"), project));
    await assertSucceeds(setDoc(doc(admin(), "projects/p2"), project));
  });
  it("l'admin ajoute un logo (petite image en data URL)", async () => {
    await assertSucceeds(updateDoc(doc(admin(), "projects/p1"), { logo: "data:image/png;base64,iVBORw0KGgo=" }));
    await assertFails(updateDoc(doc(alice(), "projects/p1"), { logo: "data:image/png;base64,iVBORw0KGgo=" }));
  });
  it("le logo doit être une image en data URL de taille limitée", async () => {
    await assertFails(updateDoc(doc(admin(), "projects/p1"), { logo: "https://exemple.fr/logo.png" }));
    await assertFails(updateDoc(doc(admin(), "projects/p1"), { logo: "data:image/svg+xml;base64,PHN2Zz4=" }));
    await assertFails(updateDoc(doc(admin(), "projects/p1"), { logo: "data:image/png;base64," + "A".repeat(60_000) }));
  });
});

describe("Rôles des projets", () => {
  const roles = {
    roles: [{ id: "r1", name: "Dev" }, { id: "r2", name: "Design" }],
    roleMembers: { alice: ["r1"], carol: ["r1", "r2"] },
    roleUids: ["alice", "carol"],
  };
  beforeEach(() => env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), "projects/p1"), roles)));

  it("l'admin définit les rôles d'un projet", () =>
    assertSucceeds(updateDoc(doc(admin(), "projects/p1"), {
      roles: [{ id: "r3", name: "Test" }], roleMembers: { bob: ["r3"] }, roleUids: ["bob"],
    })));
  it("un membre ne modifie pas les rôles", () =>
    assertFails(updateDoc(doc(alice(), "projects/p1"), { roles: [{ id: "r1", name: "Chef" }] })));
  it("roleUids doit correspondre aux clés de roleMembers, même pour l'admin", async () => {
    await assertFails(updateDoc(doc(admin(), "projects/p1"), { roleUids: ["alice"] }));
    await assertFails(updateDoc(doc(admin(), "projects/p1"), { roleMembers: { bob: ["r1"] } }));
  });
  it("plus de 20 rôles sont refusés, même pour l'admin", () =>
    assertFails(updateDoc(doc(admin(), "projects/p1"), {
      roles: Array.from({ length: 21 }, (_, i) => ({ id: "r" + i, name: "R" + i })),
    })));
  it("une personne retrouve les projets où elle tient un rôle, pas ceux des autres", async () => {
    await assertSucceeds(getDocs(query(collection(alice(), "projects"), where("roleUids", "array-contains", "alice"))));
    await assertFails(getDocs(query(collection(alice(), "projects"), where("roleUids", "array-contains", "carol"))));
  });
  it("une personne se retire de ses rôles", () =>
    assertSucceeds(updateDoc(doc(alice(), "projects/p1"), { "roleMembers.alice": deleteField(), roleUids: arrayRemove("alice") })));
  it("elle ne retire pas quelqu'un d'autre", () =>
    assertFails(updateDoc(doc(alice(), "projects/p1"), { "roleMembers.carol": deleteField(), roleUids: arrayRemove("carol") })));
  it("elle ne se donne pas un autre rôle", () =>
    assertFails(updateDoc(doc(alice(), "projects/p1"), { "roleMembers.alice": ["r1", "r2"] })));
  it("sans rôle, on ne s'ajoute pas", () =>
    assertFails(updateDoc(doc(bob(), "projects/p1"), { "roleMembers.bob": ["r1"], roleUids: arrayUnion("bob") })));
});

describe("Organigramme des projets", () => {
  const levels = [{ id: "n1", roles: ["r1"] }, { id: "n2", roles: ["r2"] }];

  it("l'admin définit l'organigramme d'un projet", () =>
    assertSucceeds(updateDoc(doc(admin(), "projects/p1"), { orgLevels: levels })));
  it("un membre ne modifie pas l'organigramme", () =>
    assertFails(updateDoc(doc(alice(), "projects/p1"), { orgLevels: levels })));
  it("plus de 10 niveaux sont refusés, même pour l'admin", () =>
    assertFails(updateDoc(doc(admin(), "projects/p1"), {
      orgLevels: Array.from({ length: 11 }, (_, i) => ({ id: "n" + i, roles: [] })),
    })));
  it("l'organigramme doit être une liste", () =>
    assertFails(updateDoc(doc(admin(), "projects/p1"), { orgLevels: { n1: ["r1"] } })));
});

describe("Liens des projets", () => {
  const links = [{ label: "Maquettes", url: "https://www.figma.com/" }, { label: "Dépôt", url: "https://github.com/" }];

  it("l'admin définit les liens d'un projet", () =>
    assertSucceeds(updateDoc(doc(admin(), "projects/p1"), { links })));
  it("un membre ne modifie pas les liens", () =>
    assertFails(updateDoc(doc(alice(), "projects/p1"), { links })));
  it("plus de 20 liens sont refusés, même pour l'admin", () =>
    assertFails(updateDoc(doc(admin(), "projects/p1"), {
      links: Array.from({ length: 21 }, (_, i) => ({ label: "L" + i, url: `https://exemple.fr/${i}` })),
    })));
  it("les liens doivent former une liste", () =>
    assertFails(updateDoc(doc(admin(), "projects/p1"), { links: { a: "https://exemple.fr/" } })));
});

describe("Calendrier : membres du projet", () => {
  const ticket = (uid, via) => ({ uid, via, at: serverTimestamp() });
  const carol = () => as("carol");

  it("un membre d'une conversation du projet enregistre sa fiche", async () => {
    const db = carol();
    await assertSucceeds(deleteDoc(doc(db, "projects/p1/members/carol")));
    await assertSucceeds(rated(db, "carol", (b) => b.set(doc(db, "projects/p1/members/carol"), ticket("carol", "c1"))));
  });
  it("pas avec une conversation dont on n'est pas membre, ni hors du projet", async () => {
    const db = bob();
    await assertFails(rated(db, "bob", (b) => b.set(doc(db, "projects/p1/members/bob"), ticket("bob", "c1"))));
    await assertFails(rated(db, "bob", (b) => b.set(doc(db, "projects/p1/members/bob"), ticket("bob", "c2"))));
  });
  it("ni pour quelqu'un d'autre, ni sans passer par le compteur anti-abus", async () => {
    const db = alice();
    await assertFails(rated(db, "alice", (b) => b.set(doc(db, "projects/p1/members/carol"), ticket("carol", "c1"))));
    await assertFails(setDoc(doc(db, "projects/p1/members/alice"), ticket("alice", "c1")));
  });
  it("l'admin écrit la fiche d'un membre", () =>
    assertSucceeds(setDoc(doc(admin(), "projects/p1/members/carol"), ticket("carol", "c1"))));
  it("un membre lit la liste des membres du projet, pas un autre", async () => {
    await assertSucceeds(getDocs(collection(alice(), "projects/p1/members")));
    await assertFails(getDocs(collection(bob(), "projects/p1/members")));
  });
  it("on lit toujours sa propre fiche (pour la vérifier)", () =>
    assertSucceeds(getDoc(doc(dave(), "projects/p1/members/dave"))));
});

describe("Calendrier : réunions", () => {
  const carol = () => as("carol");
  const meeting = (uid, extra = {}) => ({
    title: "Réunion", description: "", place: "", start: T0, end: Timestamp.fromMillis(T0.toMillis() + 3600_000),
    createdBy: uid, attendees: ["carol"], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  });
  const newEvent = (db) => doc(collection(db, "projects/p1/events"));

  it("un membre du projet lit le calendrier", () =>
    assertSucceeds(getDocs(collection(carol(), "projects/p1/events"))));
  it("un non-membre ne le lit pas, ni un ancien membre à la fiche périmée", async () => {
    await assertFails(getDocs(collection(bob(), "projects/p1/events")));
    await assertFails(getDocs(collection(dave(), "projects/p1/events")));
    await assertFails(getDoc(doc(dave(), "projects/p1/events/e1")));
  });
  it("un membre crée une réunion et y invite d'autres membres", () => {
    const db = alice();
    return assertSucceeds(rated(db, "alice", (b) => b.set(newEvent(db), meeting("alice"))));
  });
  it("pas au nom d'un autre, ni sans compteur, ni avec des réponses toutes faites", async () => {
    const db = alice();
    await assertFails(rated(db, "alice", (b) => b.set(newEvent(db), meeting("carol"))));
    await assertFails(setDoc(newEvent(db), meeting("alice")));
    await assertFails(rated(db, "alice", (b) => b.set(newEvent(db), meeting("alice", { responses: { carol: "yes" } }))));
  });
  it("la fin ne précède pas le début et la réunion dure 24 h au plus", async () => {
    const db = alice();
    await assertFails(rated(db, "alice", (b) => b.set(newEvent(db), meeting("alice", { end: Timestamp.fromMillis(T0.toMillis() - 1) }))));
    await assertFails(rated(db, "alice", (b) => b.set(newEvent(db), meeting("alice", { end: Timestamp.fromMillis(T0.toMillis() + 25 * 3600_000) }))));
  });
  it("un non-membre ne crée pas de réunion", () => {
    const db = bob();
    return assertFails(rated(db, "bob", (b) => b.set(newEvent(db), meeting("bob"))));
  });
  it("l'invité répond présent ou absent, et seulement pour lui", async () => {
    const db = carol();
    await assertSucceeds(change(db, "carol", "projects/p1/events/e1", { "responses.carol": "yes" }));
    await clearRate("carol");
    await assertSucceeds(change(db, "carol", "projects/p1/events/e1", { "responses.carol": "no" }));
    await clearRate("carol");
    await assertFails(change(db, "carol", "projects/p1/events/e1", { "responses.carol": "peut-être" }));
    await assertFails(change(db, "carol", "projects/p1/events/e1", { "responses.alice": "yes" }));
  });
  it("un non-invité ne répond pas, l'invité ne change pas le titre", async () => {
    await assertFails(change(alice(), "alice", "projects/p1/events/e1", { "responses.alice": "yes" }));
    await assertFails(change(carol(), "carol", "projects/p1/events/e1", { title: "Autre", updatedAt: serverTimestamp() }));
  });
  it("l'organisateur modifie sa réunion et peut effacer les réponses, pas en ajouter", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "projects/p1/events/e1"), { responses: { carol: "yes" } }));
    const db = alice();
    await assertFails(change(db, "alice", "projects/p1/events/e1", { "responses.carol": "no", updatedAt: serverTimestamp() }));
    await assertSucceeds(change(db, "alice", "projects/p1/events/e1", {
      title: "Point déplacé", responses: {}, updatedAt: serverTimestamp(),
    }));
  });
  it("seuls l'organisateur et l'admin suppriment une réunion", async () => {
    await assertFails(deleteDoc(doc(carol(), "projects/p1/events/e1")));
    await assertSucceeds(deleteDoc(doc(alice(), "projects/p1/events/e1")));
  });
  it("l'admin modifie et supprime toute réunion", async () => {
    const db = admin();
    await assertSucceeds(change(db, ADMIN, "projects/p1/events/e1", { title: "Par l'admin", updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(doc(db, "projects/p1/events/e1")));
  });
  it("un invité retrouve ses réunions dans tous les projets, et s'en retire", async () => {
    const db = carol();
    await assertSucceeds(getDocs(query(collectionGroup(db, "events"), where("attendees", "array-contains", "carol"))));
    await assertFails(getDocs(query(collectionGroup(db, "events"), where("attendees", "array-contains", "alice"))));
    await assertSucceeds(updateDoc(doc(db, "projects/p1/events/e1"), { attendees: arrayRemove("carol") }));
  });
  it("l'admin retire un invité (suppression de compte), sans en ajouter", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "projects/p1/events/e1"), { responses: { carol: "yes" } }));
    const db = admin();
    await assertFails(updateDoc(doc(db, "projects/p1/events/e1"), { attendees: arrayUnion("bob") }));
    await assertSucceeds(updateDoc(doc(db, "projects/p1/events/e1"), { attendees: arrayRemove("carol"), "responses.carol": deleteField() }));
  });
  it("l'organisateur retrouve les réunions qu'il a créées", () =>
    assertSucceeds(getDocs(query(collectionGroup(alice(), "events"), where("createdBy", "==", "alice")))));
});

describe("Calendrier : objectifs", () => {
  const carol = () => as("carol");
  const goal = (uid, extra = {}) => ({
    title: "Livrer", due: "2026-12-01", done: false, createdBy: uid,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  });
  const newGoal = (db) => doc(collection(db, "projects/p1/goals"));
  const now = () => ({ updatedAt: serverTimestamp() });

  it("un membre ajoute un objectif, pas un non-membre", async () => {
    const db = carol();
    await assertSucceeds(rated(db, "carol", (b) => b.set(newGoal(db), goal("carol"))));
    const other = bob();
    await assertFails(rated(other, "bob", (b) => b.set(newGoal(other), goal("bob"))));
  });
  it("l'échéance est une date AAAA-MM-JJ, l'objectif est créé non atteint", async () => {
    const db = carol();
    await assertFails(rated(db, "carol", (b) => b.set(newGoal(db), goal("carol", { due: "demain" }))));
    await assertFails(rated(db, "carol", (b) => b.set(newGoal(db), goal("carol", { done: true }))));
  });
  it("tout membre coche un objectif, en son nom", async () => {
    const db = carol();
    await assertFails(change(db, "carol", "projects/p1/goals/g1", { done: true, doneBy: "alice", doneAt: serverTimestamp(), ...now() }));
    await assertSucceeds(change(db, "carol", "projects/p1/goals/g1", { done: true, doneBy: "carol", doneAt: serverTimestamp(), ...now() }));
    await clearRate("carol");
    await assertSucceeds(change(db, "carol", "projects/p1/goals/g1", { done: false, doneBy: deleteField(), doneAt: deleteField(), ...now() }));
  });
  it("seuls l'auteur et l'admin renomment ou suppriment", async () => {
    await assertFails(change(carol(), "carol", "projects/p1/goals/g1", { title: "Autre", ...now() }));
    await assertFails(deleteDoc(doc(carol(), "projects/p1/goals/g1")));
    await assertSucceeds(change(alice(), "alice", "projects/p1/goals/g1", { title: "Version 1.0", due: "2027-01-15", ...now() }));
    await assertSucceeds(change(admin(), ADMIN, "projects/p1/goals/g1", { title: "Version 1.1", ...now() }));
    await assertSucceeds(deleteDoc(doc(alice(), "projects/p1/goals/g1")));
  });
  it("un ancien membre ne lit plus les objectifs", () =>
    assertFails(getDocs(collection(dave(), "projects/p1/goals"))));
  it("on retire son nom d'un objectif coché (effacement), sans le décocher", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "projects/p1/goals/g1"), { done: true, doneBy: "dave", doneAt: T0 }));
    const db = dave();
    await assertSucceeds(getDocs(query(collectionGroup(db, "goals"), where("doneBy", "==", "dave"))));
    await assertFails(updateDoc(doc(db, "projects/p1/goals/g1"), { doneBy: deleteField(), done: false }));
    await assertSucceeds(updateDoc(doc(db, "projects/p1/goals/g1"), { doneBy: deleteField() }));
  });
  it("l'admin retire le nom de quelqu'un d'un objectif coché, un membre non", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), "projects/p1/goals/g1"), { done: true, doneBy: "dave", doneAt: T0 }));
    await assertFails(updateDoc(doc(alice(), "projects/p1/goals/g1"), { doneBy: deleteField() }));
    await assertSucceeds(updateDoc(doc(admin(), "projects/p1/goals/g1"), { doneBy: deleteField() }));
  });
  it("on retrouve et supprime ses objectifs et ses fiches, même hors du projet", async () => {
    const db = dave();
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "projects/p1/goals/g2"),
      { title: "Ancien", done: false, createdBy: "dave", createdAt: T0, updatedAt: T0 }));
    await assertSucceeds(getDocs(query(collectionGroup(db, "goals"), where("createdBy", "==", "dave"))));
    await assertSucceeds(deleteDoc(doc(db, "projects/p1/goals/g2")));
    await assertSucceeds(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "dave"))));
    await assertSucceeds(deleteDoc(doc(db, "projects/p1/members/dave")));
    await assertFails(getDocs(query(collectionGroup(db, "members"), where("uid", "==", "alice"))));
  });
});

describe("Projet : tâches (todo list)", () => {
  const carol = () => as("carol");
  const task = (uid, extra = {}) => ({
    title: "Écrire la doc", done: false, createdBy: uid,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  });
  const newTask = (db) => doc(collection(db, "projects/p1/tasks"));
  const now = () => ({ updatedAt: serverTimestamp() });
  const finish = (uid) => ({ done: true, doneBy: uid, doneAt: serverTimestamp(), ...now() });
  // Tâche déjà terminée (historique), écrite hors règles.
  const seedDone = (id = "t2", by = "carol") => env.withSecurityRulesDisabled((ctx) =>
    setDoc(doc(ctx.firestore(), `projects/p1/tasks/${id}`),
      { title: "Fait", done: true, doneBy: by, doneAt: T0, createdBy: "alice", createdAt: T0, updatedAt: T0 }));

  it("un membre ajoute une tâche, pas un non-membre", async () => {
    const db = carol();
    await assertSucceeds(rated(db, "carol", (b) => b.set(newTask(db), task("carol"))));
    const other = bob();
    await assertFails(rated(other, "bob", (b) => b.set(newTask(other), task("bob"))));
  });
  it("la tâche est créée à faire, à son nom, avec un texte non vide", async () => {
    const db = carol();
    await assertFails(rated(db, "carol", (b) => b.set(newTask(db), task("carol", { done: true }))));
    await assertFails(rated(db, "carol", (b) => b.set(newTask(db), task("carol", { createdBy: "alice" }))));
    await assertFails(rated(db, "carol", (b) => b.set(newTask(db), task("carol", { title: "" }))));
    await assertFails(rated(db, "carol", (b) => b.set(newTask(db), task("carol", { title: "x".repeat(201) }))));
    await assertFails(rated(db, "carol", (b) => b.set(newTask(db), task("carol", { extra: 1 }))));
  });
  it("une écriture sans le compteur anti-abus est refusée", () => {
    const db = carol();
    return assertFails(setDoc(newTask(db), task("carol")));
  });
  it("les membres lisent la liste, pas un ancien membre", async () => {
    await assertSucceeds(getDocs(collection(carol(), "projects/p1/tasks")));
    await assertSucceeds(getDocs(collection(admin(), "projects/p1/tasks")));
    await assertFails(getDocs(collection(dave(), "projects/p1/tasks")));
    await assertFails(getDocs(collection(bob(), "projects/p1/tasks")));
  });
  it("tout membre coche une tâche, en son nom et à l'heure du serveur", async () => {
    const db = carol();
    await assertFails(change(db, "carol", "projects/p1/tasks/t1", { ...finish("alice") }));
    await assertFails(change(db, "carol", "projects/p1/tasks/t1", { done: true, doneBy: "carol", doneAt: T0, ...now() }));
    await assertSucceeds(change(db, "carol", "projects/p1/tasks/t1", finish("carol")));
  });
  it("une tâche à faire ne porte ni auteur ni date de réalisation", () =>
    assertFails(change(carol(), "carol", "projects/p1/tasks/t1",
      { done: false, doneBy: "carol", doneAt: serverTimestamp(), ...now() })));
  it("une tâche terminée peut être rouverte", async () => {
    await seedDone();
    await assertSucceeds(change(carol(), "carol", "projects/p1/tasks/t2",
      { done: false, doneBy: deleteField(), doneAt: deleteField(), ...now() }));
  });
  it("une tâche terminée garde son historique : ni auteur ni date réécrits", async () => {
    await seedDone();
    await assertFails(change(carol(), "carol", "projects/p1/tasks/t2", { doneBy: "alice", ...now() }));
    await assertFails(change(carol(), "carol", "projects/p1/tasks/t2", { doneAt: serverTimestamp(), ...now() }));
  });
  it("l'auteur et l'admin modifient le texte d'une tâche à faire, pas un autre membre", async () => {
    await assertFails(change(carol(), "carol", "projects/p1/tasks/t1", { title: "Autre", ...now() }));
    await assertSucceeds(change(alice(), "alice", "projects/p1/tasks/t1", { title: "Écrire la doc v2", ...now() }));
    await assertSucceeds(change(admin(), ADMIN, "projects/p1/tasks/t1", { title: "Écrire la doc v3", ...now() }));
  });
  it("le texte d'une tâche terminée ne se modifie plus, même par son auteur ou l'admin", async () => {
    await seedDone();
    await assertFails(change(alice(), "alice", "projects/p1/tasks/t2", { title: "Réécrit", ...now() }));
    await assertFails(change(admin(), ADMIN, "projects/p1/tasks/t2", { title: "Réécrit", ...now() }));
  });
  it("l'auteur ne peut pas changer l'auteur ni la date de création", async () => {
    await assertFails(change(alice(), "alice", "projects/p1/tasks/t1", { createdBy: "carol", ...now() }));
    await assertFails(change(alice(), "alice", "projects/p1/tasks/t1", { createdAt: serverTimestamp(), ...now() }));
  });
  it("seuls l'auteur et l'admin suppriment", async () => {
    await assertFails(deleteDoc(doc(carol(), "projects/p1/tasks/t1")));
    await assertSucceeds(deleteDoc(doc(alice(), "projects/p1/tasks/t1")));
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "projects/p1/tasks/t3"), task("alice", { createdAt: T0, updatedAt: T0 })));
    await assertSucceeds(deleteDoc(doc(admin(), "projects/p1/tasks/t3")));
  });
  it("on retire son nom d'une tâche cochée (effacement), sans la rouvrir", async () => {
    await seedDone("t2", "dave");
    const db = dave();
    await assertSucceeds(getDocs(query(collectionGroup(db, "tasks"), where("doneBy", "==", "dave"))));
    await assertFails(updateDoc(doc(db, "projects/p1/tasks/t2"), { doneBy: deleteField(), done: false }));
    await assertSucceeds(updateDoc(doc(db, "projects/p1/tasks/t2"), { doneBy: deleteField() }));
  });
  it("l'admin retire le nom de quelqu'un d'une tâche cochée, un membre non", async () => {
    await seedDone("t2", "dave");
    await assertFails(updateDoc(doc(alice(), "projects/p1/tasks/t2"), { doneBy: deleteField() }));
    await assertSucceeds(updateDoc(doc(admin(), "projects/p1/tasks/t2"), { doneBy: deleteField() }));
  });
  it("on retrouve et supprime ses tâches, même hors du projet", async () => {
    const db = dave();
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "projects/p1/tasks/t4"),
      { title: "Ancienne", done: false, createdBy: "dave", createdAt: T0, updatedAt: T0 }));
    await assertSucceeds(getDocs(query(collectionGroup(db, "tasks"), where("createdBy", "==", "dave"))));
    await assertSucceeds(deleteDoc(doc(db, "projects/p1/tasks/t4")));
    await assertFails(getDocs(query(collectionGroup(db, "tasks"), where("createdBy", "==", "alice"))));
  });
});

describe("Droits RGPD (requêtes sur toutes les conversations)", () => {
  const mine = (db, group, field, uid) => getDocs(query(collectionGroup(db, group), where(field, "==", uid)));

  it("un ancien membre retrouve ses messages, photos et accusés", async () => {
    const db = dave();
    await assertSucceeds(mine(db, "messages", "authorUid", "dave"));
    await assertSucceeds(mine(db, "images", "authorUid", "dave"));
    await assertSucceeds(mine(db, "thumbs", "authorUid", "dave"));
    await assertSucceeds(mine(db, "reads", "uid", "dave"));
  });
  it("et peut les supprimer", async () => {
    const db = dave();
    await assertSucceeds(deleteDoc(doc(db, "conversations/c1/images/m3")));
    await assertSucceeds(deleteDoc(doc(db, "conversations/c1/messages/m3")));
    await assertSucceeds(deleteDoc(doc(db, "conversations/c1/reads/dave")));
  });
  it("personne ne lit ainsi les données d'un autre", async () => {
    const db = alice();
    await assertFails(mine(db, "messages", "authorUid", "carol"));
    await assertFails(mine(db, "images", "authorUid", "dave"));
    await assertFails(mine(db, "thumbs", "authorUid", "dave"));
    await assertFails(mine(db, "reads", "uid", "carol"));
  });
  it("l'admin peut tout interroger (suppression d'un compte)", () =>
    assertSucceeds(mine(admin(), "messages", "authorUid", "carol")));
});

describe("Tout le reste est interdit", () => {
  it("une collection inconnue est refusée, même à l'admin", () =>
    assertFails(setDoc(doc(admin(), "divers/x"), { a: 1 })));
});

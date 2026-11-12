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
  arrayRemove, arrayUnion, collection, collectionGroup, deleteDoc, doc, getDoc, getDocs,
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
  it("un membre se retire lui-même", () =>
    assertSucceeds(updateDoc(doc(alice(), "conversations/c1"), { members: arrayRemove("alice") })));
  it("un membre ne retire pas quelqu'un d'autre", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { members: arrayRemove("carol") })));
  it("un non-membre ne s'ajoute pas", () =>
    assertFails(updateDoc(doc(bob(), "conversations/c1"), { members: arrayUnion("bob") })));
  it("l'admin ajoute un membre", () =>
    assertSucceeds(updateDoc(doc(admin(), "conversations/c1"), { members: arrayUnion("bob"), updatedAt: serverTimestamp() })));
  it("un membre met à jour la date du dernier message, à l'heure du serveur", () =>
    assertSucceeds(updateDoc(doc(alice(), "conversations/c1"), { lastMessageAt: serverTimestamp() })));
  it("une date du dernier message fixée par le client est refusée", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { lastMessageAt: Timestamp.now() })));
  it("un membre ne modifie rien d'autre en même temps", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1"), { lastMessageAt: serverTimestamp(), title: "Pirate" })));
  it("un non-membre ne touche pas à la date du dernier message", () =>
    assertFails(updateDoc(doc(bob(), "conversations/c1"), { lastMessageAt: serverTimestamp() })));
  it("l'admin met à jour la date du dernier message en envoyant un message", async () => {
    const db = admin();
    const batch = writeBatch(db);
    batch.set(newMessageRef(db), message(ADMIN));
    batch.update(doc(db, "conversations/c1"), { lastMessageAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
  });
  it("seul l'admin supprime une conversation", async () => {
    await assertFails(deleteDoc(doc(alice(), "conversations/c1")));
    await assertSucceeds(deleteDoc(doc(admin(), "conversations/c1")));
  });
});

describe("Messages", () => {
  it("un membre écrit un message", () => assertSucceeds(setDoc(newMessageRef(alice()), message("alice"))));
  it("un non-membre n'écrit pas", () => assertFails(setDoc(newMessageRef(bob()), message("bob"))));
  it("écrire au nom d'un autre UID est refusé", () =>
    assertFails(setDoc(newMessageRef(alice()), message("carol"))));
  it("une date fixée par le client est refusée", () =>
    assertFails(setDoc(newMessageRef(alice()), message("alice", { createdAt: Timestamp.now() }))));
  it("un message vide sans photo est refusé", () =>
    assertFails(setDoc(newMessageRef(alice()), message("alice", { text: "" }))));
  it("un texte de plus de 4000 caractères est refusé", () =>
    assertFails(setDoc(newMessageRef(alice()), message("alice", { text: "x".repeat(4001) }))));
  it("un champ inconnu est refusé", () =>
    assertFails(setDoc(newMessageRef(alice()), message("alice", { pinned: true }))));
  it("un message ne peut pas être modifié", () =>
    assertFails(updateDoc(doc(alice(), "conversations/c1/messages/m1"), { text: "modifié" })));
  it("une réponse à un message existant est acceptée", () =>
    assertSucceeds(setDoc(newMessageRef(alice()), message("alice", { replyTo: "m2" }))));
  it("une réponse à un message inexistant est refusée", () =>
    assertFails(setDoc(newMessageRef(alice()), message("alice", { replyTo: "inexistant" }))));
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

describe("Photos", () => {
  function sendPhoto(db, uid, { data = JPEG, w = 800, h = 600 } = {}) {
    const ref = newMessageRef(db);
    const batch = writeBatch(db);
    batch.set(ref, message(uid, { image: { w, h } }));
    batch.set(doc(db, `conversations/c1/images/${ref.id}`), { data, authorUid: uid, createdAt: serverTimestamp() });
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
    assertFails(setDoc(newMessageRef(alice()), message("alice", { image: { w: 10, h: 10 } }))));
  it("une photo rattachée au message d'un autre est refusée", () =>
    assertFails(setDoc(doc(alice(), "conversations/c1/images/m2"), {
      data: JPEG, authorUid: "alice", createdAt: serverTimestamp(),
    })));
  it("un non-membre ne lit pas les photos", () =>
    assertFails(getDoc(doc(bob(), "conversations/c1/images/m3"))));
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
});

describe("Droits RGPD (requêtes sur toutes les conversations)", () => {
  const mine = (db, group, field, uid) => getDocs(query(collectionGroup(db, group), where(field, "==", uid)));

  it("un ancien membre retrouve ses messages, photos et accusés", async () => {
    const db = dave();
    await assertSucceeds(mine(db, "messages", "authorUid", "dave"));
    await assertSucceeds(mine(db, "images", "authorUid", "dave"));
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
    await assertFails(mine(db, "reads", "uid", "carol"));
  });
  it("l'admin peut tout interroger (suppression d'un compte)", () =>
    assertSucceeds(mine(admin(), "messages", "authorUid", "carol")));
});

describe("Tout le reste est interdit", () => {
  it("une collection inconnue est refusée, même à l'admin", () =>
    assertFails(setDoc(doc(admin(), "divers/x"), { a: 1 })));
});

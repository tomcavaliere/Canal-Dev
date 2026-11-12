# Canal-Dev

Canal de communication pour suivre le développement d'un outil.

- Connexion avec un compte Google (adresses `@gmail.com` uniquement).
- Plusieurs conversations. Un utilisateur ne voit que celles auxquelles l'administrateur lui a donné accès, et peut y lire et écrire.
- Seul l'administrateur crée/supprime les conversations et ajoute/retire des membres.
- Liste triée par dernière activité, non-lus synchronisés entre appareils, messages paginés par 100,
  recherche dans les messages chargés, modification de ses messages, liens et `code` mis en forme.
- Installable comme application (PWA) ; notifications tant que l'application est ouverte (pas de push : plan Spark).
- L'administrateur peut ranger les conversations dans des **projets** (ou les laisser « Sans projet ») et les déplacer de l'un à l'autre. Les membres voient le nom du projet de leurs conversations, jamais la liste des autres projets.
- Un utilisateur connecté sans accès voit un écran « Accès en attente » et apparaît dans la liste « Utilisateurs » de l'admin.
- Le nom affiché à côté des messages vient d'un **annuaire tenu par l'administrateur** : personne ne peut se faire passer pour un autre membre, et les messages de l'admin portent un badge **Admin**.

Hébergement : Firebase Hosting (fichiers statiques, <https://canal-dev-c18d7.web.app>). Auth + données : Firebase (Authentication + Cloud Firestore, plan gratuit Spark).
L'ancienne adresse GitHub Pages redirige vers la nouvelle ([js/redirect.js](js/redirect.js)).
Le contrôle d'accès est appliqué côté serveur par [firestore.rules](firestore.rules).

## Structure

```
index.html              page unique
manifest.webmanifest    installation comme application (PWA)
sw.js                   service worker : installation et notifications (aucun cache, aucune donnée)
icons/                  icônes de l'application (icon.svg est la source des PNG)
css/style.css           styles (clair/sombre, responsive)
js/firebase-config.js   config Firebase + ADMIN_UID  ← à remplir
js/firebase.js          initialisation Firebase
js/sdk/                 SDK Firebase chargé depuis gstatic (seul endroit où figure sa version)
js/app.js               point d'entrée : connexion, session, conversations, projets
js/state.js             état partagé de la session
js/sidebar.js           barre latérale (conversations par projet, tri par activité)
js/unread.js            non-lus, nouveaux messages, son et notifications
js/messages.js          conversation ouverte : messages paginés, réponses, modification, photos
js/receipts.js          accusés de lecture (« Vu par … »)
js/search.js            recherche dans les messages chargés
js/composer.js          saisie, photo jointe, envoi
js/admin.js             création de conversations, gestion des membres (admin)
js/account.js           « Mon compte » : export et suppression des données (RGPD)
js/names.js             annuaire des noms affichés (names/{uid}, écrit par l'admin seul)
js/ui.js                helpers d'affichage (avatar à initiales)
js/dialogs.js           dialogue de confirmation et messages brefs (remplacent alert/confirm)
js/richtext.js          liens cliquables et code dans les messages
js/notify.js            notifications et enregistrement du service worker
js/images.js            préparation des photos (redimensionnement, suppression des métadonnées)
js/redirect.js          redirige l'ancienne adresse GitHub Pages vers Firebase Hosting
confidentialite.html    politique de confidentialité
RGPD.md                 registre du traitement et procédures RGPD
firestore.rules         règles de sécurité  ← ADMIN_UID à remplir
firestore.indexes.json  index (collection groups messages.authorUid, images.authorUid et reads.uid, requis pour l'export/la suppression)
firebase.json           hébergement (en-têtes HTTP, fichiers exclus), règles, index, émulateur des tests
.firebaserc             projet Firebase par défaut
package.json            outils de test et de déploiement (le site ne charge aucune de ces dépendances)
.github/workflows/      tests à chaque push, déploiement automatique depuis main
scripts/test-rules.sh   lance l'émulateur Firestore et les tests
tests/rules.test.mjs    tests des règles de sécurité
```

## Mise en place

### 1. Projet Firebase
1. Sur <https://console.firebase.google.com>, crée un projet.
2. **Paramètres du projet → Vos applications → Web (`</>`)** : enregistre une app, copie l'objet `firebaseConfig` dans [js/firebase-config.js](js/firebase-config.js).
3. **Authentication → Sign-in method** : active **Google**.
4. **Authentication → Settings → Authorized domains** : vérifie que `canal-dev-c18d7.web.app` y figure (`localhost` y est déjà).
5. **Firestore Database** : crée la base en **mode production**.

### 2. Règles de sécurité (première version)
Déploie [firestore.rules](firestore.rules) :
- soit en copiant son contenu dans **Firestore → Règles → Publier** ;
- soit avec la CLI : `npm i -g firebase-tools && firebase login && firebase use --add && firebase deploy --only firestore`.

La CLI déploie aussi [firestore.indexes.json](firestore.indexes.json). Si tu passes par la console, crée l'exemption d'index à la main :
**Firestore → Index → Champ unique → Ajouter une exemption** : collection `messages`, champ `authorUid`, portée **Groupe de collections**, ordre croissant activé. Idem pour la collection `images`, et pour la collection `reads` avec le champ `uid`.
Sans cet index, « Télécharger mes données » et la suppression de compte échouent.

### 3. Devenir administrateur
1. Lance le site en local (voir plus bas) et connecte-toi avec ton compte Gmail.
2. L'écran « Accès en attente » affiche ton **identifiant** (UID). Il est aussi visible dans **Authentication → Users**.
3. Remplace `REMPLACER_PAR_TON_UID` par cet UID dans **les deux** fichiers :
   - [js/firebase-config.js](js/firebase-config.js) (`ADMIN_UID`)
   - [firestore.rules](firestore.rules) (`adminUid()`)
4. Redéploie les règles, recharge la page : tu as le badge **Admin**.

### 4. Publier sur Firebase Hosting
À la main : `npx firebase login` (une fois), puis `npm run deploy` (site + règles + index).

Firebase Hosting envoie `Cache-Control: no-cache` : le navigateur revérifie chaque fichier à chaque visite
(réponse 304 s'il n'a pas changé). Il n'y a donc plus de numéro de version `?v=` à incrémenter.
Les en-têtes de sécurité (interdiction d'afficher le site dans un cadre, `nosniff`, etc.) sont dans
[firebase.json](firebase.json) ; la politique de contenu (CSP) reste dans chaque page HTML.

### 5. Déploiement automatique (GitHub Actions)
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) lance la vérification de syntaxe et les tests
des règles à chaque push et pull request, puis, sur `main` uniquement et si tout passe, déploie site, règles
et index. Le code et les règles partent donc toujours ensemble. Mise en place, une fois :
1. Google Cloud Console → projet `canal-dev-c18d7` → **IAM → Comptes de service → Créer** (par ex. `github-deploy`),
   avec les rôles : *Administrateur Firebase Hosting*, *Administrateur des règles Firebase*,
   *Administrateur des index Cloud Datastore*, *Consommateur Service Usage*.
2. Sur ce compte : **Clés → Ajouter une clé → JSON**. Le fichier téléchargé est un secret : ne le commite jamais.
3. GitHub → **Settings → Secrets and variables → Actions → New repository secret** :
   nom `FIREBASE_SERVICE_ACCOUNT`, valeur = contenu du fichier JSON. Supprime ensuite le fichier.

Si un déploiement échoue pour une permission manquante, le journal de l'action nomme la permission :
ajoute le rôle correspondant au compte de service.

### 6. Quitter GitHub Pages
Une fois le site en ligne sur web.app, laisse GitHub Pages actif quelque temps : [js/redirect.js](js/redirect.js)
renvoie les anciens liens vers la nouvelle adresse. Désactive-le ensuite (GitHub → **Settings → Pages**),
puis retire `tomcavaliere.github.io` des domaines autorisés d'Authentication.

## Utilisation (admin)
1. **+ Projet** (facultatif) : crée un projet. Le ✎ à côté d'un projet permet de le renommer ou de le supprimer (ses conversations sont conservées et passent « Sans projet »).
1. **+ Conversation** (ou **+** à côté d'un projet) : crée une conversation, dans un projet ou non. En haut d'une conversation : **Renommer** (titre et description) et **Déplacer** (changer de projet).
2. Demande à la personne de se connecter une fois : elle apparaît dans **Utilisateurs** avec la mention « en attente ».
   Ou, sans attendre : **Membres → Inviter par email** (adresse Gmail + nom affiché). À sa première connexion,
   elle rejoint directement la conversation sous ce nom (aucun email n'est envoyé : préviens-la toi-même).
3. Ouvre la conversation → **Membres** → coche la personne. Elle voit la conversation apparaître instantanément.
   Son **nom affiché** est repris de son compte Google à ce moment-là (un nom déjà pris devient « Nom (2) ») ;
   le ✎ à côté d'elle dans « Utilisateurs » permet de le corriger. Il n'est jamais mis à jour automatiquement,
   puisque chacun peut changer son nom Google.
4. Décoche pour retirer l'accès ; **Supprimer** efface la conversation et ses messages.

Les membres existants sont ajoutés à l'annuaire automatiquement dès que l'admin ouvre l'application.
Un message dont l'auteur n'est pas dans l'annuaire (par exemple un ancien membre retiré avant sa mise en place)
affiche le nom saisi par l'auteur, marqué « non vérifié » : le ✎ permet de l'y ajouter.

## Développement local
```bash
python3 -m http.server 8000
# puis http://localhost:8000
```
Les modules ES ne fonctionnent pas en ouvrant `index.html` directement (`file://`) : il faut un serveur.

## Tests des règles de sécurité
Toute la sécurité repose sur [firestore.rules](firestore.rules) : toute modification des règles doit passer les tests,
et chaque nouvelle règle doit avoir les siens dans [tests/rules.test.mjs](tests/rules.test.mjs).
```bash
npm install   # une fois
npm test      # démarre l'émulateur Firestore, lance les tests, l'arrête
```
Prérequis : Node 24.12+ et Java 21+. Sur macOS, `brew install openjdk@21` suffit : le script l'utilise
sans changer le Java par défaut de la machine. Les tests tournent sur un projet fictif (`demo-canal-dev`) :
aucun compte Firebase ni connexion n'est nécessaire.

## RGPD
Le détail est dans [RGPD.md](RGPD.md) (registre, base légale, procédures) et l'information des utilisateurs dans [confidentialite.html](confidentialite.html).

À faire une fois dans la console Firebase :
- [x] **Paramètres du projet → Confidentialité** (ou *Data privacy*) : accepter les *Data Processing Terms*.
- [x] Vérifier que Firestore est bien en région UE (`eur3` ou `europe-*`) — `eur3`, vérifié le 12 novembre 2026.
- [x] **Paramètres du projet → Intégrations → Google Analytics** : désactivé (le site n'en utilise pas).
- [x] Déployer site, règles **et** index (`npm run deploy`, ou automatiquement par la CI).

Au quotidien :
- Un utilisateur exporte ou supprime ses données depuis **Mon compte**.
- La section « Utilisateurs » signale les personnes **en attente** d'accès (son et notification à leur première connexion).
- Tous les trimestres, annuler les invitations marquées **« > 3 mois »** et supprimer les comptes marqués **« inactif > 12 mois »** (✕ dans « Utilisateurs »), puis le compte correspondant dans **Authentication → Users**. Y supprimer aussi les comptes absents de « Utilisateurs » (voir [RGPD.md](RGPD.md#6-conservation--procédure)).
- Une demande par email (opposition, effacement…) : répondre sous 1 mois, voir [RGPD.md](RGPD.md#4-exercice-des-droits-art-12-à-22).

## Sécurité
- La clé `apiKey` Firebase est publique par conception ; elle n'ouvre aucun droit à elle seule.
- Toutes les autorisations sont vérifiées par `firestore.rules` : un utilisateur ne peut ni lire une conversation dont il n'est pas membre, ni modifier la liste des membres, ni écrire un message sous l'identifiant (UID) d'un autre.
- Le nom affiché vient de l'annuaire `names/{uid}`, que seul l'admin peut écrire : le champ `authorName` d'un message est saisi par son auteur (il peut y mettre n'importe quoi depuis la console du navigateur) et n'est affiché qu'en dernier recours, marqué « non vérifié ». Le badge **Admin** dépend de l'UID, pas du nom.
- Tester : `npm test` (voir plus haut), et pour un essai manuel la console du navigateur d'un compte non admin (`permission-denied` attendu).

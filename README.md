# Canal-Dev

Canal de communication pour suivre le développement d'un outil.

- Connexion avec un compte Google (adresses `@gmail.com` uniquement).
- Plusieurs conversations. Un utilisateur ne voit que celles auxquelles l'administrateur lui a donné accès, et peut y lire et écrire.
- Seul l'administrateur crée/supprime les conversations et ajoute/retire des membres.
- L'administrateur peut ranger les conversations dans des **projets** (ou les laisser « Sans projet ») et les déplacer de l'un à l'autre. Les membres voient le nom du projet de leurs conversations, jamais la liste des autres projets.
- Un utilisateur connecté sans accès voit un écran « Accès en attente » et apparaît dans la liste « Utilisateurs » de l'admin.

Hébergement : GitHub Pages (fichiers statiques). Auth + données : Firebase (Authentication + Cloud Firestore, plan gratuit).
Le contrôle d'accès est appliqué côté serveur par [firestore.rules](firestore.rules).

## Structure

```
index.html              page unique
css/style.css           styles (clair/sombre, responsive)
js/firebase-config.js   config Firebase + ADMIN_UID  ← à remplir
js/firebase.js          initialisation Firebase
js/app.js               connexion, conversations, messages
js/admin.js             création de conversations, gestion des membres (admin)
js/account.js           « Mon compte » : export et suppression des données (RGPD)
js/ui.js                helpers d'affichage (avatar à initiales)
js/images.js            préparation des photos (redimensionnement, suppression des métadonnées)
confidentialite.html    politique de confidentialité
RGPD.md                 registre du traitement et procédures RGPD
firestore.rules         règles de sécurité  ← ADMIN_UID à remplir
firestore.indexes.json  index (collection groups messages.authorUid et images.authorUid, requis pour l'export/la suppression)
firebase.json           pour déployer les règles et index avec la CLI Firebase
```

## Mise en place

### 1. Projet Firebase
1. Sur <https://console.firebase.google.com>, crée un projet.
2. **Paramètres du projet → Vos applications → Web (`</>`)** : enregistre une app, copie l'objet `firebaseConfig` dans [js/firebase-config.js](js/firebase-config.js).
3. **Authentication → Sign-in method** : active **Google**.
4. **Authentication → Settings → Authorized domains** : ajoute `tomcavaliere.github.io` (`localhost` y est déjà).
5. **Firestore Database** : crée la base en **mode production**.

### 2. Règles de sécurité (première version)
Déploie [firestore.rules](firestore.rules) :
- soit en copiant son contenu dans **Firestore → Règles → Publier** ;
- soit avec la CLI : `npm i -g firebase-tools && firebase login && firebase use --add && firebase deploy --only firestore`.

La CLI déploie aussi [firestore.indexes.json](firestore.indexes.json). Si tu passes par la console, crée l'exemption d'index à la main :
**Firestore → Index → Champ unique → Ajouter une exemption** : collection `messages`, champ `authorUid`, portée **Groupe de collections**, ordre croissant activé. Idem pour la collection `images`.
Sans cet index, « Télécharger mes données » et la suppression de compte échouent.

### 3. Devenir administrateur
1. Lance le site en local (voir plus bas) et connecte-toi avec ton compte Gmail.
2. L'écran « Accès en attente » affiche ton **identifiant** (UID). Il est aussi visible dans **Authentication → Users**.
3. Remplace `REMPLACER_PAR_TON_UID` par cet UID dans **les deux** fichiers :
   - [js/firebase-config.js](js/firebase-config.js) (`ADMIN_UID`)
   - [firestore.rules](firestore.rules) (`adminUid()`)
4. Redéploie les règles, recharge la page : tu as le badge **Admin**.

### 4. Publier sur GitHub Pages
1. Commit + push sur `main`.
2. GitHub → **Settings → Pages** → Source : *Deploy from a branch*, branche `main`, dossier `/ (root)`.
3. Le site est servi sur <https://tomcavaliere.github.io/Canal-Dev/>.

**À chaque publication qui modifie le JS ou le CSS**, incrémente le numéro de version des liens
(`?v=3` → `?v=4`) pour que les navigateurs ne mélangent pas anciens et nouveaux fichiers
(GitHub Pages les garde 10 minutes en cache) :
```bash
sed -i '' 's/?v=3"/?v=4"/g' index.html confidentialite.html js/*.js
```

## Utilisation (admin)
1. **+ Projet** (facultatif) : crée un projet. Le ✎ à côté d'un projet le renomme ou le supprime (ses conversations sont conservées et passent « Sans projet »).
1. **+ Conversation** (ou **+** à côté d'un projet) : crée une conversation, dans un projet ou non. **Déplacer** (en haut d'une conversation) la change de projet.
2. Demande à la personne de se connecter une fois : elle apparaît dans **Utilisateurs** avec la mention « en attente ».
3. Ouvre la conversation → **Membres** → coche la personne. Elle voit la conversation apparaître instantanément.
4. Décoche pour retirer l'accès ; **Supprimer** efface la conversation et ses messages.

## Développement local
```bash
python3 -m http.server 8000
# puis http://localhost:8000
```
Les modules ES ne fonctionnent pas en ouvrant `index.html` directement (`file://`) : il faut un serveur.

## RGPD
Le détail est dans [RGPD.md](RGPD.md) (registre, base légale, procédures) et l'information des utilisateurs dans [confidentialite.html](confidentialite.html).

À faire une fois dans la console Firebase :
- [ ] **Paramètres du projet → Confidentialité** (ou *Data privacy*) : accepter les *Data Processing Terms*.
- [ ] Vérifier que Firestore est bien en région UE (`eur3` ou `europe-*`).
- [ ] **Paramètres du projet → Intégrations → Google Analytics** : désactivé (le site n'en utilise pas).
- [ ] Déployer règles **et** index (`firebase deploy --only firestore`).

Au quotidien :
- Un utilisateur exporte ou supprime ses données depuis **Mon compte**.
- Tous les trimestres, supprimer les comptes marqués **« inactif > 12 mois »** (✕ dans « Utilisateurs »), puis le compte correspondant dans **Authentication → Users**.
- Une demande par email (opposition, effacement…) : répondre sous 1 mois, voir [RGPD.md](RGPD.md#4-exercice-des-droits-art-12-à-22).

## Sécurité
- La clé `apiKey` Firebase est publique par conception ; elle n'ouvre aucun droit à elle seule.
- Toutes les autorisations sont vérifiées par `firestore.rules` : un utilisateur ne peut ni lire une conversation dont il n'est pas membre, ni modifier la liste des membres, ni écrire un message au nom d'un autre.
- Tester : dans **Firestore → Règles → Rules Playground**, ou en essayant depuis la console du navigateur d'un compte non admin (`permission-denied` attendu).

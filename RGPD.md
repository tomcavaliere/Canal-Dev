# Conformité RGPD — Canal Dev

Documentation interne du responsable du traitement (principe de responsabilité, art. 5.2 RGPD).
L'information des personnes est dans [confidentialite.html](confidentialite.html) ; ce fichier doit rester cohérent avec elle.

Dernière revue : 12 novembre 2026.

## 1. Registre du traitement (art. 30)

| Rubrique | Contenu |
|---|---|
| Traitement | Canal de communication « Canal Dev » (suivi du développement d'un outil) |
| Responsable | Tom Cavaliere — tomcavaliere66@gmail.com |
| Finalité | Authentifier les participants, gérer leurs accès aux conversations, échanger et conserver des messages |
| Base légale | Intérêt légitime (art. 6.1.f) — voir § 2 |
| Personnes concernées | Personnes invitées qui se connectent avec un compte Gmail (y compris avant leur première connexion, via une invitation) ; l'administrateur |
| Données | Email, nom du compte Google (profil), nom affiché aux membres (annuaire `names/{uid}` tenu par l'admin), UID Firebase, date de création et de dernière connexion, contenu et date des messages (et de leur dernière modification), photos jointes aux messages (sans métadonnées), appartenance aux conversations, date de dernière lecture de chaque conversation (accusés de lecture, qui servent aussi à synchroniser les non-lus entre les appareils de la personne). Invitation (`invites/{email}`) : email, nom affiché prévu et conversations, saisis par l'admin avant la première connexion. Présence « en ligne » (Realtime Database, `status/{uid}/{onglet}`) : uniquement « application ouverte en ce moment », sans date ni historique, effacée par le serveur à la fermeture ; réglage `noPresence` du profil pour la masquer. Compteur anti-abus (`rate/{uid}`) : nombre de messages envoyés ou modifiés dans la minute en cours, date de début de cette minute et du dernier envoi. URL de la photo Google : enregistrée automatiquement par Firebase Authentication dans le compte de connexion, jamais copiée dans Firestore, utilisée ni affichée (incluse dans l'export). Données techniques (IP) chez les hébergeurs. Pas de donnée sensible (art. 9) demandée |
| Personnes concernées indirectement | Personnes pouvant apparaître sur les photos partagées (voir § 10) |
| Destinataires | Administrateur (tout) ; membres d'une conversation (nom affiché, messages, photos et date de dernière lecture de cette conversation) ; utilisateurs connectés connaissant l'UID d'une personne, en pratique ses co-membres (nom affiché, présence « en ligne » sauf si masquée) ; sous-traitants (§ 3) |
| Transferts hors UE | Firebase Authentication et Firebase Hosting (réseau mondial, dont États-Unis), GitHub Pages tant que l'ancienne adresse redirige : EU-US Data Privacy Framework + clauses contractuelles types. Firestore et Realtime Database : région UE |
| Durées | Compte/profil/nom affiché : jusqu'à suppression, max. 12 mois après la dernière connexion. Compte de connexion d'une adresse refusée (non Gmail) : supprimé immédiatement par l'application. Invitation : supprimée dès la première connexion (elle a servi), sinon annulée par l'admin au plus tard 3 mois après sa création. Compteur anti-abus : supprimé avec le compte par l'admin, ou automatiquement à la prochaine ouverture de l'application par l'admin si la personne a supprimé son compte elle-même. Messages, photos et accusés de lecture : durée de vie de la conversation, ou jusqu'à suppression par l'auteur / suppression du compte |
| Sécurité | § 5 |

## 2. Base légale : mise en balance de l'intérêt légitime

- **Intérêt poursuivi** : disposer d'un canal d'échange privé et sécurisé avec les participants du projet.
- **Nécessité** : impossible de restreindre l'accès aux conversations sans identifier les personnes ; seules les données indispensables sont gardées (photo Google jamais utilisée, pas de téléphone, pas d'analytics).
- **Attentes raisonnables** : les personnes se connectent volontairement à un outil de messagerie et sont informées avant la connexion.
- **Garanties** : export et suppression en libre-service, contrôle d'accès serveur, purge des comptes inactifs, pas de réutilisation.

Conclusion : l'intérêt légitime n'est pas supplanté par les droits des personnes. Le consentement n'est pas requis.

## 3. Sous-traitants (art. 28)

| Sous-traitant | Rôle | Localisation | Garanties |
|---|---|---|---|
| Google (Firebase Authentication) | Comptes de connexion | États-Unis | DPF + CCT, *Firebase Data Processing and Security Terms* |
| Google (Cloud Firestore) | Profils, conversations, messages, photos | UE | *Firebase Data Processing and Security Terms* |
| Google (Firebase Realtime Database) | Présence « en ligne » (sans historique) | UE (europe-west1) | Idem |
| Google (gstatic.com) | Distribution du SDK Firebase | Mondial | Idem |
| Google (Firebase Hosting) | Hébergement des fichiers statiques | Mondial (CDN), dont États-Unis | DPF + CCT, *Firebase Data Processing and Security Terms* |
| GitHub Pages | Redirection de l'ancienne adresse vers Firebase Hosting (à fermer) | États-Unis | DPF + CCT, *GitHub Data Protection Agreement* |

À faire une fois dans la console (voir [README.md](README.md#rgpd)) : accepter les conditions de traitement des données de Firebase.

## 4. Exercice des droits (art. 12 à 22)

| Droit | Moyen | Implémentation |
|---|---|---|
| Accès, portabilité | *Mon compte → Télécharger mes données* (JSON : compte de connexion dont l'URL de la photo Google, profil, nom affiché, invitation en attente, messages, photos et miniatures en data URL, accusés) | [js/account.js](js/account.js) `collectMyData` |
| Effacement | *Mon compte → Supprimer mon compte* | `purgeUserData` (messages, photos et miniatures, accusés, accès, invitation, présence, nom affiché, profil) + `deleteUser` (après réauthentification) + effacement des clés `canal-dev.*` du navigateur |
| Effacement (sur demande email) | Admin : bouton ✕ dans « Utilisateurs », puis Firebase Console → Authentication → supprimer l'utilisateur | [js/admin.js](js/admin.js) |
| Rectification | Nom affiché : l'admin le corrige (✎ dans « Utilisateurs ») ; la personne le voit dans *Mon compte*. Messages : *Modifier* (texte seul, mention « modifié », sans historique) ou supprimer et republier | [js/admin.js](js/admin.js) |
| Opposition aux accusés de lecture | *Mon compte → Ne pas envoyer d'accusés de lecture* | Réglage `noReceipts` du profil : plus aucun accusé écrit, les existants supprimés ([js/account.js](js/account.js)) |
| Opposition à la présence « en ligne » | *Mon compte → Masquer ma présence « en ligne »* | Réglage `noPresence` du profil : plus rien n'est écrit, les entrées en cours sont effacées ([js/account.js](js/account.js), [js/presence.js](js/presence.js)) |
| Opposition, limitation | Email au responsable | Retirer les accès / supprimer le compte selon la demande |

Délai de réponse : 1 mois (prolongeable de 2 mois si nécessaire, en informant la personne). Vérifier l'identité du demandeur (la demande doit venir de l'adresse Gmail concernée).

Le compte administrateur ne peut pas se supprimer depuis l'application (son UID est codé dans les règles). Pour clôturer le service : supprimer les conversations, les utilisateurs, puis le projet Firebase.

## 5. Mesures de sécurité (art. 32)

- Authentification Google, email vérifié, domaine `@gmail.com` imposé côté serveur.
- Contrôle d'accès dans [firestore.rules](firestore.rules) : lecture limitée aux membres, écriture des messages au seul nom de l'auteur, gestion des membres réservée à l'admin (un membre peut seulement se retirer lui-même), tout le reste interdit. Présence ([database.rules.json](database.rules.json)) : chacun n'écrit que la sienne (valeur `true` seule), lecture par UID uniquement, jamais la liste. Ces règles sont vérifiées par des tests automatiques (`npm test`, émulateurs Firestore et Realtime Database).
- Identité : le nom affiché vient d'un annuaire (`names/{uid}`) que seul l'admin peut écrire, et les messages de l'admin portent un badge lié à son UID. Un membre ne peut donc pas se faire passer pour un autre ; le nom saisi par l'auteur (`authorName`) n'est plus affiché qu'en dernier recours, marqué « non vérifié ».
- HTTPS avec HSTS (Firebase Hosting) ; chiffrement au repos par Google.
- Content-Security-Policy dans les pages : scripts limités au site, gstatic.com et apis.google.com ; aucune image externe ; `referrer` désactivé.
- En-têtes HTTP ([firebase.json](firebase.json)) : le site ne peut pas être affiché dans un cadre d'un autre site (`frame-ancestors 'none'`, `X-Frame-Options`), `nosniff`, caméra/micro/position désactivés.
- Déploiement automatique ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) : les règles ne sont publiées que si leurs tests passent, en même temps que le code qui en dépend.
- Limitation anti-abus dans les règles : 30 messages (envois et modifications) par minute et par personne, profil mis à jour au plus une fois par minute.
- Pas de clé secrète dans le dépôt (la configuration Firebase web est publique par conception). La clé API est restreinte aux domaines du site et aux API Firebase utilisées (voir README).
- Risque résiduel : sans serveur (plan Spark), un membre malveillant peut encore consommer le quota gratuit (environ 43 000 écritures par jour au maximum avec la limitation). Le service s'arrêterait alors jusqu'au lendemain, sans fuite de données. Réponse : retirer ses accès et supprimer son compte.
- Pas d'outil de mesure d'audience ni de traceur.

## 6. Conservation : procédure

Pas de backend (plan gratuit Firebase) : la purge est manuelle.
Au moins une fois par trimestre, l'admin ouvre l'application : les comptes sans connexion depuis plus de 12 mois sont marqués **« inactif > 12 mois »**. Les supprimer tous avec le bouton **« Supprimer N comptes inactifs »** (ou un par un avec ✕), puis supprimer les comptes listés dans Firebase Console → Authentication.
Les invitations jamais utilisées depuis plus de 3 mois sont marquées **« > 3 mois »** : les annuler avec ✕.
Dans Authentication → Users, supprimer aussi les comptes absents de la liste « Utilisateurs » de l'application : connexions refusées antérieures à leur suppression automatique, ou comptes dont les données ont déjà été effacées.

## 7. Violation de données (art. 33 et 34)

1. Contenir : révoquer les accès, corriger les règles, changer les mots de passe concernés.
2. Documenter dans ce fichier (date, nature, données et personnes concernées, conséquences, mesures).
3. Si risque pour les personnes : notifier la CNIL sous **72 h** (<https://notifications.cnil.fr/notifications/index>).
4. Si risque élevé : informer les personnes concernées sans délai.

### Journal des violations
_Aucune à ce jour._

## 8. Analyse d'impact (AIPD, art. 35)

Non requise : petit nombre de personnes, pas de donnée sensible, pas de surveillance systématique, pas de profilage, pas de croisement de données.

## 9. Données héritées

Les profils et messages créés avant la mise en conformité contenaient une URL de photo Google :
- profils : la photo est effacée à la prochaine connexion de la personne (ou à la suppression du compte) ;
- messages : l'ancien champ `authorPhoto` n'est plus affiché ; il disparaît avec la suppression du message, du compte ou de la conversation.
- accusés de lecture : l'ancien champ `name` n'est plus affiché ni accepté ; il disparaît à la prochaine lecture de la conversation par la personne, ou avec la suppression du compte ou de la conversation.

## 10. Photos partagées

- **Stockage** : dans Firestore (UE), collection `conversations/{id}/images/{messageId}`, séparée des messages, et une miniature (480 px, ~45 Ko) dans `conversations/{id}/thumbs/{messageId}`, affichée dans le fil ; lecture réservée aux membres de la conversation et à l'admin (mêmes règles que les messages).
- **Minimisation** : redimensionnement à 1600 px max et ré-encodage JPEG dans le navigateur ([js/images.js](js/images.js)) ; les métadonnées EXIF (GPS, date, appareil) ne sont jamais envoyées. Les règles n'acceptent qu'un JPEG en data URL de 900 000 caractères max.
- **Pas de traitement biométrique** : aucune analyse ni reconnaissance automatique ; les photos ne relèvent donc pas de l'art. 9.
- **Tiers photographiés** : avertissement affiché avant chaque envoi (accord de la personne, pas de documents personnels). Toute demande d'un tiers (membre ou non) est traitée par suppression immédiate du message par l'admin (bouton *Supprimer* sur le message), puis réponse à la personne.
- **Effacement** : suppression du message → suppression de la photo et de sa miniature (même batch) ; suppression du compte ou de la conversation → toutes les photos et miniatures concernées.
- **Volume** : environ 300 à 700 Ko par photo, plus 45 Ko de miniature ; le quota gratuit Firestore (1 Gio) permet de l'ordre de 1 500 à 3 000 photos.

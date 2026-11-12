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
| Personnes concernées | Personnes invitées qui se connectent avec un compte Gmail ; l'administrateur |
| Données | Email, nom affiché Google, UID Firebase, date de création et de dernière connexion, contenu et date des messages, photos jointes aux messages (sans métadonnées), appartenance aux conversations, date de dernière lecture de chaque conversation (accusés de lecture). Données techniques (IP) chez les hébergeurs. Pas de photo de profil, pas de donnée sensible (art. 9) demandée |
| Personnes concernées indirectement | Personnes pouvant apparaître sur les photos partagées (voir § 10) |
| Destinataires | Administrateur (tout) ; membres d'une conversation (nom, messages, photos et date de dernière lecture de cette conversation) ; sous-traitants (§ 3) |
| Transferts hors UE | Firebase Authentication et GitHub Pages (États-Unis) : EU-US Data Privacy Framework + clauses contractuelles types. Firestore : région UE |
| Durées | Compte/profil : jusqu'à suppression, max. 12 mois après la dernière connexion. Messages, photos et accusés de lecture : durée de vie de la conversation, ou jusqu'à suppression par l'auteur / suppression du compte |
| Sécurité | § 5 |

## 2. Base légale : mise en balance de l'intérêt légitime

- **Intérêt poursuivi** : disposer d'un canal d'échange privé et sécurisé avec les participants du projet.
- **Nécessité** : impossible de restreindre l'accès aux conversations sans identifier les personnes ; seules les données indispensables sont gardées (photo retirée, pas de téléphone, pas d'analytics).
- **Attentes raisonnables** : les personnes se connectent volontairement à un outil de messagerie et sont informées avant la connexion.
- **Garanties** : export et suppression en libre-service, contrôle d'accès serveur, purge des comptes inactifs, pas de réutilisation.

Conclusion : l'intérêt légitime n'est pas supplanté par les droits des personnes. Le consentement n'est pas requis.

## 3. Sous-traitants (art. 28)

| Sous-traitant | Rôle | Localisation | Garanties |
|---|---|---|---|
| Google (Firebase Authentication) | Comptes de connexion | États-Unis | DPF + CCT, *Firebase Data Processing and Security Terms* |
| Google (Cloud Firestore) | Profils, conversations, messages, photos | UE | *Firebase Data Processing and Security Terms* |
| Google (gstatic.com) | Distribution du SDK Firebase | Mondial | Idem |
| GitHub Pages | Hébergement des fichiers statiques | États-Unis | DPF + CCT, *GitHub Data Protection Agreement* |

À faire une fois dans la console (voir [README.md](README.md#rgpd)) : accepter les conditions de traitement des données de Firebase.

## 4. Exercice des droits (art. 12 à 22)

| Droit | Moyen | Implémentation |
|---|---|---|
| Accès, portabilité | *Mon compte → Télécharger mes données* (JSON, photos incluses en data URL) | [js/account.js](js/account.js) `collectMyData` |
| Effacement | *Mon compte → Supprimer mon compte* | `purgeUserData` + `deleteUser` (après réauthentification) |
| Effacement (sur demande email) | Admin : bouton ✕ dans « Utilisateurs », puis Firebase Console → Authentication → supprimer l'utilisateur | [js/admin.js](js/admin.js) |
| Rectification | Nom repris de Google à chaque connexion ; messages : supprimer et republier | — |
| Opposition, limitation | Email au responsable | Retirer les accès / supprimer le compte selon la demande |

Délai de réponse : 1 mois (prolongeable de 2 mois si nécessaire, en informant la personne). Vérifier l'identité du demandeur (la demande doit venir de l'adresse Gmail concernée).

Le compte administrateur ne peut pas se supprimer depuis l'application (son UID est codé dans les règles). Pour clôturer le service : supprimer les conversations, les utilisateurs, puis le projet Firebase.

## 5. Mesures de sécurité (art. 32)

- Authentification Google, email vérifié, domaine `@gmail.com` imposé côté serveur.
- Contrôle d'accès dans [firestore.rules](firestore.rules) : lecture limitée aux membres, écriture des messages au seul nom de l'auteur, gestion des membres réservée à l'admin (un membre peut seulement se retirer lui-même), tout le reste interdit.
- HTTPS (GitHub Pages, Google) ; chiffrement au repos par Google.
- Content-Security-Policy dans les pages : scripts limités au site, gstatic.com et apis.google.com ; aucune image externe ; `referrer` désactivé.
- Pas de clé secrète dans le dépôt (la configuration Firebase web est publique par conception).
- Pas d'outil de mesure d'audience ni de traceur.

## 6. Conservation : procédure

Pas de backend (plan gratuit Firebase) : la purge est manuelle.
Au moins une fois par trimestre, l'admin ouvre l'application : les comptes sans connexion depuis plus de 12 mois sont marqués **« inactif > 12 mois »**. Les supprimer avec ✕, puis supprimer le compte correspondant dans Firebase Console → Authentication.

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

## 10. Photos partagées

- **Stockage** : dans Firestore (UE), collection `conversations/{id}/images/{messageId}`, séparée des messages ; lecture réservée aux membres de la conversation et à l'admin (mêmes règles que les messages).
- **Minimisation** : redimensionnement à 1600 px max et ré-encodage JPEG dans le navigateur ([js/images.js](js/images.js)) ; les métadonnées EXIF (GPS, date, appareil) ne sont jamais envoyées. Les règles n'acceptent qu'un JPEG en data URL de 900 000 caractères max.
- **Pas de traitement biométrique** : aucune analyse ni reconnaissance automatique ; les photos ne relèvent donc pas de l'art. 9.
- **Tiers photographiés** : avertissement affiché avant chaque envoi (accord de la personne, pas de documents personnels). Toute demande d'un tiers (membre ou non) est traitée par suppression immédiate du message par l'admin (bouton *Supprimer* sur le message), puis réponse à la personne.
- **Effacement** : suppression du message → suppression de la photo (même batch) ; suppression du compte ou de la conversation → toutes les photos concernées.
- **Volume** : environ 300 à 700 Ko par photo ; le quota gratuit Firestore (1 Gio) permet de l'ordre de 1 500 à 3 000 photos.

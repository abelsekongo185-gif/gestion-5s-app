# Gestion 5S : application complète

Signalement d'actions 5S avec photos commentées, alertes en direct, rappels deux fois par jour, case « photo corrigée » devant chaque photo, classement des départements et tableau de bord en pourcentages. L'application s'installe sur téléphone et ordinateur.

Elle ne demande aucune installation de bibliothèque : seul Node.js (version 18 ou plus) est nécessaire.

## 1. Essai sur votre ordinateur

1. Installez Node.js depuis https://nodejs.org (version LTS).
2. Ouvrez un terminal dans ce dossier et lancez : `node server.js`
3. Ouvrez http://localhost:3000
4. Au premier lancement, créez le compte administrateur (nom et code PIN de 4 à 8 chiffres). Six départements d'exemple sont créés, sans responsable ni numéro. Modifiez-les dans l'onglet Équipes.

Les données sont enregistrées dans le dossier `data/`. Pour les sauvegarder, copiez ce dossier.

## 2. Mise en ligne pour toute l'entreprise

Pour que les téléphones se connectent, le serveur doit tourner en permanence et être joignable en **HTTPS**. L'installation sur téléphone et les notifications l'exigent.

Options courantes :
- Un petit serveur (VPS) avec Node.js, derrière Caddy ou Nginx pour le HTTPS.
- Un hébergeur d'applications Node ou Docker (Render, Railway, Fly.io). Il faut un **disque persistant** monté sur le dossier des données, sinon les données disparaissent à chaque redémarrage.

Un `Dockerfile` est fourni : `docker build -t gestion-5s .` puis `docker run -p 3000:3000 -v 5s-data:/data gestion-5s`.

Variables d'environnement :

| Variable | Rôle | Valeur par défaut |
|---|---|---|
| `PORT` | Port du serveur | 3000 |
| `DATA_DIR` | Dossier des données | `./data` |
| `TZ` | Fuseau horaire des rappels | celui du serveur (`Africa/Abidjan` conseillé) |
| `VAPID_SUBJECT` | Adresse de contact pour les notifications, au format `mailto:vous@entreprise.com` | `mailto:admin@example.com` |

Définissez `VAPID_SUBJECT` avec une vraie adresse : Apple peut refuser les notifications sinon.

## 3. Utilisation

- **Administrateur** : dans Équipes, ajoutez les départements (responsable et numéro WhatsApp) et les membres. Donnez un code PIN aux personnes qui doivent se connecter. Sans code, le membre figure seulement dans l'annuaire.
- **Réglages** (administrateur) : logo, nom de l'entreprise, coordonnées du responsable du management 5S, heures des deux rappels (08:00 et 14:00 par défaut).
- **Chaque personne** : se connecte avec son nom et son code. Dans Réglages > Mon compte, elle peut activer les notifications, installer l'application et changer son code.
- **Installation sur téléphone** : Android (Chrome), bouton « Installer sur cet appareil » ou menu du navigateur. iPhone (Safari, iOS 16.4 ou plus), bouton Partager puis « Sur l'écran d'accueil ». Sur iPhone, les notifications ne fonctionnent qu'une fois l'application ajoutée à l'écran d'accueil.

## 4. Archives et import

- **Archiver** : les actions corrigées passent dans l'onglet Archives, hors du fil d'alertes. Elles restent comptées dans le bilan. Un administrateur peut archiver une action (bouton Archiver) ou toutes les corrigées d'un coup, et restaurer une archive.
- **Archivage automatique** : dans Réglages, choisissez le délai (30 jours par défaut, ou jamais). Il s'exécute quand un administrateur ouvre le logiciel.
- **Recherche et export** : l'onglet Archives se filtre par texte et par département, et s'exporte en CSV (ouvrable dans Excel).
- **Import CSV** (administrateurs) : anciennes actions, départements avec responsables, membres. Téléchargez le modèle, remplissez-le, puis choisissez le fichier : un aperçu liste les lignes valides et les erreurs avant l'import. Dans Excel : Enregistrer sous, « CSV (séparateur : point-virgule) ». Maximum 500 lignes par fichier.
  - Anciennes actions : avec une date de correction, l'action est importée directement dans les archives ; sans date, elle reste ouverte dans le fil d'alertes. Les lignes déjà présentes sont ignorées. L'import n'envoie aucune notification.
  - Départements et membres : un nom déjà existant est mis à jour au lieu d'être dupliqué.
- Le logiciel charge jusqu'à 1 000 actions (les plus récentes). Au-delà, exportez les anciennes archives en CSV.

## 5. Rappels et notifications

- Chaque nouveau signalement envoie une notification aux autres personnes qui l'ont activée, même écran fermé.
- Le serveur envoie les rappels aux heures réglées, à tous les appareils abonnés, s'il reste des actions non corrigées. Le serveur doit donc rester allumé.
- Les relances par WhatsApp restent manuelles : le bouton ouvre WhatsApp avec le message prêt à envoyer.

## 6. Sécurité

- Les codes PIN sont stockés chiffrés (scrypt). Cinq essais ratés bloquent la connexion une minute.
- L'écran de connexion liste les noms des membres qui ont un accès. Utilisez des codes PIN que l'on ne devine pas facilement.
- Seuls les administrateurs modifient départements, membres, réglages et suppriment des actions.
- Les photos sont réduites avant l'envoi (environ 100 Ko chacune).

## 7. Limites connues

- Pas de mode hors ligne pour l'envoi : un signalement nécessite une connexion au serveur.
- Un seul serveur, sans sauvegarde automatique : pensez à copier le dossier des données régulièrement.
- Les notifications dépendent des services du navigateur (Google, Apple, Mozilla) et peuvent être retardées.

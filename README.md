# Gestion 5S : version Render + Supabase

Signalement d'actions 5S avec photos commentées, alertes en direct, rappels deux fois par jour, photo corrigée devant chaque photo, archives, import CSV, classement des départements, bilan en pourcentages. Installable sur téléphone et ordinateur (PWA).

Les données sont stockées dans **Supabase** (base PostgreSQL) : elles survivent aux redémarrages et aux mises à jour du serveur. Aucune bibliothèque à installer.

## Ce qu'il faut

- Un compte Supabase (https://supabase.com), gratuit
- Un compte GitHub (Render déploie depuis un dépôt GitHub, pas depuis un zip)
- Un compte Render (https://render.com)

Au total, vous ferez circuler **deux valeurs** de Supabase vers Render :
| Valeur Supabase | Nom de la variable dans Render |
|---|---|
| Adresse du projet (Project URL), de la forme `https://abcdxyz.supabase.co` | `SUPABASE_URL` |
| Clé secrète (Secret key), qui commence par `sb_secret_` | `SUPABASE_SECRET_KEY` |

## Étape 1 : créer le projet et les tables dans Supabase

1. Dans Supabase, **New project**. Choisissez un nom (`gestion5s`), un mot de passe de base de données (notez-le, vous n'en aurez pas besoin ici) et une région proche (Paris ou Francfort). Attendez 1 à 2 minutes la fin de la création.
   Si Supabase refuse (limite de 2 projets gratuits), mettez en pause ou supprimez un ancien projet, y compris dans une autre organisation.
2. Menu de gauche : **SQL Editor** > **New query**.
3. Ouvrez le fichier `supabase-setup.sql` de ce dossier, copiez tout son contenu, collez-le dans l'éditeur, puis cliquez **Run**.
   Résultat attendu : « Success. No rows returned ».
4. Vérification : menu **Table Editor**. Vous devez voir deux tables, `docs` et `meta`.

## Étape 2 : relever les deux valeurs dans Supabase

**A. L'adresse du projet (`SUPABASE_URL`)**
1. Ouvrez votre projet. Cliquez le bouton **Connect** en haut de la page, ou allez dans **Project Settings** (roue dentée) > **Data API**.
2. Copiez **Project URL**. Exemple : `https://abcdxyz.supabase.co`.
3. Si vous ne la trouvez pas : l'adresse de votre navigateur est `https://supabase.com/dashboard/project/abcdxyz`. La partie après `/project/` est l'identifiant du projet. Votre adresse est alors `https://abcdxyz.supabase.co`.
4. Copiez seulement l'adresse de base, sans `/rest/v1` à la fin.

**B. La clé secrète (`SUPABASE_SECRET_KEY`)**
1. **Project Settings** > **API Keys**.
2. Onglet **Secret keys** : copiez la clé `default` (cliquez l'icône œil ou « Reveal » pour l'afficher). Elle commence par `sb_secret_`.
3. Si votre projet est ancien et n'affiche pas cet onglet : onglet **Legacy API Keys**, copiez la clé **service_role** (longue, commence par `eyJ`).
4. N'utilisez jamais la clé **publishable** ou **anon** : le serveur ne pourrait pas écrire les données.
5. Cette clé donne un accès total à la base. Ne la publiez pas, ne la mettez pas sur GitHub, ne l'envoyez pas par message public.

Collez les deux valeurs dans un bloc-notes en attendant l'étape 4.

## Étape 3 : mettre le code sur GitHub

1. Sur GitHub, créez un dépôt (privé de préférence).
2. Dézippez ce dossier, puis dans le dépôt : **Add file > Upload files**. Envoyez le contenu du dossier (`server.js`, `package.json`, `render.yaml`, le dossier `public`, etc.). Pas de fichier `.env`, pas de dossier `node_modules`, ne mettez aucune clé dans les fichiers.

## Étape 4 : coller les valeurs dans Render

1. Dans Render : **New +** > **Blueprint**, choisissez votre dépôt. Render lit `render.yaml` et vous demande les variables à renseigner.
   (Sans Blueprint : **New +** > **Web Service**, choisissez le dépôt, Runtime **Node**, Build Command `npm install`, Start Command `node server.js`.)
2. Collez :
   - `SUPABASE_URL` : l'adresse copiée à l'étape 2A.
   - `SUPABASE_SECRET_KEY` : la clé copiée à l'étape 2B.
   - `VAPID_SUBJECT` : `mailto:` suivi de votre vraie adresse e-mail.
3. Lancez le déploiement.

**Pour modifier ou corriger ces valeurs plus tard** : dans Render, ouvrez votre service > **Environment** > modifiez la variable > **Save changes**. Render redéploie seul. Vérifiez qu'il n'y a pas d'espace ni de guillemet autour de la valeur. Le service doit aussi avoir `TZ` = `Africa/Abidjan` (déjà dans le Blueprint ; sinon ajoutez-la) pour que les rappels partent à l'heure d'Abidjan.

## Étape 5 : vérifier que ça marche

1. Dans Render > votre service > **Logs**, cherchez la ligne `Données : Supabase (https://abcdxyz.supabase.co)`.
2. Ouvrez l'adresse du logiciel (`https://gestion-5s-xxxx.onrender.com`). Le premier écran vous fait créer le compte administrateur (nom et code PIN de 4 à 8 chiffres).
3. Dans Supabase > **Table Editor** > `docs` : après la création, des lignes apparaissent (départements d'exemple). C'est la preuve que les données arrivent bien dans Supabase.

## Dépannage

| Message dans les Logs Render | Cause et remède |
|---|---|
| `SUPABASE_URL et SUPABASE_SECRET_KEY sont absentes` | Variables non renseignées : Render > Environment. |
| `Il faut les deux variables` | Une seule des deux est renseignée. |
| `SUPABASE_URL doit commencer par https://` | Adresse incomplète ou mal copiée. |
| `Les tables n'existent pas` | Exécutez `supabase-setup.sql` (étape 1) dans le bon projet. |
| `Clé refusée par Supabase` | Mauvaise clé ou clé tronquée : recopiez-la en entier. |
| `Cette clé peut lire mais pas écrire` | Vous avez collé la clé publishable/anon : utilisez la clé secrète. |
| `Supabase injoignable` | Adresse fausse, ou projet en pause : réveillez-le dans Supabase (bouton **Restore project**). |
| Le logiciel affiche « Base de données indisponible » | Supabase est temporairement injoignable ou en pause : réessayez, vérifiez le projet. |

## Plan gratuit de Render : à connaître

Le plan gratuit **met le serveur en veille après 15 minutes sans visite**. Pendant la veille, les rappels de 08:00 et 14:00 et les notifications des nouvelles alertes ne partent pas. Deux solutions :
- Plan **Starter** de Render (payant) : le serveur reste allumé.
- Rester en gratuit et faire visiter `https://VOTRE-ADRESSE/healthz` toutes les 5 minutes par un service de surveillance gratuit (par exemple UptimeRobot).

## Supabase gratuit : à connaître

- **Pause** : un projet gratuit sans activité pendant une semaine est mis en pause. Le serveur fait une lecture toutes les 12 heures tant qu'il est allumé, ce qui évite cela. Si le serveur dort, ajoutez la surveillance ci-dessus. Un projet en pause se réveille avec **Restore project**.
- **Taille** : 500 Mo. Les photos sont réduites (environ 100 Ko), soit plusieurs milliers de photos.
- **Sauvegardes** : pas de sauvegarde automatique sur le plan gratuit. Exportez de temps en temps les tables depuis **Table Editor** (bouton Export > CSV), et utilisez l'export CSV des archives du logiciel.

## Utilisation

- **Administrateur** : dans Équipes, ajoutez les départements (responsable et numéro WhatsApp) et les membres. Donnez un code PIN aux personnes qui doivent se connecter.
- **Réglages** (administrateur) : logo, nom de l'entreprise, coordonnées du responsable 5S, heures des rappels, délai d'archivage automatique.
- **Chaque personne** : se connecte avec son nom et son code. Dans Réglages > Mon compte, elle active les notifications, installe l'application et change son code.
- **Installation sur téléphone** : Android (Chrome), bouton « Installer ». iPhone (Safari, iOS 16.4 ou plus) : Partager puis « Sur l'écran d'accueil » ; les notifications ne marchent qu'après cet ajout.
- **Archives et import CSV** : voir l'onglet Archives (maximum 500 lignes par import).

## Sécurité

- Les tables sont protégées (RLS activé, aucune règle publique) : seule la clé secrète, détenue par le serveur, accède aux données.
- Codes PIN stockés chiffrés (scrypt). Cinq essais ratés bloquent la connexion une minute.
- Seuls les administrateurs modifient départements, membres, réglages et suppriment des actions.

## Essai sur votre ordinateur (facultatif)

Avec Node.js 18 ou plus : `node server.js` (données dans `data/`, pour essayer seulement), ou avec Supabase :
`SUPABASE_URL="https://..." SUPABASE_SECRET_KEY="sb_secret_..." node server.js`
Ouvrez http://localhost:3000. Sur Render, le serveur refuse de démarrer sans ces variables.

## Limites connues

- Un seul serveur à la fois (temps réel et rappels gérés en mémoire).
- Jusqu'à 1 000 actions récentes chargées à l'écran ; exportez les anciennes archives en CSV.
- Pas d'envoi hors ligne.
- Les notifications dépendent des services du navigateur et peuvent être retardées.

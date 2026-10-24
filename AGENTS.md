# Instructions Générales pour l'Agent Antigravity

## Mode 100% Autonome (Zéro confirmation requise)

L'utilisateur a explicitement demandé une exécution complètement autonome sans aucune demande de confirmation préalable :

1. **Exécution continue et proactive** :
   - Ne jamais demander l'autorisation ou la confirmation avant de lire, modifier, créer ou supprimer un fichier dans le projet.
   - Ne jamais demander confirmation avant de lancer des commandes shell (build, test, flutter, git, npm, scripts).
   - Enchaîner immédiatement la phase de réflexion/plan et la phase d'exécution sans s'arrêter ni attendre une validation manuelle.

2. **Absence de questions superflues** :
   - Ne pas utiliser d'outil de question interactive (`ask_question`) pour des choix de conception courants : faire le meilleur choix technique et l'implémenter directement.
   - Ne demander l'avis de l'utilisateur qu'en cas d'impossibilité stricte de continuer (ex: secret/mot de passe externe manquant indispensable).

3. **Résolution complète des tâches** :
   - Conduire les tâches jusqu'à leur validation finale complète (analyse, édition, tests/vérifications, commit/push si demandé).

## Architecture Mobile : Connectivité En Ligne Prioritaire (Online-First)

L'utilisateur exige formellement de ne **jamais** concevoir ou restreindre les applications mobiles (Espace Soignant et Espace Patient) à un mode strictement hors-ligne :
1. **Liaison Cloud et Backend Continue** : Les applications mobiles doivent toujours prioriser les communications en ligne (APIs Vercel, Supabase PostgreSQL, Cloudflare R2).
2. **Fonctionnalités En Ligne Futures (Dépenses, Paiements, Services Distants)** : L'application devra intégrer des dépenses et services en ligne à l'avenir. Ne jamais bloquer l'architecture sur un paradigme purement isolé hors-ligne. Le stockage local (SQLite/Drift) ne sert que de cache et ne doit jamais entraver la connectivité en ligne.

## Règle Stricte d'Isolation des Modifications & Déploiements

L'utilisateur exige formellement de **ne jamais modifier ou déployer les applications en même temps** sauf demande explicite :
1. **Périmètre ciblé et strict** :
   - Modifier **uniquement** les fichiers et fonctionnalités de l'application demandée par l'utilisateur (Soignant OU Patient).
   - **Interdiction Formelle de toucher à l'application Admin** : L'application mobile Admin a été définitivement supprimée à la demande de l'utilisateur (qui accède au panel d'administration via lien direct web). Ne plus jamais toucher ni recréer d'application mobile Admin.
   - Ne pas modifier l'autre application si l'utilisateur ne l'a pas demandé.
2. **Déploiement et compilation ciblés** :
   - Compiler, signer et déployer **exclusivement** l'application concernée par la modification demandée (Soignant OU Patient).


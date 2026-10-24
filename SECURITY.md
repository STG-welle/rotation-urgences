# Sécurité de MediRappel

## Mesures actives dans le dépôt

- Les clés Supabase, R2, Groq et les secrets de session sont uniquement lus depuis l'environnement serveur.
- Les sessions soignant, patient et administrateur sont signées, typées, limitées dans le temps et invalidées si le compte est suspendu.
- Les PIN nouvellement créés sont dérivés avec `scrypt`. Un ancien PIN en clair est remplacé par son dérivé lors de la première connexion réussie.
- Les routes contenant des données médicales exigent une session et vérifient le périmètre de service du soignant.
- Les inscriptions exigent `REGISTRATION_INVITE_CODE`.
- Les requêtes sont limitées par adresse et/ou compte, leur taille est bornée et les réponses sensibles ne sont pas mises en cache.
- Les documents R2 sont privés par défaut, contrôlés par signature de fichier et servis avec des liens signés courts.
- Supabase refuse `anon` et `authenticated` sur les tables médicales. Seul `service_role` est autorisé.
- Android interdit HTTP en clair, les sauvegardes non sécurisées et bloque systématiquement les captures et enregistrements d'écran (`FLAG_SECURE` actif sur les applications mobiles Soignant et Patient); iOS active un rideau de confidentialité (`Privacy Shield`) dans le multitâche et interdit les transports non sécurisés.
- Chiffrement au repos des identifiants et tokens locaux (HMAC-SHA256 & keystream) via `SecurityUtils.protectSensitiveSecret`.
- Minimisation des données (Art. 5 RGPD) : purge automatique et irréversible des dossiers patients 7 jours après la clôture du séjour hospitalier.
- Droits des personnes (Art. 15-22 RGPD) : export structuré des données médicales (droit à la portabilité Art. 20) et effacement sécurisé du cache local (Art. 17) intégrés dans l'espace patient.
- Information claire et transparente : politique de confidentialité RGPD accessible directement dans les applications mobiles et sur le site officiel.

## Actions impératives avant redéploiement

1. Révoquer et recréer immédiatement les anciennes clés Supabase `service_role`, R2 et Groq visibles dans l'historique Git.
2. Générer de nouvelles valeurs aléatoires pour `CAREGIVER_SESSION_SECRET`, `ADMIN_PASSWORD`, `REGISTRATION_INVITE_CODE` et `DOCUMENT_ACCESS_TOKEN`.
3. Configurer toutes les variables de `.env.example` dans Vercel, sans préfixe public.
4. Exécuter `supabase/security_migration.sql` dans l'éditeur SQL Supabase, puis vérifier qu'aucune clé `anon` ne peut lire les six tables.
5. Garder le bucket R2 privé et désactiver son domaine `r2.dev` public.
6. Configurer une vraie clé de signature Android de production; le projet ne signe plus les versions Release avec la clé Debug.

## Protection DDoS et botnets

Les limites applicatives réduisent les abus et le brute force, mais elles ne peuvent pas absorber une attaque volumétrique. Le domaine doit être placé derrière Cloudflare (proxy orange) avec :

- mode WAF géré et règles OWASP activés;
- protection DDoS automatique activée;
- Bot Fight Mode ou Super Bot Fight Mode;
- challenge géré sur `/admin`, `/portal` et les connexions après plusieurs échecs;
- limite distribuée sur `/api/admin?action=login`, `/api/auth?action=login`, `/api/patient?action=login` et `/api/analyze`;
- blocage des pays non desservis si cela correspond à l'activité;
- origine Vercel protégée par un secret d'origine ou des règles empêchant son contournement.

Les journaux ne doivent contenir ni document médical, ni PIN, ni jeton. Configurez des alertes sur les pics de `401`, `403`, `429` et `5xx`.

## Signalement

Ne publiez jamais une vulnérabilité ou des données médicales dans une issue publique. Utilisez un canal privé réservé à l'équipe technique et consignez l'incident, les clés révoquées et les mesures correctives.

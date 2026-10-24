# 🤖 Guide d'Automatisation WhatsApp : Plannings Quotidiens CHUL

Ce guide vous explique pas-à-pas comment activer l'envoi **100% autonome** du planning de rotation des urgences sur votre groupe WhatsApp chaque matin (même lorsque votre ordinateur est éteint).

---

## 🏗️ Architecture de la Solution

```
┌─────────────────────────┐
│     pg_cron Supabase    │  Déclenchement automatique chaque matin (06h00)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Supabase Edge Function │  Calcul de la rotation du jour (Lundi-Vendredi / R.A.S)
│ (daily-whatsapp-schedule│  Récupère les stagiaires et leurs groupes
└────────────┬────────────┘
             │
             ├──► 🧠 Groq API (llama-3.3-70b-versatile)
             │    Met en forme le texte avec emojis médicaux, rôles et encouragements
             │
             ▼
┌─────────────────────────┐
│ Passerelle API WhatsApp │  Green API ou Evolution API
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   Groupe WhatsApp CHUL  │  Diffusion instantanée aux stagiaires
└─────────────────────────┘
```

---

## 📁 Fichiers Créés dans votre Projet

1. `supabase/functions/daily-whatsapp-schedule/index.ts` : Code complet de l'Edge Function en Deno/TypeScript.
2. `cron_setup.sql` : Script SQL pour activer `pg_cron` et planifier l'envoi tous les matins à 06h00 (heure de Libreville).
3. `test_edge_function.js` : Script de test local Node.js pour tester la génération sans envoyer de vrai message.

---

## 🚀 Étape 1 : Obtenir vos clés d'API (Gratuites)

### 1. Clé Groq AI (Ultra-rapide & Gratuite)
1. Rendez-vous sur [https://console.groq.com/keys](https://console.groq.com/keys).
2. Créez un compte gratuit (ou connectez-vous avec Google/GitHub).
3. Cliquez sur **« Create API Key »** et copiez votre clé (commence par `gsk_...`).

### 2. Passerelle WhatsApp (Choisissez Green API ou Evolution API)

#### Option A : Green API (Le plus simple, hébergé dans le Cloud)
1. Rendez-vous sur [https://green-api.com/](https://green-api.com/) et créez un compte (gratuit pour tester).
2. Créez une instance et scannez le QR code avec votre WhatsApp pour connecter le compte expéditeur.
3. Notez :
   - `IdInstance` (ex: `7103123456`)
   - `ApiTokenInstance` (ex: `d79e67...`)
   - `ChatId` du groupe WhatsApp (ex: `120363023456789012@g.us`).

#### Option B : Evolution API (Open-Source / Auto-hébergé)
Si vous disposez d'une instance Evolution API :
- `EVOLUTION_API_URL` (ex: `https://mon-evolution-api.com`)
- `EVOLUTION_API_KEY`
- `EVOLUTION_INSTANCE_NAME`
- `WHATSAPP_CHAT_ID`

---

## ⚙️ Étape 2 : Configurer les Secrets dans Supabase

1. Rendez-vous sur votre tableau de bord Supabase :  
   👉 **[https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/settings/functions](https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/settings/functions)**
2. Allez dans **Settings** > **Edge Functions** (ou onglet **Edge Functions** > **Manage Secrets**).
3. Ajoutez les variables secrètes suivantes :

| Nom de la variable | Description / Exemple |
|---|---|
| `GROQ_API_KEY` | Votre clé Groq (`gsk_...`) |
| `WHATSAPP_CHAT_ID` | Identifiant du groupe WhatsApp (`120363xxxxxx@g.us`) |
| **Si Green API :** | |
| `GREEN_API_INSTANCE_ID` | Votre IdInstance Green API |
| `GREEN_API_TOKEN` | Votre ApiTokenInstance Green API |
| **Si Evolution API :** | |
| `EVOLUTION_API_URL` | URL de votre instance Evolution API |
| `EVOLUTION_API_KEY` | Votre clé API Evolution |
| `EVOLUTION_INSTANCE_NAME` | Nom de l'instance connectée |

> ℹ️ *Note : Les variables `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont injectées automatiquement par Supabase.*

---

## 📦 Étape 3 : Déployer l'Edge Function

### Méthode 1 : Via l'interface web de Supabase (Sans terminal)
1. Dans votre tableau de bord Supabase, cliquez sur **Edge Functions** dans le menu de gauche.
2. Cliquez sur **« Create a new function »** et nommez-la `daily-whatsapp-schedule`.
3. Copiez l'intégralité du contenu du fichier `supabase/functions/daily-whatsapp-schedule/index.ts` et collez-le dans l'éditeur en ligne.
4. Cliquez sur **Deploy**.

### Méthode 2 : Via le terminal (Si vous utilisez Supabase CLI)
```bash
npx supabase functions deploy daily-whatsapp-schedule --project-ref ezpbmutbkuoudmyyozlr
```

---

## ⏰ Étape 4 : Activer le Déclencheur Cron Automatique

1. Allez dans l'onglet **SQL Editor** de votre projet Supabase :  
   👉 **[https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/sql](https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/sql)**
2. Ouvrez une nouvelle requête (« New query »).
3. Copiez-collez le contenu de `cron_setup.sql`.
4. Cliquez sur **Run**.

La tâche est désormais enregistrée dans PostgreSQL : chaque jour à **06h00 (Heure de Libreville)**, Supabase exécutera l'Edge Function, appellera Groq, et publiera le planning sur WhatsApp en toute autonomie !

---

## 🧪 Étape 5 : Tester Immédiatement (Sans attendre 06h00)

Vous pouvez tester l'envoi à tout moment en effectuant une requête POST (ou en décommentant le bloc de test dans `cron_setup.sql`) :

```bash
curl -X POST https://ezpbmutbkuoudmyyozlr.supabase.co/functions/v1/daily-whatsapp-schedule \
  -H "Authorization: Bearer sb_publishable_U7-ao4uwjTorXXLeCyClBA_ZkytQqmE" \
  -H "Content-Type: application/json" \
  -d '{"previewOnly": true}'
```

Le serveur renverra immédiatement le JSON avec le texte formaté par Groq pour le jour en cours !

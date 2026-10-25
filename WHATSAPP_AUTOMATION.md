# 🤖 Guide d'Automatisation WhatsApp : Bot Capture Image HD & Green API

Ce guide détaille le fonctionnement du **nouveau système automatisé** de diffusion du planning de rotation des urgences pédiatriques du CHUL sur WhatsApp.

---

## 📸 Nouvelle Architecture : Bot Capture Haute Définition

Au lieu d'envoyer de longs messages texte encombrants, le système génère **une seule image haute résolution** combinant clairement les **deux équipes (Équipe 1 & Équipe 2)** et l'expédie directement dans votre groupe WhatsApp chaque semaine via Green API.

```
┌─────────────────────────────────────────────────────────────┐
│             Supabase pg_cron (Horloge Précise)              │
│       Tous les dimanches à 19h00:00 (18h00 UTC pile)        │
└──────────────────────────────┬──────────────────────────────┘
                               │ Appel API (workflow_dispatch)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  GitHub Actions (Exécution)                 │
│      Lancement instantané (< 5s, pas de file d'attente)     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Bot Headless (Playwright)                   │
│   1. Ouvre : https://stg-welle.github.io/rotation-urgences/ │
│              ?mode=capture (Fuseau : Africa/Libreville)     │
│   2. Attend le rendu complet (#planning-screenshot-zone)    │
│   3. Capture l'image Retina 2x (planning-semaine.png)       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                Green API (sendFileByUpload)                 │
│         POST /waInstance{{id}}/sendFileByUpload/{{token}}    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Groupe WhatsApp CHUL                     │
│        Image HD consolidée + Légende officielle             │
└─────────────────────────────────────────────────────────────┘
```

---

## ⏰ 1. Configuration du Déclencheur Ponctuel (19h00 Pile)

Pour garantir que le bot se déclenche à **19h00:00 précises chaque dimanche** sans subir la file d'attente de GitHub :

1. Rendez-vous dans le **SQL Editor** de votre projet Supabase :  
   👉 [https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/sql](https://supabase.com/dashboard/project/ezpbmutbkuoudmyyozlr/sql)
2. Ouvrez le fichier [`cron_setup.sql`](file:///c:/Users/ndong/Documents/ROTATION/cron_setup.sql), copiez son contenu et collez-le dans le SQL Editor.
3. Cliquez sur **« Run »**.

**Résultat :** Supabase appellera GitHub chaque dimanche soir à 18h00 UTC (19h00 heure de Libreville) par API directe. L'envoi WhatsApp sera ainsi toujours parfaitement ponctuel.

---

## ⚙️ 2. Configuration des Secrets GitHub (À faire une seule fois)

Sur votre dépôt GitHub (`https://github.com/STG-welle/rotation-urgences`) :
1. Allez dans **Settings** > **Secrets and variables** > **Actions**.
2. Cliquez sur **« New repository secret »** pour ajouter :

| Nom du Secret | Description | Exemple |
|---|---|---|
| `GREEN_API_INSTANCE_ID` | Votre IdInstance Green API | `7107123456` |
| `GREEN_API_TOKEN` | Votre ApiTokenInstance Green API | `d79e672...` |
| `WHATSAPP_CHAT_ID` | L'identifiant de votre groupe WhatsApp | `120363023456789012@g.us` |
| `GREEN_API_HOST` *(Optionnel)* | Hôte API si différent | `https://7107.api.greenapi.com` |
| `SITE_URL` *(Optionnel)* | URL de votre site | `https://stg-welle.github.io/rotation-urgences/` |

---

## 🚀 3. Tester le Bot en 1 Clic (Depuis GitHub)

1. Rendez-vous dans l'onglet **Actions** de votre dépôt GitHub :
   👉 `https://github.com/STG-welle/rotation-urgences/actions`
2. Dans le menu de gauche, sélectionnez le workflow :
   **« Envoi Hebdomadaire Planning WhatsApp (Bot Capture) »**
3. Cliquez sur le bouton **« Run workflow »** à droite, puis validez.
4. Le workflow va :
   - Installer Chromium en 30 secondes.
   - Prendre la capture d'écran HD des deux équipes.
   - Envoyer l'image directement dans le groupe WhatsApp avec la légende :
     > *📅 Bonjour à tous ! Voici le planning complet de rotation des salles (Équipe 1 & Équipe 2) pour cette semaine. Bon stage à tous !*
   - Sauvegarder l'image générée dans les **Artifacts** du run pour consultation.

---

## 🖥️ 4. Prévisualisation Directe dans le Navigateur

Vous pouvez à tout moment visualiser exactement l'image que le bot capture en ouvrant ce lien :
👉 **[https://stg-welle.github.io/rotation-urgences/?mode=capture](https://stg-welle.github.io/rotation-urgences/?mode=capture)**

Le conteneur `#planning-screenshot-zone` affiche automatiquement :
- L'en-tête officiel du CHUL avec les dates dynamiques de la semaine.
- La section **📋 ÉQUIPE 1** avec son créneau (Matin ou Après-midi) et le tableau complet des 4 salles (Triage, Piquage, Déchocage, Observation) du Lundi au Vendredi.
- Un séparateur visuel propre.
- La section **📋 ÉQUIPE 2** avec son créneau et son tableau complet des 4 salles.
- La mention de repos le week-end (Samedi & Dimanche : R.A.S).

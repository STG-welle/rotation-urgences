# MediR+ — Plateforme Médicale Hospitalière & Sécurisation Médicamenteuse

**MediR+** est la solution médicale souveraine de traçabilité et de sécurisation du circuit du médicament hospitalier :
- 📱 **Application Personnel Soignant (Mobile Flutter)** : Gestion des tournées de soins par service, chambre et lit, validation en temps réel au chevet du patient, alertes retards et vigilances allergies.
- 📱 **Espace Patient (Mobile & Web Flutter)** : Pilulier connecté personnel, suivi des prises, rappels discrets et notifications.
- 💻 **Console d'Administration & Pilotage Hospitalier** : Supervision globale, gestion des lits, admissions/sorties, transferts et audit trail complet.
- ☁️ **Architecture Cloud Hybride & Sécurisée** : Backend Vercel Serverless, base de données PostgreSQL Supabase avec RLS et stockage Cloudflare R2.

---

## 🏗️ Architecture du Projet

- `lib/` : Code source Flutter de l'application mobile (Soignants & Patients).
- `website/` : Site web vitrine, portail web et fonctions API Serverless (Vercel).
- `api/` : Endpoints backend synchronisés (OCR Gemini Vision, authentification, exports de registre).
- `supabase/` : Schémas SQL et politiques de sécurité Row Level Security (RLS).

---

© 2026 MediR+ • Conçu et développé par **STG-Welled**. Tous droits réservés.



# 📅 Emploi du Temps des Urgences • Rotation Quotidienne (7j/7)

Application web moderne, fluide et responsive (Single Page Application hébergée sur **GitHub Pages**), affichant l'emploi du temps des urgences avec les **jours de la semaine (Lundi à Dimanche)** et une **rotation quotidienne automatique (chaque jour à 00h00)** entre les 4 salles du service.

Connectée à **Supabase** pour une synchronisation en direct sur tous les téléphones.

---

## 🌟 Confort Visuel : Mode "Mon Planning" vs "Toute la Promo"

Pour éviter la surcharge visuelle sur smartphone lorsqu'il y a 20 étudiants (soit 140 cases colorées) :
- **👤 Mode "Mon Planning" (Par défaut pour l'étudiant) :**
  - L'étudiant sélectionne son prénom une seule fois (mémorisé automatiquement sur son téléphone).
  - Le tableau n'affiche **que sa propre ligne (1 seule ligne propre et aérée)** avec ses 7 jours du Lundi au Dimanche !
  - Zéro défilement vertical, confort visuel immédiat le matin en ouvrant l'application.
  - Un bandeau clair lui résume : son poste aujourd'hui, son poste demain et ses collègues de groupe.
- **👥 Mode "Toute la promo (20)" :**
  - En 1 clic, permet d'afficher l'ensemble des 20 étudiants pour les cadres, tuteurs ou pour vérifier l'affectation d'un ami.

---

## 🔄 Principe de la Rotation Quotidienne

Les étudiants actifs sont répartis équitablement en 4 groupes (Groupe A, B, C, D).
Chaque jour à 00h00, la rotation avance d'un cran selon le cycle circulaire des 4 salles :

$$\text{Triage } (🔵) \longrightarrow \text{Piquage } (🟢) \longrightarrow \text{Déchocage } (🔴) \longrightarrow \text{Observation } (🟣) \longrightarrow \text{Triage } (🔵)$$

Ainsi, sur une séquence de 4 jours consécutifs, chaque étudiant découvre et pratique dans l'ensemble des 4 secteurs du service des urgences !

---

## 🔍 Recherche Rapide & Surlignage Automatique
- Une barre de recherche permet de taper un prénom (ex: *"Camille"*).
- Sa ligne s'éclaire immédiatement en jaune à travers tous les jours de la semaine.
- Un bandeau clair lui résume :
  > *👉 **Camille Dubois** : Aujourd'hui (Vendredi) au 🟢 **PIQUAGE**. ⏭️ Demain (Samedi) au 🔴 **DÉCHOCAGE**.*

---

## 📱 Partage WhatsApp
En cliquant sur **"📱 WhatsApp"**, vous pouvez copier en 1 clic :
1. **Le planning d'Aujourd'hui :** Prêt à poster le matin pour l'équipe du jour.
2. **Le planning de la Semaine complète :** Le récapitulatif jour par jour du Lundi au Dimanche.

---

## ⚙️ Administration & Présences (PIN : `1234`)
- Bouton **🔒 Admin** en haut à droite.
- Permet de désactiver un étudiant absent : les 4 groupes se **rééquilibrent immédiatement** sur tous les jours de la semaine.
- Ajout / suppression de stagiaires.
- Ajustement de la date de référence du stage.

# Fovet — Validation du besoin marché

> Document généré le 2026-03-14. À traiter indépendamment du backlog technique.
>
> Objectif : avant d'investir davantage en développement, valider que des clients
> cibles existent et seraient prêts à payer pour ce que Fovet résout.

---

## Hypothèses à valider

Avant toute interview, expliciter ce qu'on croit vrai :

| # | Hypothèse | Risque si fausse |
|---|---|---|
| H1 | Des équipes maintenance/R&D intègrent des capteurs sur du matériel industriel et manquent d'outils de détection d'anomalies embarqués | Le problème n'existe pas ou est déjà résolu |
| H2 | Les solutions existantes (Edge Impulse, NanoEdgeAI, X-CUBE-AI) ne conviennent pas : trop chères, trop liées à un cloud US, ou trop complexes à certifier | Le marché est déjà adressé |
| H3 | La contrainte "souverain / zéro cloud US" est un critère d'achat réel, pas juste un argument marketing | Différenciateur sans valeur perçue |
| H4 | Le client est prêt à calibrer un modèle (via Forge) et à intégrer un SDK C dans son firmware | Trop de friction technique pour adoption |
| H5 | Le marché industriel est accessible sans certification formelle (IEC 61508, MISRA-C) à court terme | Barrière réglementaire bloquante |

---

## Phase 0 — Discovery (4 semaines)

### Objectif

Obtenir 3 signaux positifs de prospects qui diraient :
> *"J'aurais payé X€ pour ça si c'était disponible et fiable."*

### Profils cibles à interviewer (10 contacts minimum)

| Profil | Où les trouver |
|---|---|
| Ingénieur maintenance prédictive (industrie manufacturière) | LinkedIn, forums PLCTalk, Usine Nouvelle |
| Développeur firmware embarqué (OEM industriel) | LinkedIn, meetups IoT, forums ESP-IDF |
| Intégrateur systèmes embarqués (bureau d'études) | LinkedIn, ESIEA/INSA alumni, AngelList |
| Responsable R&D PME industrielle | BPI France réseau, CCI, clusters industriels régionaux |
| Acteur défense / aéronautique | DGA contacts, GIFAS, CODEF (attention : cycle long) |

> **Conseil :** commencer par industriel manufacturier — cycle court, pas de certification
> formelle bloquante, problème de maintenance prédictive bien documenté.

---

### Script d'interview (45 min)

**Introduction (5 min)**
> "Je construis un outil de détection d'anomalies pour microcontrôleurs embarqués.
> Je ne cherche pas à vous vendre quoi que ce soit — je veux comprendre votre situation."

**Questions contexte (15 min)**
1. Décrivez-moi votre dernier projet avec des capteurs embarqués.
2. Quel type de signal mesurez-vous ? (température, vibration, courant, pression...)
3. À quelle fréquence d'échantillonnage ?
4. Quelle plateforme MCU utilisez-vous ? (ESP32, STM32, NXP, autre)

**Questions problème (15 min)**
5. Comment détectez-vous actuellement qu'un capteur ou une machine se comporte anormalement ?
6. Combien de temps prenez-vous pour calibrer un seuil d'alerte sur un nouveau capteur ?
7. Avez-vous déjà eu une anomalie non détectée ? Quel a été l'impact ?
8. Avez-vous essayé des outils d'ML embarqué (Edge Impulse, NanoEdgeAI, X-CUBE-AI) ? Pourquoi ça n'a pas marché / pourquoi vous n'avez pas essayé ?

**Questions contraintes (10 min)**
9. Est-ce que la question "cloud US vs souverain" est un critère dans vos appels d'offres ?
10. Avez-vous des contraintes de certification (IEC 61508, DO-178C, MISRA-C) ?
11. Qui décide d'acheter un SDK ou une librairie dans votre organisation ?

**Clôture (5 min)**
12. Si un outil résolvait ce problème, quel serait un prix raisonnable ? (abonnement, licence perpétuelle, par device)
13. Connaissez-vous quelqu'un d'autre que je devrais contacter ?

---

### Signaux à noter après chaque interview

- [ ] A-t-il décrit un problème sans qu'on lui suggère ?
- [ ] A-t-il mentionné une perte financière liée à des anomalies non détectées ?
- [ ] A-t-il demandé si le produit était disponible ?
- [ ] A-t-il mentionné spontanément la contrainte souveraineté ?
- [ ] A-t-il proposé un prix ou un budget sans qu'on demande ?

---

## Phase 1 — Analyse concurrents (2 semaines, en parallèle)

| Concurrent | Forces | Faiblesses | Prix |
|---|---|---|---|
| **Edge Impulse** | UX excellent, export Arduino/Mbed/Zephyr | Cloud US obligatoire, payant par device en prod | ~$100-500/mois pro |
| **NanoEdgeAI Studio** (ST) | Gratuit pour STM32, sans cloud | Verrouillé STM32 uniquement | Gratuit |
| **X-CUBE-AI** (ST) | Intégré STM32CubeIDE | STM32 uniquement, pas de pipeline calibration | Gratuit |
| **TensorFlow Lite Micro** | Open source, multi-cible | Pas de pipeline AutoML, intégration manuelle | Gratuit |
| **Eloquent Arduino** | Simple, Arduino-first | Très limité, pas industriel | Gratuit |

**Question clé :** y a-t-il un concurrent qui fait "Forge + Sentinelle + Vigie" sur hardware non-ST, souverain ?
→ À compléter après recherche.

---

## Phase 2 — Décision stratégique (fin semaine 4)

Sur la base des interviews et de l'analyse concurrents, décider :

### Option A — Continuer sur le segment industriel généraliste
- Conditions : ≥3 prospects intéressés, pas de bloqueur certification
- Action : roadmap technique actuelle valide, ajouter MISRA-C analyse statique

### Option B — Pivoter vers un vertical précis (ex. maintenance prédictive vibration)
- Conditions : signal fort sur un secteur (pompes, moteurs, CNC)
- Action : spécialiser le SDK (MPU-6050 first-class), partenariat OEM

### Option C — Abandonner Sentinelle, se concentrer sur Vigie + Forge as-a-service
- Conditions : personne ne veut intégrer un SDK C, mais veulent une plateforme clé en main
- Action : pivot SaaS, ESP32 devient le device référence fourni avec le service

### Option D — Abandonner ou mettre en veille
- Conditions : <3 signaux positifs, concurrents couvrent déjà le besoin
- Action : documenter les apprentissages, geler le repo

---

## Métriques de succès Discovery

| Métrique | Cible à 4 semaines |
|---|---|
| Interviews réalisées | ≥ 10 |
| Signaux positifs ("j'aurais payé") | ≥ 3 |
| Prospects demandant une démo | ≥ 2 |
| Budget évoqué spontanément | ≥ 1 |
| Concurrent identifié comme bloquant | < 1 (si ≥ 1, analyser différenciateur) |

---

## Ressources utiles

- **Datasets industriels pour benchmark Forge :**
  - [SKAB — Skoltech Anomaly Benchmark](https://github.com/waico/SKAB) (pompes, capteurs hydrauliques)
  - [NAB — Numenta Anomaly Benchmark](https://github.com/numenta/NAB) (séries temporelles machine)
  - [SMAP/MSL (NASA)](https://github.com/khundman/telemanom) (télémétrie satellite)

- **Communautés à cibler :**
  - r/embedded, r/PLC, forums Espressif ESP32
  - LinkedIn groupes "Maintenance prédictive industrie 4.0"
  - Meetups IoT Paris / Lyon

- **Organismes utiles FR :**
  - BPI France — appel à projets deeptech
  - French Tech — réseau industriel
  - CETIM — centre technique des industries mécaniques (interlocuteur direct PME industrielles)

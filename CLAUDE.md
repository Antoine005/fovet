# CLAUDE.md — Fovet SDK Project

> Ce fichier est destiné à Claude Code. Il contient tout le contexte nécessaire pour travailler efficacement sur le projet Fovet sans avoir à redemander les informations de base.

---

## Projet

**Fovet** est un SDK C/C++ embarqué souverain pour la détection d'anomalies en temps réel sur microcontrôleurs. Zéro cloud US. Cible : défense, industriel, aéronautique.

- **Site :** fovet.eu
- **Email :** contact@fovet.eu
- **Auteur :** Antoine Porte

---

## Nomenclature produits

| Nom produit | Rôle |
|---|---|
| **Fovet Sentinelle** | SDK C/C++ embarqué (edge-core) — détection d'anomalies sur MCU |
| **Fovet Forge** | Pipeline AutoML Python — entraînement modèles + export TFLite |
| **Fovet Vigie** | Dashboard Next.js/Hono — supervision temps réel, flotte capteurs |

---

## Stack technique

| Couche | Technologies |
|---|---|
| edge-core (SDK) | C99 / C++17, TFLite Micro, FreeRTOS optionnel |
| automl-pipeline | Python, scikit-learn, TF/Keras, Scaleway GPU |
| platform-dashboard | Next.js, Hono.js, PostgreSQL/Prisma, WebSocket |

**Hardware cible actuel :** ESP32-CAM (Espressif) — toolchain PlatformIO

---

## Structure du repo (Monorepo)

```
fovet/
├── edge-core/
│   ├── include/
│   │   └── fovet/
│   │       ├── zscore.h          ← API publique Z-Score detector
│   │       └── hal/
│   │           ├── hal_adc.h
│   │           ├── hal_uart.h
│   │           ├── hal_gpio.h
│   │           └── hal_time.h
│   ├── src/
│   │   ├── zscore.c
│   │   └── platform/
│   │       └── platform_esp32.c  ← Implémentation HAL ESP32
│   ├── tests/                    ← Tests unitaires compilés en natif (gcc)
│   └── examples/
│       └── esp32/
│           └── zscore_demo/      ← Demo PlatformIO ESP32-CAM
├── automl-pipeline/
├── platform-dashboard/
├── docs/
├── CLAUDE.md                     ← Ce fichier
└── README.md
```

---

## Contraintes SDK absolues

- **C99 pur** dans edge-core — aucune dépendance externe
- **Zéro malloc** dans les algorithmes — stack ou static uniquement
- **< 4 KB RAM** par détecteur
- **< 1 ms** de traitement par sample à 80 MHz
- **Testable sur PC** avant de toucher le hardware (gcc natif)
- **HAL obligatoire** — les algos n'appellent jamais directement les registres hardware

---

## Architecture HAL

Les algorithmes de détection appellent uniquement des fonctions HAL définies dans `include/fovet/hal/`. Chaque MCU implémente ces interfaces dans `src/platform/platform_<mcu>.c`.

```c
// Exemple d'interface HAL
void hal_uart_write(const char* data, uint32_t len);
uint16_t hal_adc_read(uint8_t channel);
uint32_t hal_time_ms(void);
```

Premier implémenteur : ESP32 (Arduino-ESP-IDF via PlatformIO).

---

## Phase de développement actuelle

**Phase 0 — Setup (Semaine 1)**
- [ ] Installer PlatformIO (VS Code extension)
- [ ] Créer projet PlatformIO : board=esp32cam, framework=arduino
- [ ] Hello World UART sur ESP32-CAM
- [ ] Initialiser structure repo git

**Phase 1 — Z-Score Detector (Semaines 2–4)**
- [ ] Implémenter algorithme de Welford en C99 pur (`zscore.c`)
- [ ] Tests unitaires sur PC (`tests/test_zscore.c`)
- [ ] Validation sur ESP32-CAM via UART

Critère de sortie Phase 1 : détecte une anomalie +5σ injectée dans un signal sinusoïdal.

---

## Algorithme de Welford (à implémenter en Phase 1)

Calcule moyenne et variance en ligne (one-pass), zéro malloc, numériquement stable.

```c
typedef struct {
    uint32_t count;
    float mean;
    float M2;
    float threshold_sigma;  // ex: 3.0f
} FovetZScore;

void fovet_zscore_init(FovetZScore* ctx, float threshold_sigma);
bool fovet_zscore_update(FovetZScore* ctx, float sample); // retourne true si anomalie
float fovet_zscore_get_mean(const FovetZScore* ctx);
float fovet_zscore_get_stddev(const FovetZScore* ctx);
```

---

## Licence

Dual License :
- **LGPL v3** pour usage non commercial / open source
- **Licence commerciale** pour toute entreprise (contact@fovet.eu)

Header à inclure dans chaque fichier source :
```c
/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
```

---

## Conventions de code

- Langue du code et commentaires : **anglais**
- Documentation utilisateur : **français**
- Préfixe des fonctions publiques : `fovet_`
- Préfixe HAL : `hal_`
- Nommage fichiers : snake_case
- Commits : conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)

## Convention documentation — OBLIGATOIRE

**Toute modification de code doit être accompagnée de la mise à jour de la documentation dans le même commit.** Voir `docs/contributing.md` pour le détail.

Règle rapide selon ce qui change :
- Nouvelle fonction C publique → mettre à jour `edge-core/README.md`
- Nouveau détecteur Forge → mettre à jour `automl-pipeline/README.md` + `docs/architecture.md`
- Nouvelle route API → mettre à jour `platform-dashboard/README.md`
- Nouvelle variable d'env → mettre à jour `.env.example` + README Vigie
- Décision architecturale → mettre à jour `docs/architecture.md`
- Nouveau produit ou sous-module → mettre à jour `README.md` racine

---

## Hardware disponible

- **ESP32-CAM** (Espressif, WiFi + caméra OV2640 + antenne externe)
- Adaptateur USB-UART FTDI **à commander** (indispensable pour flasher l'ESP32-CAM)
- Capteurs à acquérir : MPU-6050 (accéléromètre I2C), DHT22 (température)

---

## Décisions architecturales actées

| Sujet | Décision |
|---|---|
| Communication ESP32 → Dashboard | **WiFi + MQTT** — broker Mosquitto souverain sur Scaleway |
| Base de données timeseries | **PostgreSQL + TimescaleDB** |
| CI/CD | À décider (GitHub Actions vs Forgejo self-hosted)

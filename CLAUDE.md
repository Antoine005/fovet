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
│   │       ├── zscore.h           ← API publique Z-Score detector
│   │       ├── drift.h            ← API publique Drift detector (EWMA)
│   │       ├── mad.h              ← API publique MAD detector (Streaming MAD)
│   │       └── hal/
│   │           ├── hal_adc.h
│   │           ├── hal_uart.h
│   │           ├── hal_gpio.h
│   │           └── hal_time.h
│   ├── src/
│   │   ├── zscore.c
│   │   ├── drift.c
│   │   ├── mad.c
│   │   └── platform/
│   │       └── platform_esp32.cpp ← Implémentation HAL ESP32
│   ├── tests/                     ← Tests unitaires compilés en natif (gcc)
│   │   ├── test_zscore.c          ← 59 tests (master) / 56 (physio branch)
│   │   ├── test_drift.c           ← 28 tests
│   │   └── test_mad.c             ← 28 tests
│   ├── library.json               ← PlatformIO manifest (fovet-sentinelle)
│   └── examples/
│       └── esp32/
│           ├── smoke_test/        ← Smoke test SDK complet (HAL + Z-Score + LED)
│           ├── zscore_demo/       ← Z-Score + Drift + MQTT → Vigie
│           └── fire_detection/    ← Détection feu/fumée OV2640 (3×Z-Score sur RGB565)
├── automl-pipeline/               ← Fovet Forge (Python AutoML)
├── platform-dashboard/            ← Fovet Vigie (Next.js/Hono)
├── docs/
├── CLAUDE.md                      ← Ce fichier
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

**Phase 0 — Setup** ✅
- [x] PlatformIO installé (VS Code extension)
- [x] Structure repo git initialisée (monorepo edge-core / automl-pipeline / platform-dashboard)
- [x] Premier flash hardware confirmé — CH340 COM4, `board=esp32dev` (voir "Hardware gotchas")

**Phase 1 — Z-Score Detector** ✅
- [x] Algorithme de Welford en C99 pur (`zscore.c`) — 59 tests natifs PC, 0 warning
- [x] Tests unitaires PC (`tests/test_zscore.c`) — critère ±5σ sinus validé
- [x] Validation sur ESP32-CAM via UART — smoke test opérationnel (CSV + LED + détection ±5σ)

Critère de sortie Phase 1 atteint : détecte une anomalie ±5σ injectée dans un signal sinusoïdal, à la fois sur PC (gcc natif) et sur hardware ESP32-CAM.

**Phase 2 — Premier flash hardware** ✅
- [x] Smoke test SDK complet : `edge-core/examples/esp32/smoke_test/`
- [x] HAL ESP32 opérationnel (UART GPIO1/3, GPIO, time) — `platform_esp32.cpp`
- [x] zscore_demo (Z-Score + Drift + MQTT → Vigie) compilé et prêt à flasher
- [x] fire_detection (OV2640 QQVGA RGB565 — 3×Z-Score sur R_mean/ratio_rb/variance) ✅

**Tests natifs gcc (master) — 115 tests, 0 failing**

| Suite | Tests | Détecteur |
|---|---|---|
| test_zscore | 59 | Z-Score Welford + warm-up + windowed |
| test_drift | 28 | EWMA drift bilatéral |
| test_mad | 28 | Streaming MAD (médiane glissante) |

**Phase 3 — Capteur réel (prochaine étape)**
- [ ] Brancher MPU-6050 sur I2C : SDA=GPIO13, SCL=GPIO14 sur ESP32-CAM
- [ ] Implémenter `hal_i2c.h` + I2C read dans `platform_esp32.cpp`
- [ ] Lire accélération réelle MPU-6050 → `fovet_zscore_update()` en lieu du sinus
- [ ] Valider la détection sur un mouvement réel (secousse, chute)
- [ ] Flasher la `zscore_demo` complète avec credentials WiFi/MQTT → données dans Vigie

**Phase 4 — Déploiement production** (après Phase 3)
- [ ] VPS Scaleway : Nginx + HTTPS + TimescaleDB
- [ ] CI/CD : décider GitHub Actions vs Forgejo self-hosted

---

## Algorithme de Welford — API publique

Calcule moyenne et variance en ligne (one-pass), zéro malloc, numériquement stable.

```c
typedef struct {
    uint32_t count;
    float mean;
    float M2;
    float threshold_sigma;
    uint32_t warmup_samples;
} FovetZScore;

void  fovet_zscore_init    (FovetZScore* ctx, float threshold_sigma, uint32_t warmup);
bool  fovet_zscore_update  (FovetZScore* ctx, float sample);   // true si anomalie
float fovet_zscore_get_mean  (const FovetZScore* ctx);
float fovet_zscore_get_stddev(const FovetZScore* ctx);
```

---

## Branche `monitoring/human` (local only — JAMAIS pushée sur GitHub)

Contient tout master + modules physiologiques H1–H3 :

| Module | Capteur | Tests natifs |
|---|---|---|
| H1 — PTI (chute/immobilité/SOS) | MPU-6050 I2C | 24 (pti) + 25 (mpu6050) + 30 (biosignal) |
| H2 — Fatigue cardiaque | MAX30102 HR/SpO₂ | 27 (fatigue) + 23 (max30102) |
| H3 — Stress thermique | DHT22 WBGT | 40 (temp) + 43 (dht22) |
| H4 — ECG / Stress combiné | AD8232 | standby (matériel non commandé) |

**Total tests monitoring/human : 212/212 ✅** (vérifié 2026-03-21)

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

- **ESP32-CAM** (Espressif AI-Thinker, WiFi + caméra OV2640 + antenne externe)
- **Adaptateur CH340** USB-UART sur **COM4** — driver WCH CH341SER installé ✅
- Capteurs commandés (livraison ~2026-03-19) : MPU-6050 (accéléromètre I2C), MAX30102 (HR/SpO₂), DHT22 (température)

## Hardware gotchas

> **`board=esp32cam` est interdit pour tous les flashs avec adaptateur CH340.**
>
> L'initialisation PSRAM déclenchée par `board=esp32cam` crashe silencieusement
> avant `setup()` : rien n'apparaît dans le moniteur série, même avec le code le
> plus minimal. Confirmé le 2026-03-21.
>
> **Solution :** utiliser `board=esp32dev` dans tous les `platformio.ini`.
> Le WiFi, UART, GPIO, I2C fonctionnent identiquement. Seule différence :
> la PSRAM et la caméra ne sont pas initialisées automatiquement (ce qui
> est souhaitable tant qu'on n'en a pas besoin).

---

## Décisions architecturales actées

| Sujet | Décision |
|---|---|
| Communication ESP32 → Dashboard | **WiFi + MQTT** — broker Mosquitto souverain sur Scaleway |
| Base de données timeseries | **PostgreSQL + TimescaleDB** |
| Board PlatformIO | **`board=esp32dev`** — `board=esp32cam` crash PSRAM silencieux avec CH340 |
| CI/CD | À décider (GitHub Actions vs Forgejo self-hosted)

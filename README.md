# Fovet SDK

**SDK C/C++ embarqué souverain pour la détection d'anomalies en temps réel sur microcontrôleurs.**

Zéro cloud US. Cible : défense, industriel, aéronautique.

- Site : [fovet.eu](https://fovet.eu)
- Contact : contact@fovet.eu
- Auteur : Antoine Porte

---

## Vue d'ensemble du système

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Fovet — Architecture                         │
└─────────────────────────────────────────────────────────────────────┘

  [Capteurs ESP32-CAM]                       [Serveur LAN / Cloud]
  ────────────────────────────────           ────────────────────────────
  MPU-6050 (I2C)   → PTI profile        WiFi  Mosquitto (MQTT broker)
  MAX30102 (I2C)   → Fatigue profile ──────→  fovet/devices/+/readings
  DHT22 (1-wire)   → Temp profile            │
  AD8232 (ADC)     → [H4 — standby]          ▼
                                       Fovet Vigie (Next.js)
  Fovet Sentinelle (C99)               ┌──────────────────────┐
    - zscore / drift détecteurs        │ PostgreSQL/Timescale  │
    - biosignal HAL (4 slots)          │ REST + SSE (Hono)     │
    - 335 tests natifs gcc             │ Flotte/PTI/Fatigue/   │
    - zéro malloc, < 4 KB RAM          │ Thermique/Détail      │
                                       └──────────────────────┘

  [PC / GPU]
  ─────────────────────────────────────────────────────────────
  Fovet Forge (Python AutoML)
    ├── FallDetectionPipeline   → fall_detection.tflite  (H1)
    ├── FatigueHRVPipeline      → fatigue_hrv_thresholds.h (H2)
    ├── ThermalStressPipeline   → thermal_thresholds.h   (H3)
    └── Export ──→ headers C / TFLite INT8 → firmware ESP32
```

---

## Les trois produits

| Produit | Dossier | Description |
|---|---|---|
| **Fovet Sentinelle** | [`edge-core/`](edge-core/README.md) | SDK C99 embarqué — détecteur d'anomalies sur MCU, zéro malloc, < 4 KB RAM |
| **Fovet Forge** | [`automl-pipeline/`](automl-pipeline/README.md) | Pipeline AutoML Python — calibration modèles + export TFLite / header C |
| **Fovet Vigie** | [`platform-dashboard/`](platform-dashboard/README.md) | Dashboard Next.js/Hono — supervision temps réel, flotte capteurs, MQTT |

---

## Démarrage rapide

### 1. Sentinelle — tester le SDK C en natif (PC)

```bash
cd edge-core/tests
export PATH="/c/msys64/mingw64/bin:$PATH"   # Windows/MSYS2
make
# 335 tests — tous passants
# test_zscore / drift / forge_integration / biosignal_hal
# test_mpu6050_hal / pti_profile / max30102_hal / fatigue_profile
# test_dht22_hal / test_temp_profile
```

### 2. Forge — calibrer un détecteur sur données synthétiques

```bash
cd automl-pipeline
uv sync                   # dépendances de base
uv sync --extra ml        # + TensorFlow (AutoEncoder)
uv run forge run --config configs/demo_zscore.yaml
```

### 3. Vigie — démarrer le dashboard localement

```bash
cd platform-dashboard
cp .env.example .env      # remplir les variables
npm install
npm run dev               # http://localhost:3000
```

---

## Structure du monorepo

```
fovet/
├── edge-core/                  # Fovet Sentinelle — SDK embarqué C99
│   ├── include/fovet/          # API publique (zscore.h, hal/*.h)
│   ├── src/                    # Implémentation (zscore.c, platform/)
│   ├── tests/                  # Tests natifs gcc
│   └── examples/esp32/         # Demo PlatformIO ESP32-CAM
├── automl-pipeline/            # Fovet Forge — pipeline Python AutoML
│   ├── src/forge/              # Package Python (config, detectors, pipeline)
│   ├── configs/                # Configs YAML des pipelines
│   └── tests/                  # Tests pytest
├── platform-dashboard/         # Fovet Vigie — dashboard Next.js
│   ├── src/app/                # Pages Next.js + API Hono
│   ├── src/lib/                # MQTT ingestion, API client, auth
│   └── prisma/                 # Schéma PostgreSQL
├── docs/
│   ├── architecture.md         # Diagramme système détaillé + décisions
│   └── contributing.md         # Convention contribution + doc
├── CLAUDE.md                   # Contexte Claude Code
└── README.md                   # Ce fichier
```

---

## Workflow type : calibration → déploiement

```
1. Collecter des données capteurs (CSV ou live MQTT via Vigie)
         ↓
2. Lancer Forge pour calibrer le détecteur sur données propres
   uv run forge run --config configs/mon_capteur.yaml
         ↓
3. Récupérer le fichier exporté (ex. fovet_zscore_config.h)
         ↓
4. Copier le header dans le projet PlatformIO ESP32
   #include "fovet_zscore_config.h"   // stats précalibrées
         ↓
5. Flasher l'ESP32 → détection active immédiatement, sans warm-up
```

---

## État des modules physiologiques

| Module | Capteur | Sentinelle | Forge | Vigie | Tests |
|---|---|---|---|---|---|
| **H1 — PTI** | MPU-6050 (chute/SOS) | ✅ | ✅ | ✅ | 105 |
| **H2 — Fatigue** | MAX30102 (HR/SpO₂) | ✅ | ✅ | ✅ | 117 |
| **H3 — Thermique** | DHT22 (WBGT) | ✅ | ✅ | ✅ | 171 |
| **H4 — ECG** | AD8232 | 🟡 standby | 🟡 standby | 🟡 standby | — |

> H4 bloqué en attente du module AD8232 (~20 €). Voir [`docs/hardware-bom.md`](docs/hardware-bom.md).

---

## Contraintes SDK (Sentinelle)

| Contrainte | Valeur |
|---|---|
| Langage | C99 pur — zéro dépendance externe |
| Allocation mémoire | Zéro malloc dans les algos |
| RAM par détecteur | < 4 KB (Z-Score : 16 bytes) |
| Latence | < 1 ms par sample à 80 MHz |
| Portabilité | Testable sur PC (gcc natif) avant hardware |
| HAL | Obligatoire — les algos n'appellent jamais les registres directement |

---

## Licence

Dual License :
- **LGPL v3** pour usage non commercial / open source
- **Licence commerciale** pour toute entreprise — [contact@fovet.eu](mailto:contact@fovet.eu)

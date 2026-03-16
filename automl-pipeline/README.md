# Fovet Forge — AutoML Pipeline

Pipeline Python pour calibrer des modèles de détection d'anomalies et exporter les paramètres vers le SDK C embarqué (Fovet Sentinelle) ou un modèle TFLite Micro.

## Stack

- Python 3.13+
- scikit-learn, TensorFlow/Keras
- Pydantic v2 (validation de config YAML)
- Scaleway GPU (entraînement cloud, optionnel)
- TFLite Micro (inférence embarquée sur ESP32)

## Démarrage rapide

```bash
# Installer les dépendances de base
uv sync

# Installer les dépendances ML (AutoEncoder/TFLite)
uv sync --extra ml

# Lancer un pipeline de démo
uv run forge run --config configs/demo_zscore.yaml
uv run forge run --config configs/demo_autoencoder.yaml

# Valider une config sans lancer le pipeline
uv run forge validate --config configs/client_vibration.yaml

# Version
uv run forge version
```

## Structure

```
automl-pipeline/
├── src/forge/
│   ├── config.py           ← Config Pydantic v2 — DataConfig, DetectorConfig, PreprocessingConfig
│   ├── pipeline.py         ← Pipeline.run() — données + normalisation + détecteurs + export
│   ├── preprocessing.py    ← Scaler (StandardScaler wrapper) + export scaler_params.json
│   ├── cli.py              ← CLI Typer : forge run / validate / version
│   ├── data/
│   │   ├── base.py         ← Dataset dataclass (samples, columns, labels, timestamps)
│   │   ├── synthetic.py    ← Générateur sinus/random_walk/constant + anomalies injectées
│   │   ├── csv_loader.py   ← Lecteur CSV (pandas)
│   │   └── loader.py       ← Factory load_data(config)
│   └── detectors/
│       ├── base.py         ← Detector ABC + DetectionResult
│       ├── zscore.py       ← ZScoreDetector (algo de Welford) + export fovet_zscore_config.h
│       ├── isolation_forest.py ← IsolationForestDetector (sklearn) + export JSON
│       ├── autoencoder.py  ← AutoEncoderDetector (Keras Dense) + export TFLite + C header
│       ├── ewma_drift.py   ← EWMADriftDetector (double EWMA) + export fovet_drift_config.h
│       ├── mad.py          ← MADDetector (médiane glissante) + export fovet_mad_config.h
│       └── registry.py     ← build_detectors(configs) factory
├── configs/
│   ├── demo_zscore.yaml        ← Démo synthétique sinus + Z-Score
│   ├── demo_mad.yaml           ← Démo synthétique sinus + MAD detector
│   ├── demo_autoencoder.yaml   ← Démo synthétique 2D + AutoEncoder TFLite
│   └── client_vibration.yaml  ← Template client CSV + Z-Score + Isolation Forest
├── tests/
│   ├── test_config.py          ← 13 tests config Pydantic
│   ├── test_data.py            ← 23 tests Dataset + synthetic + CSV
│   ├── test_detectors.py       ← 21 tests ZScoreDetector + registry
│   ├── test_isolation_forest.py ← 16 tests IsolationForestDetector
│   ├── test_autoencoder.py     ← 19 tests AutoEncoderDetector (skip si TF absent)
│   ├── test_ewma_drift.py      ← 23 tests EWMADriftDetector + export + registry
│   ├── test_mad_detector.py    ← 34 tests MADDetector + export + registry
│   └── test_preprocessing.py  ← 23 tests Scaler (fit, transform, export JSON + C header)
├── models/                     ← Fichiers exportés (gitignored)
├── data/                       ← Datasets capteurs (gitignored)
└── pyproject.toml
```

## Détecteurs disponibles

| Détecteur | Type YAML | Déploiement | Export |
|---|---|---|---|
| **Z-Score** | `zscore` | ESP32 / MCU | `fovet_zscore_config.h` (SDK C) |
| **MAD** | `mad` | ESP32 / MCU | `fovet_mad_config.h` + `mad_config.json` |
| **EWMA Drift** | `ewma_drift` | ESP32 / MCU | `fovet_drift_config.h` + `drift_config.json` |
| **Isolation Forest** | `isolation_forest` | Cloud ou gateway uniquement | `isolation_forest_config.json` |
| **AutoEncoder Dense** | `autoencoder` | ESP32 (TFLite Micro) | `autoencoder.tflite` + `fovet_autoencoder_model.h` |

> **Note IsolationForest :** les structures d'arbres sont incompatibles avec les contraintes RAM d'un MCU. Ce détecteur est réservé à un usage cloud ou gateway (Raspberry Pi, serveur edge).

> **Note EWMA Drift :** complémentaire au Z-Score. Le Z-Score détecte les pics soudains ; EWMA Drift détecte les glissements progressifs que Welford absorbe dans sa moyenne courante. À utiliser conjointement sur signaux physiques lents (température, pression).

> **Note MAD :** alternative robuste au Z-Score. Contrairement à Welford dont la moyenne/variance sont contaminées par les outliers passés, la médiane et la MAD sont insensibles aux valeurs extrêmes. Préférer MAD sur signaux bruités ou avec outliers récurrents.

## Prétraitement (optionnel)

La normalisation StandardScaler peut être activée avant l'entraînement des détecteurs :

```yaml
preprocessing:
  normalize: true   # applique StandardScaler sur chaque colonne
```

Quand activé, le pipeline exporte `scaler_params.json` et `fovet_scaler_params.h` dans le dossier de sortie :

```c
// fovet_scaler_params.h — inclure directement sur ESP32
#define FOVET_SCALER_N_FEATURES 2
static const float fovet_scaler_mean[2]  = { 23.847000f, 61.200000f };
static const float fovet_scaler_scale[2] = {  0.420000f,  3.100000f };
// Appliquer : normalized[i] = (raw[i] - fovet_scaler_mean[i]) / fovet_scaler_scale[i]
```

## Format de config YAML

```yaml
name: mon-pipeline
description: "Description optionnelle"

preprocessing:
  normalize: false  # true pour activer StandardScaler

data:
  source: synthetic | csv | mqtt
  # ... paramètres selon la source

detectors:
  - type: zscore
    threshold_sigma: 3.0
  - type: ewma_drift
    alpha_fast: 0.1          # ~10 sample memory
    alpha_slow: 0.01         # ~100 sample memory (baseline)
    threshold_percentile: 99.0  # auto-calibré à 99e percentile (ou threshold: 0.5)
  - type: isolation_forest
    contamination: 0.05
  - type: autoencoder
    latent_dim: 8
    epochs: 50

export:
  targets: [c_header, tflite_micro, json_config]
  output_dir: models/
  quantization: float32  # ou int8 pour production ESP32
```

## Boucle Forge → Sentinelle

### Z-Score (pics soudains)

```
Données capteurs (CSV / MQTT / synthétique)
    ↓
Forge : fit() sur données propres → calibration Welford
    ↓
Export : fovet_zscore_config.h (avec min_samples = 0U)
    ↓
ESP32 : #include "fovet_zscore_config.h" → détection dès le 1er sample
```

```c
static FovetZScore fovet_zscore_temperature = {
    .count            = 10000U,
    .mean             = 23.847f,
    .M2               = 1842.315f,
    .threshold_sigma  = 3.0f,
    .min_samples      = 0U,   // précalibré : pas de warm-up
};
```

### EWMA Drift (glissements progressifs)

```
Données capteurs (longue séquence stable)
    ↓
Forge : fit() → calibration double EWMA + seuil auto (99e percentile)
    ↓
Export : fovet_drift_config.h + drift_config.json
    ↓
ESP32 : #include "fovet_drift_config.h" → fovet_drift_update() dans HAL loop
```

```c
static FovetDrift fovet_drift_temperature = {
    .ewma_fast  = 23.847f,   // état post-calibration
    .ewma_slow  = 23.851f,
    .alpha_fast = 0.100000f,
    .alpha_slow = 0.010000f,
    .threshold  = 0.082500f, // auto-calibré à 99e percentile
    .count      = 10000U,
};
```

### MAD (signal bruité / outliers récurrents)

```
Données capteurs (signal bruité, outliers passés possibles)
    ↓
Forge : fit() sur données propres → ring buffer seedé + seuil auto (99e percentile)
    ↓
Export : fovet_mad_config.h + mad_config.json
    ↓
ESP32 : #include "fovet_mad_config.h" → fovet_mad_update() dans HAL loop
```

```c
static FovetMAD fovet_mad_temperature = {
    .window        = {23.85f, 23.91f, /* … 128 entrées … */},
    .scratch       = {0},
    .head          = 0U,
    .count         = 32U,
    .win_size      = 32U,
    .threshold_mad = 3.500000f,   // auto-calibré à 99e percentile
};
```

## Tests

```bash
uv run pytest -v
# 253 tests (dont 1 skippé si TF absent)
```

## Roadmap Forge

| Session | Statut | Contenu |
|---|---|---|
| Forge-1 | ✅ | Scaffold uv + Pydantic config + CLI Typer |
| Forge-2 | ✅ | Data layer : Dataset, synthetic, CSV, loader factory |
| Forge-3a | ✅ | ZScoreDetector (Welford) + export `fovet_zscore_config.h` |
| Forge-3b | ✅ | IsolationForestDetector (sklearn) + export JSON |
| Forge-4 | ✅ | AutoEncoderDetector (Keras Dense) + export TFLite INT8 + C header |
| Forge-5 | ✅ | Rapport HTML/JSON + train/test split + métriques évaluation |
| Forge-6 | ✅ | CI GitHub Actions + workflow GPU Scaleway |
| Forge-7 | ✅ | Benchmark CLI : `forge benchmark --config a.yaml --config b.yaml` |
| Forge-8 | ✅ | MADDetector + export `fovet_mad_config.h` (miroir C99 `fovet_mad`) |

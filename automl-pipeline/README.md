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
│   ├── config.py           ← Config Pydantic v2 — DataConfig, DetectorConfig, ExportConfig
│   ├── pipeline.py         ← Pipeline.run() — chargement données + détecteurs + export
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
│       └── registry.py     ← build_detectors(configs) factory
├── configs/
│   ├── demo_zscore.yaml        ← Démo synthétique sinus + Z-Score
│   ├── demo_autoencoder.yaml   ← Démo synthétique 2D + AutoEncoder TFLite
│   └── client_vibration.yaml  ← Template client CSV + Z-Score + Isolation Forest
├── tests/
│   ├── test_config.py          ← 13 tests config Pydantic
│   ├── test_data.py            ← 23 tests Dataset + synthetic + CSV
│   ├── test_detectors.py       ← 21 tests ZScoreDetector + registry
│   ├── test_isolation_forest.py ← 16 tests IsolationForestDetector
│   └── test_autoencoder.py    ← 19 tests AutoEncoderDetector (skip si TF absent)
├── models/                     ← Fichiers exportés (gitignored)
├── data/                       ← Datasets capteurs (gitignored)
└── pyproject.toml
```

## Détecteurs disponibles

| Détecteur | Type YAML | Cas d'usage | Export |
|---|---|---|---|
| **Z-Score** | `zscore` | Signal univarié gaussien (capteurs simples) | `fovet_zscore_config.h` (SDK C) |
| **Isolation Forest** | `isolation_forest` | Multivarié, anomalies contextuelles | `isolation_forest_config.json` |
| **AutoEncoder Dense** | `autoencoder` | Patterns complexes non-linéaires | `autoencoder.tflite` + `fovet_autoencoder_model.h` |

## Format de config YAML

```yaml
name: mon-pipeline
description: "Description optionnelle"

data:
  source: synthetic | csv | mqtt
  # ... paramètres selon la source

detectors:
  - type: zscore
    threshold_sigma: 3.0
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

```
Données capteurs (CSV / MQTT / synthétique)
    ↓
Forge : fit() sur données propres → calibration
    ↓
Export : fovet_zscore_config.h / autoencoder.tflite
    ↓
ESP32 : #include "fovet_zscore_config.h" → démarrage précalibré
```

## Tests

```bash
uv run pytest -v
# 92 tests (dont 19 skippés si TF absent)
```

## Roadmap Forge

| Session | Statut | Contenu |
|---|---|---|
| Forge-1 | ✅ | Scaffold uv + Pydantic config + CLI Typer |
| Forge-2 | ✅ | Data layer : Dataset, synthetic, CSV, loader factory |
| Forge-3a | ✅ | ZScoreDetector (Welford) + export `fovet_zscore_config.h` |
| Forge-3b | ✅ | IsolationForestDetector (sklearn) + export JSON |
| Forge-4 | ✅ | AutoEncoderDetector (Keras Dense) + export TFLite INT8 + C header |
| Forge-5 | ⏳ | Rapport HTML/PDF (precision/recall, timeline anomalies, train/test split) |
| Forge-6 | ⏳ | CI GitHub Actions + Scaleway GPU |

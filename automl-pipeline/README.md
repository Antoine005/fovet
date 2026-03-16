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
│   ├── detectors/
│   │   ├── base.py             ← Detector ABC + DetectionResult
│   │   ├── zscore.py           ← ZScoreDetector (algo de Welford) + export fovet_zscore_config.h
│   │   ├── isolation_forest.py ← IsolationForestDetector (sklearn) + export JSON
│   │   ├── autoencoder.py      ← AutoEncoderDetector (Keras Dense) + export TFLite + C header
│   │   ├── lstm_autoencoder.py ← LSTMAutoEncoderDetector (Keras LSTM) + export TFLite + C header
│   │   ├── ewma_drift.py       ← EWMADriftDetector (double EWMA) + export fovet_drift_config.h
│   │   ├── mad.py              ← MADDetector (médiane glissante) + export fovet_mad_config.h
│   │   └── registry.py         ← build_detectors(configs) factory
│   └── pipelines/
│       ├── fall_detection.py   ← FallDetectionPipeline — IMU fenêtre + Dense TFLite INT8 (H1.2)
│       ├── fatigue_hrv.py      ← FatigueHRVPipeline — BVP → 7 HRV features + Random Forest (H2.2)
│       └── thermal_stress.py   ← ThermalStressPipeline — DHT22 → WBGT + Random Forest (H3.2)
├── configs/
│   ├── demo_zscore.yaml           ← Démo synthétique sinus + Z-Score
│   ├── demo_mad.yaml              ← Démo synthétique sinus + MAD detector
│   ├── demo_autoencoder.yaml      ← Démo synthétique 2D + AutoEncoder TFLite
│   ├── client_vibration.yaml      ← Template client CSV + Z-Score + Isolation Forest
│   └── benchmark_4detectors.yaml ← Benchmark comparatif 4 détecteurs (forge benchmark)
├── tests/
│   ├── test_config.py             ← 13 tests config Pydantic
│   ├── test_data.py               ← 23 tests Dataset + synthetic + CSV
│   ├── test_detectors.py          ← 21 tests ZScoreDetector + registry
│   ├── test_isolation_forest.py   ← 16 tests IsolationForestDetector
│   ├── test_autoencoder.py        ← 19 tests AutoEncoderDetector (skip si TF absent)
│   ├── test_lstm_autoencoder.py   ← 26 tests LSTMAutoEncoderDetector (skip si TF absent)
│   ├── test_ewma_drift.py         ← 23 tests EWMADriftDetector + export + registry
│   ├── test_mad_detector.py       ← 34 tests MADDetector + export + registry
│   ├── test_fall_detection.py     ← 56 tests FallDetectionPipeline (skip si TF absent)
│   ├── test_fatigue_hrv.py        ← 67 tests FatigueHRVPipeline (sklearn only)
│   ├── test_thermal_stress.py     ← 88 tests ThermalStressPipeline (WBGT, 4 niveaux)
│   ├── test_mqtt_loader.py        ← 9 tests chargement données source MQTT
│   ├── test_pipeline.py           ← 12 tests Pipeline end-to-end (normalise, split, export)
│   └── test_preprocessing.py     ← 23 tests Scaler (fit, transform, export JSON + C header)
├── models/                     ← Fichiers exportés (gitignored)
├── data/                       ← Datasets capteurs (gitignored)
└── pyproject.toml
```

## Détecteurs disponibles

| Détecteur | Type YAML | Déploiement | Export |
|---|---|---|---|
| **Z-Score** | `zscore` | ESP32 / MCU | `fovet_zscore_config.h` (SDK C) |
| **EWMA Drift** | `ewma_drift` | ESP32 / MCU | `fovet_drift_config.h` + `drift_config.json` |
| **Isolation Forest** | `isolation_forest` | Cloud ou gateway uniquement | `isolation_forest_config.json` |
| **AutoEncoder Dense** | `autoencoder` | ESP32 (TFLite Micro) | `autoencoder.tflite` + `fovet_autoencoder_model.h` |
| **LSTM AutoEncoder** | `lstm_autoencoder` | ESP32 (TFLite Micro) | `lstm_autoencoder.tflite` + `fovet_lstm_autoencoder_model.h` |

> **Note LSTM AutoEncoder :** variante avec couche LSTM (séquences temporelles). Capture les corrélations entre échantillons successifs — meilleur sur signaux périodiques (vibrations, ECG). Requiert `window_size` samples glissants. `unroll=True` imposé pour compatibilité TFLite export.

> **Note IsolationForest :** les structures d'arbres sont incompatibles avec les contraintes RAM d'un MCU. Ce détecteur est réservé à un usage cloud ou gateway (Raspberry Pi, serveur edge).

> **Note EWMA Drift :** complémentaire au Z-Score. Le Z-Score détecte les pics soudains ; EWMA Drift détecte les glissements progressifs que Welford absorbe dans sa moyenne courante. À utiliser conjointement sur signaux physiques lents (température, pression).

---

## Pipeline métier — Détection de chute (PTI)

`FallDetectionPipeline` entraîne un modèle de détection de chute sur un signal accéléromètre (IMU) et exporte un fichier `.tflite` INT8 < 32 KB prêt pour TFLite Micro sur ESP32.

### Principe

```
Signal IMU (ax, ay, az @ 25 Hz)
    ↓  _compute_magnitude → |a| = sqrt(ax²+ay²+az²)
    ↓  Fenêtre glissante 50 samples (2 s), pas de 25 samples (50 % overlap)
    ↓  _extract_window → 10 features par fenêtre
    ↓  Dense(16, relu) → Dense(8, relu) → Dense(1, sigmoid)
    ↓  Score ∈ [0, 1]  →  > 0.5 = chute détectée
```

### 10 features par fenêtre

| Index | Feature | Description |
|---|---|---|
| 0 | `magnitude_mean` | Moyenne de \|a\| |
| 1 | `magnitude_std` | Écart-type de \|a\| |
| 2 | `magnitude_min` | Minimum de \|a\| |
| 3 | `magnitude_max` | Maximum de \|a\| |
| 4 | `magnitude_rms` | RMS de \|a\| |
| 5 | `magnitude_kurtosis` | Kurtosis (aplatissement) |
| 6 | `magnitude_skewness` | Asymétrie |
| 7 | `zcr` | Taux de passage par zéro |
| 8 | `peak_to_peak` | max - min |
| 9 | `signal_energy` | sum(\|a\|²) / n |

### Usage

```python
from forge.pipelines.fall_detection import FallDetectionPipeline, synthesize_fall_data

# Données (DataFrame colonnes : timestamp_ms, sensor_type, value_1/2/3, label)
data = synthesize_fall_data(n_normal=800, n_fall=200)

pipeline = FallDetectionPipeline(epochs=50, window_samples=50, step_samples=25)
pipeline.fit(data, verbose=1)

# Évaluation
report = pipeline.evaluate(data)
print(report)  # Precision, Recall, F1, confusion matrix
assert report.meets_spec()  # precision >= 0.92 et recall >= 0.90

# Export vers edge-core (TFLite Micro + headers C + config JSON)
pipeline.export("path/to/output/")
```

### Artefacts exportés

| Fichier | Usage |
|---|---|
| `fall_detection.tflite` | Inférence TFLite Micro sur ESP32 |
| `fall_detection_model.h` | Tableau C `g_fall_detection_model[]` + `#define FOVET_FALL_DETECTION_N_FEATURES 10` |
| `fall_detection_model.cc` | Définition du tableau byte (à compiler avec le firmware) |
| `fall_detection_config.json` | `scaler_mean`, `scaler_std`, `threshold`, `window_samples` |

### Intégration firmware

```c
#include "fall_detection_model.h"

// Dans fovet_pti_init(), passer my_fall_score_fn :
float my_fall_score_fn(const float *mag, uint32_t n) {
    // 1. Normaliser les 10 features avec scaler_mean / scaler_std
    // 2. Inférence TFLite Micro → score sigmoid [0, 1]
    return score;
}
```

---

## Pipeline métier — Détection fatigue / HRV (H2.2)

`FatigueHRVPipeline` entraîne un Random Forest sur des features HRV extraites d'un signal BVP (Blood Volume Pulse) et exporte un header C avec les seuils pour Sentinelle (H2.3). Aucune dépendance TensorFlow — sklearn uniquement.

### Principe

```
Signal BVP (value_1 @ 64 Hz, sensor_type="hr")
    ↓  _bvp_to_rr → détection pics (scipy.signal.find_peaks) → RR intervals (ms)
    ↓  Fenêtre glissante 120 s, pas de 60 s
    ↓  _extract_hrv_features → 7 features HRV par fenêtre
    ↓  RandomForestClassifier (sklearn) — AUC ≥ 0.85
    ↓  Proba ∈ [0, 1]  →  > 0.5 = fatigue détectée
```

### 7 features HRV par fenêtre

| Index | Feature | Description |
|---|---|---|
| 0 | `mean_rr` | Intervalle RR moyen (ms) |
| 1 | `sdnn` | Écart-type des RR (ms) — HRV globale |
| 2 | `rmssd` | RMS des différences successives (ms) — tonus parasympathique |
| 3 | `pnn50` | Proportion de \|ΔRR\| > 50 ms |
| 4 | `mean_hr` | FC moyenne (bpm) = 60 000 / mean_rr |
| 5 | `cv_rr` | Coefficient de variation = sdnn / mean_rr |
| 6 | `range_rr` | max_rr - min_rr (ms) |

### Usage

```python
from forge.pipelines.fatigue_hrv import FatigueHRVPipeline, synthesize_fatigue_data

# Données synthétiques WESAD-like (BVP @ 64 Hz)
data = synthesize_fatigue_data(n_baseline_s=600, n_stress_s=300)

pipeline = FatigueHRVPipeline(window_s=120, step_s=60, n_estimators=100)
pipeline.fit(data)

# Évaluation — spec : AUC ≥ 0.85
report = pipeline.evaluate(data)
print(report)
assert report.meets_spec()  # AUC >= 0.85

# Export vers edge-core (header C + config JSON + modèle joblib)
pipeline.export("models/fatigue_hrv/")
```

### Artefacts exportés

| Fichier | Usage |
|---|---|
| `fatigue_hrv_model.pkl` | Modèle RandomForest sérialisé (joblib) — prédiction batch |
| `fatigue_hrv_config.json` | `scaler_mean`, `scaler_std`, `feature_importances`, `threshold` |
| `fatigue_hrv_thresholds.h` | Header C pour Sentinelle MCU (H2.3) — seuils RMSSD / HR |

### Intégration firmware (H2.3)

```c
#include "fatigue_hrv_thresholds.h"

// Classifier la fatigue en 3 niveaux à partir des features HRV temps réel :
fovet_fatigue_level_t classify_fatigue(float rmssd_ms, float mean_hr_bpm) {
    if (rmssd_ms > FOVET_FATIGUE_RMSSD_OK)    return FOVET_FATIGUE_LEVEL_OK;
    if (rmssd_ms < FOVET_FATIGUE_RMSSD_ALERT) return FOVET_FATIGUE_LEVEL_CRITICAL;
    return FOVET_FATIGUE_LEVEL_ALERT;
}
```

### Données réelles (WESAD)

```bash
# Télécharger WESAD (accès académique — https://ubicomp.ifi.lmu.de/pub/datasets/WESAD/)
# Extraire dans datasets/raw/wesad/ (structure S2/S2.pkl, S3/S3.pkl, ...)
uv run python -m forge.datasets.download_human_datasets parse wesad \
    --raw-dir datasets/raw/wesad \
    --output-dir datasets/human
# Puis entraîner sur données réelles :
# df = load_parsed(Path("datasets/human"), "wesad")
# pipeline.fit(df[df["sensor_type"] == "hr"])
```

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

## Tests

```bash
uv run pytest -v
# ~470 tests au total (branch monitoring/human : +H1/H2/H3 pipelines)
# 321 tests master (dont quelques-uns skippés si TF absent)
# 186 tests toujours actifs (sklearn only, sans TF)
```

## Roadmap Forge

| Session | Statut | Contenu |
|---|---|---|
| Forge-1 | ✅ | Scaffold uv + Pydantic config + CLI Typer |
| Forge-2 | ✅ | Data layer : Dataset, synthetic, CSV, loader factory |
| Forge-3a | ✅ | ZScoreDetector (Welford) + export `fovet_zscore_config.h` |
| Forge-3b | ✅ | IsolationForestDetector (sklearn) + export JSON |
| Forge-4 | ✅ | AutoEncoderDetector (Keras Dense) + export TFLite INT8 + C header |
| Forge-4b | ✅ | LSTMAutoEncoderDetector (Keras LSTM) + export TFLite + C header |
| Forge-5 | ✅ | Rapport HTML/JSON + train/test split + métriques évaluation |
| Forge-6 | ✅ | CI GitHub Actions + workflow GPU Scaleway |
| H1.2 (monitoring/human) | ✅ | FallDetectionPipeline — détection chute IMU, TFLite INT8, 56 tests |
| H2.2 (monitoring/human) | ✅ | FatigueHRVPipeline — BVP→HRV, Random Forest, AUC ≥ 0.85, 67 tests |

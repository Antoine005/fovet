# Fovet — Architecture technique

---

## Vue d'ensemble

Fovet est un système distribué de détection d'anomalies souverain pour capteurs embarqués.
Il est composé de trois couches indépendantes qui s'interfacent via des contrats explicites (headers C, JSON, MQTT).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   EDGE                    CLOUD / LAN                     OFFLINE            │
│   ────────────────        ────────────────────────        ────────────────── │
│                                                                              │
│   ESP32-CAM               Mosquitto                       Fovet Forge        │
│   ┌──────────┐            ┌─────────────┐                 ┌──────────────┐   │
│   │Sentinelle│  WiFi/    │ Broker MQTT │                 │ Python AutoML│   │
│   │ (C99)   │──MQTT──→  │ port 1883   │                 │              │   │
│   │         │            └──────┬──────┘                 │ ZScore       │   │
│   │ zscore.h│                   │ subscribe              │ IsoForest    │   │
│   │ 20 bytes│                   ▼                        │ AutoEncoder  │   │
│   │ drift.h │            ┌─────────────┐                 └──────┬───────┘   │
│   │ 24 bytes│            │ Fovet Vigie │                        │           │
│   └─────────┘            │ (Next.js)   │                 export ↓           │
│         ▲                │ PostgreSQL  │          fovet_zscore_config.h     │
│         │                │ REST + SSE  │          autoencoder.tflite        │
│         │                └─────────────┘                        │           │
│         └──────────────────────────────────────────────────────-┘           │
│              firmware mis à jour avec stats précalibrées                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Flux de données

### 1. Ingestion temps réel (ESP32 → Vigie)

```
ESP32-CAM
  │  Lit capteur (ADC / I2C)
  │  Appelle fovet_zscore_update(ctx, sample)
  │  Appelle fovet_drift_update(ctx, sample)
  │  Si anomalie → LED clignote
  │  Publie JSON sur MQTT:
  │    topic : fovet/devices/esp32-cam-001/readings
  │    payload: { value, mean, stddev, zScore, anomaly }
  ▼
Mosquitto broker (LAN ou Scaleway)
  │  Auth par login/mdp
  │  ACL : fovet-device ne peut écrire que fovet/devices/+/readings
  ▼
Fovet Vigie (instrumentation.ts → startMqttIngestion())
  │  Subscribe fovet/devices/+/readings
  │  INSERT INTO readings (value, mean, stddev, zScore, isAnomaly)
  │  Si anomaly=true → INSERT INTO alerts
  │  emitReading() → EventEmitter → clients SSE connectés
  ▼
PostgreSQL / TimescaleDB
  │  TimescaleDB en prod (compression + requêtes temporelles)
  │  PostgreSQL en dev local
  ▼
Dashboard (page.tsx + ReadingChart.tsx)
  │  SSE EventSource : lectures en temps réel
  │  Fallback polling 5 s si SSE indisponible
  Graphes Recharts, liste alertes + bouton acquittement
```

### 2. Calibration hors-ligne (Forge → ESP32)

```
Données sources
  │  CSV exporté depuis Vigie, ou synthétique, ou live MQTT
  ▼
Fovet Forge
  │  uv run forge run --config configs/mon_capteur.yaml
  │  1. Charge les données (load_data)
  │  2. Normalisation optionnelle (StandardScaler)
  │  3. Crée les détecteurs (build_detectors)
  │  4. Fit sur données propres (sans anomalies)
  │  5. Export vers models/
  ▼
Artefacts exportés
  ├── fovet_zscore_config.h       → firmware ESP32 (#include direct)
  ├── scaler_params.json          → paramètres normalisation (si normalize: true)
  ├── isolation_forest_config.json → cloud/gateway uniquement
  ├── autoencoder.tflite          → TFLite Micro sur ESP32
  └── fovet_autoencoder_model.h   → C byte-array pour TFLite Micro
  ▼
Firmware ESP32 mis à jour
  #include "fovet_zscore_config.h"
  // FovetZScore pré-initialisé avec count=10000, mean=23.8f, min_samples=0U
  // Détection active dès le premier sample
```

---

## Interfaces entre composants

### Forge → Sentinelle (C header)

```c
// models/fovet_zscore_config.h
// Généré automatiquement — ne pas modifier manuellement
static FovetZScore fovet_zscore_temperature = {
    .count            = 10000U,
    .mean             = 23.847f,
    .M2               = 1842.315f,
    .threshold_sigma  = 3.0f,
    .min_samples      = 0U,   // précalibré : pas de warm-up
};
```

Le firmware inclut ce fichier à la place d'appeler `fovet_zscore_init()`.

### Forge → Sentinelle (TFLite Micro)

```c
// models/fovet_autoencoder_model.h
const uint8_t g_autoencoder_model_data[] = { 0x1c, 0x00, ... };
const unsigned int g_autoencoder_model_data_len = 4096U;
const float g_autoencoder_threshold = 0.042f;

// Usage avec TFLite Micro :
// tflite::MicroInterpreter interpreter(
//     tflite::GetModel(g_autoencoder_model_data), ...);
```

### ESP32 → Vigie (MQTT JSON)

```json
{
  "value": 23.41,
  "mean": 23.18,
  "stddev": 0.42,
  "zScore": 0.55,
  "anomaly": false
}
```

Topic : `fovet/devices/<mqttClientId>/readings`

### Vigie → Client (REST JSON — lectures paginées)

```json
// GET /api/devices/:id/readings?limit=100&cursor=1234
{
  "data": [
    { "id": "1234", "value": 23.41, "isAnomaly": false, "timestamp": "2026-03-14T..." },
    ...
  ],
  "pagination": {
    "limit": 100,
    "hasMore": true,
    "nextCursor": "1133"
  }
}
```

Les ids `Reading` sont des BigInt sérialisés en String pour la compatibilité JSON.

### Vigie → Client (SSE temps réel)

```
GET /api/devices/:id/stream

event: reading
data: {"id":"1235","value":23.44,"isAnomaly":false,"timestamp":"..."}

event: ping
data: heartbeat
```

---

## Module H1 — Monitoring humain (branch monitoring/human)

Le module H1 étend Fovet Sentinelle vers la surveillance de l'humain (travailleur isolé, défense). Il est développé sur la branche locale `monitoring/human` et n'est pas poussé sur GitHub.

### Architecture H1 — vue d'ensemble

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EDGE (ESP32)                                                             │
│                                                                           │
│  MPU-6050 (I2C)                                                           │
│     │                                                                     │
│     ▼ fovet_mpu6050_set_i2c() → fovet_hal_imu_init()                    │
│  Biosignal HAL (fovet_biosignal_hal.h)                                   │
│     │  registre statique 4 slots (IMU / HR / TEMP / ECG)                │
│     │                                                                     │
│     ▼ fovet_pti_tick() — 25 Hz                                           │
│  Profil PTI (pti_profile.h)                                              │
│     ├─ Fenêtre circulaire 50 samples → fall_score_fn()                   │
│     │     └─ Inférence TFLite Micro (fall_detection.tflite)             │
│     ├─ Immobilité : |a| < 0.1 g pendant > 30 s                          │
│     └─ SOS : GPIO actif-bas                                              │
│     │                                                                     │
│     ▼ alert_fn(FOVET_ALERT_FALL | MOTIONLESS | SOS)                     │
│  → Publie sur MQTT : fovet/devices/<id>/alerts                           │
└──────────────────────────────────────────────────────────────────────────┘
         │ MQTT
         ▼
┌────────────────────────────────────────────────────────────────────────┐
│  VIGIE (dashboard)                                                      │
│                                                                          │
│  mqtt-ingestion.ts → INSERT alerts (ptiType = "FALL"|"MOTIONLESS"|"SOS")│
│                                                                          │
│  GET /api/pti/fleet         → WorkerMap (grille statuts travailleurs)  │
│  GET /api/pti/alerts/recent → AlertTimeline (chronologie cross-flotte) │
└────────────────────────────────────────────────────────────────────────┘
         ↑
┌────────────────────────────────────────────────────────────────────────┐
│  FORGE (offline)                                                         │
│                                                                          │
│  FallDetectionPipeline.fit(data) → Dense 10→16→8→1 sigmoid             │
│  FallDetectionPipeline.export()  → fall_detection.tflite (INT8, < 32KB)│
│                                  → fall_detection_model.h + .cc         │
│                                  → fall_detection_config.json           │
└────────────────────────────────────────────────────────────────────────┘
```

### H1.1 — Driver HAL MPU-6050

Le MPU-6050 est accédé via deux callbacks injectés (`fovet_i2c_write_fn_t`, `fovet_i2c_read_fn_t`), découplant le driver de Wire.h et le rendant testable sur PC.

- Registres : `WHO_AM_I=0x75`, `PWR_MGMT_1=0x6B`, `ACCEL_XOUT_H=0x3B`
- Échelle accéléromètre : 16 384 LSB/g (±2g)
- Fréquence : `SMPLRT_DIV = 1000/hz - 1`, DLPF actif, plage 10–200 Hz
- Auto-enregistrement dans le Biosignal HAL à l'init

### H1.2 — FallDetectionPipeline (Forge)

Pipeline Python entraînant un réseau Dense sur un signal IMU synthétique ou réel.

- Entrée : 10 features extraites d'une fenêtre glissante de 50 samples (2 s @ 25 Hz)
- Architecture : `Input(10) → Dense(16, relu) → Dense(8, relu) → Dense(1, sigmoid)`
- Spécification : precision ≥ 0.92 et recall ≥ 0.90
- Export : TFLite INT8 < 32 KB + header C + config JSON (scaler, threshold, window_samples)

### H1.3 — Profil PTI Sentinelle

Profil C99 zéro-malloc résidant entièrement dans `fovet_pti_ctx_t` (stack).

| Alerte | Logique |
|---|---|
| FALL | `fall_score_fn(ordered_window) > fall_threshold` ; fenêtre pleine uniquement |
| MOTIONLESS | `|a| < motion_threshold_g` continu ≥ `motionless_timeout_ms` ; debounce (1 fire / période) |
| SOS | `gpio_read_fn(pin) == 0` (actif-bas) ; debounce release/press |

### H1.4 — Vue Vigie Flotte PTI

Extension du dashboard Vigie avec une vue dédiée aux travailleurs isolés.

- Champ `Alert.ptiType String?` distingue alertes PTI des alertes z-score (rétrocompatible)
- `GET /api/pti/fleet` : agrège les alertes actives par type pour chaque travailleur
- `GET /api/pti/alerts/recent` : timeline cross-flotte pour le superviseur
- UI : onglet `PTI` → WorkerMap (grille) + AlertTimeline (panneau latéral)

---

## Décisions architecturales

### Pourquoi MQTT et non HTTP depuis l'ESP32 ?

- MQTT est conçu pour l'embarqué : faible overhead, reconnexion automatique, QoS configurable
- HTTP polling depuis l'ESP32 serait plus lourd et introduirait de la latence
- Mosquitto souverain sur Scaleway = zéro dépendance cloud US

### Pourquoi des cookies httpOnly plutôt que localStorage pour le JWT ?

- localStorage est accessible via JavaScript → vulnérable au XSS
- Cookie httpOnly = le token n'est jamais accessible côté JS, même en cas de XSS
- `SameSite=Lax` protège contre le CSRF

### Pourquoi Welford et non une fenêtre glissante ?

- Welford est O(1) en mémoire quelle que soit la durée de la session
- Pas de tableau circulaire, pas de gestion de buffer → convient au SDK embarqué
- La variance de Welford est numériquement stable (contrairement à `sum(x²) - n*mean²`)

### Pourquoi un double EWMA (Drift) en complément du Z-Score ?

- Le Z-Score détecte les pics ponctuels (anomalies impulsionnelles)
- Le double EWMA détecte les dérives lentes (changement de régime, vieillissement capteur)
- Les deux sont O(1) mémoire et < 1 µs/sample : combinables sans coût

### Pourquoi Dense et non LSTM pour l'AutoEncoder ?

- Un LSTM nécessite des fenêtres temporelles → complexité mémoire incompatible avec TFLite Micro
- Dense : chaque sample est traité indépendamment, latence O(1)
- LSTM possible en Forge-7+ si le modèle Dense s'avère insuffisant

### Pourquoi IsolationForest cloud-only ?

- Les structures d'arbres (dizaines d'arbres × centaines de nœuds) sont incompatibles avec < 4 KB RAM
- Réservé à un usage post-traitement cloud ou gateway (Raspberry Pi, serveur edge)
- Le JSON exporté documente explicitement `"deployment": "cloud_or_gateway_only"`

### Pourquoi cursor-based pagination pour les lectures ?

- L'id `Reading` est un BigInt autoincrement → stable comme curseur (pas de drift sur offset)
- Évite les doublons ou sauts lors d'insertions concurrentes (problème du OFFSET SQL)
- Compatible avec le flux SSE : le client connaît son dernier id reçu

### Pourquoi SSE et non WebSocket pour le temps réel ?

- SSE est unidirectionnel (serveur → client) ce qui correspond exactement au besoin (push de lectures)
- SSE fonctionne sur HTTP/1.1, supporte le Cookie httpOnly pour l'auth
- Moins complexe qu'un WebSocket pour un flux de données en lecture seule

### Pourquoi PostgreSQL et non InfluxDB ou TimescaleDB dès le départ ?

- PostgreSQL est universel, facile à héberger, et TimescaleDB s'installe comme une extension
- Migration progressive : développement local en PostgreSQL pur, prod en TimescaleDB (compression, requêtes window)
- Évite une dépendance propriétaire sur une BDD timeseries spécialisée

### Pourquoi un monorepo ?

- Les trois produits (Sentinelle, Forge, Vigie) partagent des conventions et s'interfacent
- Un seul dépôt git = cohérence des versions, CI unifiée, historique commun
- Pas de complexité de workspaces npm/Python pour l'instant (les dossiers sont indépendants)

---

## Contraintes non-négociables (SDK)

Ces contraintes sont vérifiées par les tests natifs et ne doivent jamais être violées :

| Contrainte | Raison |
|---|---|
| C99 pur, zéro dépendance | Compilable sur n'importe quel MCU avec un compilateur C standard |
| Zéro malloc dans les algos | Pas de heap sur MCU bare-metal, pas de fragmentation |
| < 4 KB RAM / détecteur | Budget mémoire ESP32 avec autres tâches (WiFi, MQTT, FreeRTOS) |
| HAL obligatoire | Portabilité : même algo, implémentation plateforme dans `platform_<mcu>.c` |
| Testable en natif (gcc) | Validation sans hardware avant chaque commit |

---

## Roadmap technique

| Session | Produit | Statut | Contenu |
|---|---|---|---|
| Forge-5 | Forge | ✅ | Rapport HTML/JSON + train/test split + métriques |
| Forge-6 | Forge | ✅ | CI GitHub Actions + Scaleway GPU |
| H1.1 | Sentinelle | ✅ | Driver HAL MPU-6050 (I2C callbacks, ±2g, DLPF, 25 tests) |
| H1.2 | Forge | ✅ | FallDetectionPipeline (Dense TFLite INT8 < 32 KB, 56 tests) |
| H1.3 | Sentinelle | ✅ | Profil PTI (FALL/MOTIONLESS/SOS, fenêtre 50 samples, 24 tests) |
| H1.4 | Vigie | ✅ | Vue Flotte PTI (WorkerCard/Map/AlertTimeline, 39 tests API) |
| S10 | Sentinelle | ⏳ ~19/03 | Flash ESP32-CAM (nouvelle carte MB) |
| S11 | Sentinelle | ⏳ | Capteurs réels : DHT22 (I2C) ou MPU-6050 (accéléromètre) |
| Prod-deploy | Vigie | ⏳ | Scaleway VPS, Nginx, HTTPS, Let's Encrypt |
| H2.1 | Sentinelle | 🔜 | Driver HAL MAX30102 (Pan-Tompkins BPM, SpO₂) |
| H2.2 | Forge | 🔜 | Pipeline fatigue HRV (WESAD, Random Forest, AUC ≥ 0.85) |
| H2.3 | Sentinelle | 🔜 | Profil Sentinelle Fatigue (LED RGB, 3 niveaux) |

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
│   │ Sentinelle│  WiFi/    │ Broker MQTT │                 │ Python AutoML│   │
│   │ (C99)    │──MQTT──→  │ port 1883   │                 │              │   │
│   │          │            └──────┬──────┘                 │ ZScore       │   │
│   │ zscore.h │                   │ subscribe              │ IsoForest    │   │
│   │ 16 bytes │                   ▼                        │ AutoEncoder  │   │
│   │ RAM      │            ┌─────────────┐                 └──────┬───────┘   │
│   └──────────┘            │ Fovet Vigie │                        │           │
│         ▲                 │ (Next.js)   │                 export ↓           │
│         │                 │ PostgreSQL  │          fovet_zscore_config.h     │
│         │                 │ REST API    │          autoencoder.tflite        │
│         │                 └─────────────┘                        │           │
│         └──────────────────────────────────────────────────────--┘           │
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
  │  Extrait deviceId du topic
  │  INSERT INTO readings (value, mean, stddev, zScore, anomaly)
  │  Si anomaly=true → INSERT INTO alerts
  ▼
PostgreSQL / TimescaleDB
  │  TimescaleDB en prod (compression + requêtes temporelles)
  │  PostgreSQL en dev local
  ▼
Dashboard (page.tsx)
  Graphes Recharts : readings par device
  Liste alertes + bouton acquittement
```

### 2. Calibration hors-ligne (Forge → ESP32)

```
Données sources
  │  CSV exporté depuis Vigie, ou synthétique, ou live MQTT
  ▼
Fovet Forge
  │  uv run forge run --config configs/mon_capteur.yaml
  │  1. Charge les données (load_data)
  │  2. Crée les détecteurs (build_detectors)
  │  3. Fit sur données propres (sans anomalies)
  │  4. Export vers models/
  ▼
Artefacts exportés
  ├── fovet_zscore_config.h       → firmware ESP32 (#include direct)
  ├── isolation_forest_config.json → documentation / rapport client
  ├── autoencoder.tflite          → TFLite Micro sur ESP32
  └── fovet_autoencoder_model.h   → C byte-array pour TFLite Micro
  ▼
Firmware ESP32 mis à jour
  #include "fovet_zscore_config.h"
  // FovetZScore pré-initialisé avec count=10000, mean=23.8f, ...
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

### Vigie → Client (REST JSON)

```json
// GET /api/devices/:id/readings
[
  { "id": "clx...", "value": 23.41, "anomaly": false, "timestamp": "2026-03-14T..." },
  ...
]
```

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

### Pourquoi Dense et non LSTM pour l'AutoEncoder ?

- Un LSTM nécessite des fenêtres temporelles → complexité mémoire et latence incompatibles avec TFLite Micro sur ESP32
- Dense : chaque sample est traité indépendamment, latence O(1)
- LSTM est possible en Forge-5+ si le modèle Dense s'avère insuffisant

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

| Session | Produit | Contenu |
|---|---|---|
| S10 | Sentinelle | Flash ESP32-CAM avec nouvelle carte MB (~19/03) |
| Forge-5 | Forge | Rapport HTML/PDF + train/test split dans pipeline.run() |
| Forge-6 | Forge | CI GitHub Actions + Scaleway GPU |
| S11 | Sentinelle | Capteurs réels : DHT22 (I2C) ou MPU-6050 (accéléromètre) |
| Prod-deploy | Vigie | Scaleway VPS, Nginx, HTTPS, Let's Encrypt |
| Prod-security | Vigie | CSP nonce (suppr. unsafe-eval), refresh token |

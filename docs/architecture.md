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
│   │ zscore.h│                   │ subscribe              │ MAD          │   │
│   │ 20 bytes│                   ▼                        │ EWMA Drift   │   │
│   │ drift.h │            ┌─────────────┐                 │ IsoForest    │   │
│   │ 24 bytes│            │ Fovet Vigie │                 │ AutoEncoder  │   │
│   │ mad.h   │            │ (Next.js)   │                 └──────┬───────┘   │
│   │ ~1 KB   │            │ PostgreSQL  │                 export ↓           │
│   └─────────┘            │ REST + SSE  │          fovet_zscore_config.h     │
│         ▲                │             │          fovet_mad_config.h        │
│         │                │             │          autoencoder.tflite        │
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
  ├── fovet_zscore_config.h            → firmware ESP32 (#include direct)
  ├── fovet_mad_config.h               → firmware ESP32 (ring buffer pré-seedé)
  ├── fovet_drift_config.h             → firmware ESP32 (état EWMA post-calibration)
  ├── scaler_params.json               → paramètres normalisation (si normalize: true)
  ├── fovet_scaler_params.h            → normalisation C header (si normalize: true)
  ├── isolation_forest_config.json     → cloud/gateway uniquement
  ├── autoencoder.tflite               → TFLite Micro sur ESP32 (Dense)
  ├── fovet_autoencoder_model.h        → C byte-array pour TFLite Micro (Dense)
  ├── lstm_autoencoder.tflite          → TFLite Micro sur ESP32 (LSTM, unroll=True)
  └── fovet_lstm_autoencoder_model.h   → C byte-array pour TFLite Micro (LSTM)
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
  "value":      23.41,
  "mean":       23.18,
  "stddev":     0.42,
  "zScore":     0.55,
  "madScore":   0.31,
  "anomaly":    false,
  "sensorType": "TEMP",
  "level":      "SAFE",
  "value2":     61.0,
  "ptiType":    null,
  "ts":         1741876800000
}
```

Champs requis : `value`, `mean`, `stddev`, `zScore`, `anomaly`. Tous les autres sont optionnels.
`sensorType` : `"IMU"` | `"HR"` | `"TEMP"` — identifie le module producteur.
`level` : `"SAFE"` | `"WARN"` | `"DANGER"` | `"COLD"` | `"CRITICAL"` — niveau Sentinelle.
`ptiType` : `"FALL"` | `"MOTIONLESS"` | `"SOS"` — exclusif au module IMU (PTI).
`madScore` : score MAD fenêtré (win=32), 0 pendant warm-up — publié par demo_mqtt.py.

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

## Backlog orienté utilisateur

> Axe stratégique : compléter le périmètre *produit* au-delà des modules capteurs.

### U1 — Alertes unifiées cross-modules ✅

- Migration Prisma : `Alert.alertModule`, `Alert.alertLevel` (WARN/DANGER/COLD/CRITICAL)
- `Reading.sensorType`, `Reading.value2`
- `mqtt-ingestion.ts` : crée alerte si `level ∈ {WARN,DANGER,COLD,CRITICAL}` + z-score legacy
- `GET /api/fleet/health` : état agrégé par module par dispositif
- `FleetHealth.tsx` : vue **Santé** — une ligne par dispositif, badges par module

### U2 — Vue worker individuelle (multi-capteur) ✅

- `GET /api/workers/:deviceId/summary` : agrège lectures HR + TEMP (50 each) + 20 alertes récentes
- `WorkerDetail.tsx` : résumé cross-module + chronologie alertes + export rapport
- Navigation depuis `FleetHealth` (clic ligne)

### U3 — Notifications sortantes (webhook) ✅

- `ALERT_WEBHOOK_URL` + `ALERT_WEBHOOK_MIN_LEVEL` dans `.env.example`
- `mqtt-ingestion.ts` appelle `fireWebhook()` (fire-and-forget) après chaque alerte
- Payload : `{ deviceId, deviceName, alertModule, alertLevel, value, zScore, timestamp }`
- Compatible n8n, Make, Zapier, Slack Incoming Webhooks

### U4 — Export de session ✅

- `GET /api/devices/:id/report?from=ISO&to=ISO&format=json|csv`
- JSON : stats par module, alertsByLevel, liste alertes | CSV : lectures brutes
- Cap 7 jours — défaut 8h ; `ExportReport` dans `WorkerDetail` (presets + download)

### U5 — Mode démo MQTT ✅

3 threads (IMU 1 Hz, HR 0.5 Hz, TEMP 0.33 Hz) publient des lectures Welford réalistes.
Injection automatique d'anomalies toutes les 30 s.

```bash
uv run --with paho-mqtt --with python-dotenv scripts/demo_mqtt.py
python scripts/demo_mqtt.py --device demo-001 --anomaly-period 20 --no-anomalies
```

**Corrige aussi** : `ptiType` propagé depuis le payload MQTT vers la table `alerts`.

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

### Pourquoi MAD plutôt que Z-Score sur certains signaux ?

- Le Z-Score (Welford) accumule moyenne et variance sur tout l'historique → un outlier passé contamine la baseline
- Le MAD utilise la médiane glissante : insensible aux valeurs extrêmes précédentes
- Sur des signaux physiologiques (HR, WBGT) où des pointes légitimes existent, MAD évite la sur-détection
- Contrainte identique : O(1) amortie (tri par insertion sur fenêtre fixe ≤ 128), < 1 µs/sample

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
| Forge-4b | Forge | ✅ | LSTMAutoEncoderDetector + export TFLite + C header (`fovet_lstm_autoencoder_model.h`) |
| Forge-5 | Forge | ✅ | Rapport HTML/JSON + train/test split + métriques |
| Forge-6 | Forge | ✅ | CI GitHub Actions + Scaleway GPU |
| Forge-7 | Forge | ✅ | Benchmark CLI : `forge benchmark --config a.yaml --config b.yaml` |
| Forge-8 | Forge | ✅ | MADDetector + export `fovet_mad_config.h` (miroir C99 `fovet_mad`) |
| Forge-9 | Forge | ✅ | Pipeline Scaler + export `fovet_scaler_params.h` (normalize: true) |
| U1–U5 | Vigie/Scripts | ✅ | Alertes cross-module + worker view + webhook + export + démo MQTT (zScore + madScore) |
| S10 | Sentinelle | ⏳ ~19/03 | Flash ESP32-CAM (nouvelle carte MB) |
| S11 | Sentinelle | ⏳ | Capteurs réels : DHT22 (I2C) ou MPU-6050 (accéléromètre) |
| Prod-deploy | Vigie | ⏳ | Scaleway VPS, Nginx, HTTPS, Let's Encrypt |
| Prod-security | Vigie | ⏳ | Redis rate limiting, CSP nonce, refresh token |

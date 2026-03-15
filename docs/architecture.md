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

## Modules H — Monitoring humain (branch monitoring/human)

Le module H étend Fovet Sentinelle vers la surveillance physiologique de l'humain (travailleur isolé, défense, milieu industriel). Développé sur la branche locale `monitoring/human`, non poussé sur GitHub.

**Biosignal HAL** (`fovet_biosignal_hal.h`) — registre statique 4 slots, commun à tous les modules H :

| Slot | Source | Driver | Profil | Statut |
|---|---|---|---|---|
| 0 — IMU  | `FOVET_SOURCE_IMU`  | `mpu6050_hal.c`  | `pti_profile.c` (H1)      | ✅ Complet |
| 1 — HR   | `FOVET_SOURCE_HR`   | `max30102_hal.c` | `fatigue_profile.c` (H2)  | ✅ Complet |
| 2 — TEMP | `FOVET_SOURCE_TEMP` | `dht22_hal.c`    | `temp_profile.c` (H3)     | ✅ Complet |
| 3 — ECG  | `FOVET_SOURCE_ECG`  | *(H4 — AD8232)*  | *(H4 — stress combiné)*   | 🟡 Standby (hardware) |

---

### Architecture H1 — PTI (Protection du Travailleur Isolé)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EDGE (ESP32)                                                             │
│                                                                           │
│  MPU-6050 (I2C)                                                           │
│     ▼ fovet_mpu6050_set_i2c() → fovet_mpu6050_init() → FOVET_SOURCE_IMU │
│  Biosignal HAL                                                            │
│     ▼ fovet_pti_tick() — 25 Hz                                           │
│  Profil PTI : fenêtre 50 samples → fall_score_fn (TFLite Micro)         │
│               immobilité |a|<0.1g > 30s / SOS GPIO actif-bas            │
│     ▼ alert_fn(FALL | MOTIONLESS | SOS) → MQTT                          │
└──────────────────────────────────────────────────────────────────────────┘
         │ MQTT  fovet/devices/<id>/alerts
         ▼
Vigie — INSERT Alert (ptiType) → GET /api/pti/fleet → WorkerMap / AlertTimeline

Forge — FallDetectionPipeline → Dense 10→16→8→1 INT8 < 32 KB → fall_detection.tflite
```

### Architecture H2 — Fatigue cardiaque

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EDGE (ESP32)                                                             │
│                                                                           │
│  MAX30102 (I2C)                                                           │
│     ▼ fovet_max30102_set_i2c() → fovet_max30102_init() → FOVET_SOURCE_HR│
│  Biosignal HAL                                                            │
│     ▼ fovet_fatigue_tick() — 25 Hz                                       │
│  Profil Fatigue : EMA BPM α=0.05 — seuils 72/82 bpm                     │
│                   SpO₂ < 94% → CRITICAL (priorité)                       │
│                   3 niveaux → LED RGB (OK/ALERT/CRITICAL)                │
│     ▼ alert_fn(level) → MQTT                                             │
└──────────────────────────────────────────────────────────────────────────┘
         │ MQTT  fovet/devices/<id>/readings (value = BPM)
         ▼
Vigie — GET /api/devices/:id/readings → FatigueCard + HRVChart (onglet Fatigue)
        Classification client-side : EMA α=0.05, seuils 72/82 bpm

Forge — FatigueHRVPipeline → BVP → 7 features HRV → Random Forest AUC ≥ 0.85
                            → fatigue_hrv_thresholds.h (seuils HR + RMSSD pour MCU)
```

### Architecture H3 — Température / Stress thermique ✅

```
┌──────────────────────────────────────────────────────────────────────────┐
│  EDGE (ESP32)                                                             │
│                                                                           │
│  DHT22 (single-wire)                                                      │
│     ▼ fovet_dht22_set_io() → fovet_dht22_init() → FOVET_SOURCE_TEMP     │
│  Biosignal HAL                                                            │
│     ▼ fovet_temp_tick() — 0.5 Hz (DHT22 max 0.5 Hz)                     │
│  Profil Thermique : WBGT Stull (2011) indoor, ISO 7243 moderate work     │
│     EMA α=0.10, warmup=10 samples, sleep=2000 ms                         │
│     4 niveaux : SAFE / WARN (WBGT≥25) / DANGER (WBGT≥28) / COLD (T≤10) │
│     Cold check prioritaire sur WBGT                                       │
│     ▼ alert_fn(SAFE|WARN|DANGER|COLD) + led_fn + sleep_fn               │
└──────────────────────────────────────────────────────────────────────────┘
         │ MQTT  fovet/devices/<id>/readings (value_1=°C, value_2=RH%)
         ▼
Vigie — TempCard (EMA+WBGT+badge niveau) + TemperatureChart (SSE — 3 courbes)
        onglet "Thermique" — même pattern que H2 Fatigue

Forge — ThermalStressPipeline → 8 features WBGT + RandomForest AUC ≥ 0.90
        → thermal_stress_model.pkl + thermal_stress_config.json
        → thermal_thresholds.h (FOVET_TEMP_WBGT_WARN_C / DANGER_C / COLD_ALERT_C)
```

---

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

### H2.1 — Driver HAL MAX30102

Pilote optique pour la mesure de fréquence cardiaque et SpO₂.

- Pan-Tompkins simplifié sur fenêtre circulaire de 100 samples (4 s @ 25 Hz)
- Ratio-of-ratios RED/IR pour l'estimation SpO₂ ; clamp physiologique [30, 220] BPM
- Registres : `PART_ID=0x15`, `FIFO_DATA`, contrôle LED RED + IR 6.4 mA
- Injection I2C : même interface que MPU-6050 (`fovet_i2c_write_fn_t`, `fovet_i2c_read_fn_t`)
- `FOVET_HR_ERR_NODATA=-4` (distinct de `FOVET_HAL_ERR_NOREG=-3`)

### H2.2 — FatigueHRVPipeline (Forge)

Pipeline Python entraînant un Random Forest sur 7 features HRV issues de la BVP.

- Entrée : signal BVP synthétique (pulses gaussiens à positions jittérées)
- Features : `mean_rr`, `sdnn`, `rmssd`, `pnn50`, `mean_hr`, `cv_rr`, `range_rr`
- Baseline (repos) : 62 bpm / RMSSD=40 ms ; Stress : 82 bpm / RMSSD=12 ms
- Spécification : AUC ROC ≥ 0.85 (atteint > 0.95 sur données synthétiques)
- Export : `fatigue_hrv_model.pkl`, `fatigue_hrv_config.json`, `fatigue_hrv_thresholds.h`

### H2.3 — Profil Sentinelle Fatigue

Profil C99 zéro-malloc implémentant la détection de fatigue cardiaque sur MCU.

| Niveau | Condition | LED |
|---|---|---|
| OK | EMA BPM < 72 | Vert |
| ALERT | 72 ≤ EMA BPM ≤ 82 | Ambre |
| CRITICAL | EMA BPM > 82 **ou** SpO₂ < 94 % | Rouge |

- EMA α = 0.05 (≈ 20 samples de mémoire), seed = premier sample valide
- Warmup : 25 samples avant première classification
- SpO₂ < spo2_critical → CRITICAL en priorité absolue
- Callbacks : `alert_fn` (sur changement de niveau), `led_fn` (chaque tick), `sleep_fn`

### H2.4 — Vue Vigie Fatigue

Extension Vigie avec vue dédiée à la surveillance de la fatigue cardiaque.

- `FatigueCard` : carte par dispositif — EMA BPM α=0.05, niveau badge couleur, sparkline avec RefLines 72/82 bpm, auto-refresh 15 s
- `HRVChart` : graphe temps réel SSE — BPM brut + courbe EMA violette, ReferenceArea OK/ALERT/CRITICAL, RefLines labellisées 72 et 82 bpm
- Onglet `Fatigue` dans le dashboard — grille FatigueCards + HRVChart detail
- Seuils identiques au profil MCU — classification client-side, aucun changement de schéma

### H3.1 — Driver HAL DHT22 ✅

Pilote C99 pour le capteur DHT22 (température ambiante + humidité relative, protocole single-wire 40 bits).

- IO entièrement injectée : `pin_write`, `pulse_us(expected_level, timeout_us)`, `delay_us`
- `pulse_us` retourne 0 sur timeout (caller → `FOVET_DHT22_ERR_TIMEOUT`)
- Décodage bit : durée HIGH < 40 µs → 0, ≥ 40 µs → 1
- Checksum 8 bits sur (bytes[0]+bytes[1]+bytes[2]+bytes[3]) & 0xFF
- Températures négatives : bit 15 de bytes[2] = signe
- Erreurs : `ERR_TIMEOUT=-1`, `ERR_CHECKSUM=-2`, `ERR_RANGE=-3`, `ERR_IO=-4`
- S'enregistre en tant que `FOVET_SOURCE_TEMP` dans le biosignal HAL

### H3.2 — ThermalStressPipeline (Forge) ✅

Pipeline Python entraînant un Random Forest sur 8 features thermiques issues du DHT22.

- WBGT Stull (2011) : `NWB = T×atan(0.151977×√(H+8.313659)) + ... - 4.686035` ; `WBGT = 0.7×NWB + 0.3×T`
- 8 features : `mean_celsius`, `max_celsius`, `min_celsius`, `std_celsius`, `mean_humidity`, `mean_wbgt`, `max_wbgt`, `trend_celsius` (pente °C/min)
- Fenêtre glissante 240 s, pas 120 s, 0.5 Hz (DHT22)
- Données synthétiques 3 phases : normal (22°C/50%), stress chaud (35°C/72%), stress froid (4°C/80%)
- Spécification : AUC ROC ≥ 0.90 (atteint > 0.99 sur données synthétiques)
- Export : `thermal_stress_model.pkl`, `thermal_stress_config.json`, `thermal_thresholds.h`

### H3.3 — Profil Thermique Sentinelle ✅

Profil C99 zéro-malloc implémentant la classification thermique sur MCU via WBGT.

| Niveau | Condition (par priorité) | LED |
|---|---|---|
| COLD   | EMA temp ≤ 10 °C (priorité) | Bleu |
| DANGER | WBGT ≥ 28 °C | Rouge |
| WARN   | WBGT ≥ 25 °C | Ambre |
| SAFE   | sinon | Vert |

- WBGT calculé inline : `fovet_temp_compute_wbgt(celsius, humidity_pct)` via `atanf`/`sqrtf`/`powf` de `<math.h>`
- EMA α = 0.10, warmup = 10 samples, sleep = 2000 ms (0.5 Hz)
- Erreurs transitoires DHT22 (TIMEOUT/CHECKSUM/RANGE) → skip tick + sleep, pas de propagation
- ERR_IO (callbacks non injectés) → propagé comme erreur fatale

### H3.4 — Vue Vigie Thermique ✅

Extension Vigie avec vue dédiée à la surveillance thermique WBGT.

- `TempCard` : carte par dispositif — EMA α=0.10, WBGT Stull (2011) client-side, 4 niveaux colorés, sparkline orange avec RefLine froid=bleu
- `TemperatureChart` : graphe temps réel SSE — 3 courbes (temp brute / EMA / WBGT), ReferenceArea zones, RefLines aux 3 seuils avec labels
- Onglet `Thermique` dans le dashboard — 5e vue (Flotte / Détail / PTI / Fatigue / Thermique)
- WBGT calculé côté client (même formule Stull 2011 que temp_profile.c)

### H4 — ECG / Stress combiné 🟡 Standby (hardware)

> **Bloqué** en attente du module AD8232 (~20€ — voir `docs/hardware-bom.md`)

Conception prévue :

| Sous-module | Contenu |
|---|---|
| H4.1 Sentinelle | Driver HAL AD8232 — sortie analogique ADC ESP32 (GPIO34), détection R-peaks, mesure RR précise |
| H4.2 Forge | Pipeline stress combiné (HR + RMSSD + WBGT + accélération) — dataset WESAD ou synthétique |
| H4.3 Vigie | Vue ECG — tracé temps réel + détection arythmie / surmenage |

---

## Backlog orienté utilisateur

> Axe stratégique : compléter le périmètre *produit* au-delà des modules capteurs.
> Ces items ne dépendent pas du hardware AD8232 et sont réalisables dans l'état actuel.

### U1 — Alertes unifiées cross-modules ✅

**Implémenté (commit 28936d1)**

- Migration Prisma : `Alert.alertModule` (PTI/FATIGUE/THERMAL), `Alert.alertLevel` (WARN/DANGER/COLD/CRITICAL)
- `Reading.sensorType` (IMU/HR/TEMP), `Reading.value2` (humidité %)
- `mqtt-ingestion.ts` : crée alerte si `level ∈ {WARN,DANGER,COLD,CRITICAL}` + z-score legacy
- `GET /api/fleet/health` : état agrégé par module par dispositif
- `FleetHealth.tsx` : vue **Santé** — une ligne par travailleur, badges PTI/FATIGUE/THERMAL

### U2 — Vue worker individuelle (multi-capteur) ✅

**Implémenté (commit suivant)**

- `GET /api/workers/:deviceId/summary` : agrège PTI + HR (50 readings) + TEMP (50 readings) + 20 alertes récentes
- `WorkerDetail.tsx` : layout 3 colonnes (PTI / Fatigue / Thermique) + chronologie alertes cross-module
- EMA/WBGT calculés côté client (même formules que FatigueCard/TempCard)
- Navigation depuis `FleetHealth` (clic ligne) et `WorkerMap` (clic carte travailleur)

### U3 — Notifications sortantes (webhook / email) ✅

**Implémenté** : `ALERT_WEBHOOK_URL` + `ALERT_WEBHOOK_MIN_LEVEL` dans `.env.example`.
`mqtt-ingestion.ts` appelle `fireWebhook()` (fire-and-forget) après chaque création d'alerte.
Payload : `{ deviceId, deviceName, alertModule, alertLevel, value, zScore, timestamp }`.
Compatible n8n, Make, Zapier, Slack Incoming Webhooks.

### U4 — Export de session (rapport travailleur)

**Besoin** : à la fin d'un poste, le superviseur veut un rapport synthétique de la session : anomalies détectées, durée en zone de risque, alertes déclenchées.

**Ce qui manque** : aucun endpoint d'export, aucun résumé de session.

**Travaux** :
- `GET /api/devices/:id/report?from=&to=` → JSON ou CSV
- Contenu : durée totale, nb lectures, % temps en alerte par module, liste alertes, min/max/mean par valeur
- Optionnel : export PDF côté client (jsPDF ou html2canvas)

### U5 — Mode démo / simulation (sans hardware) ✅

**Implémenté** : `scripts/demo_mqtt.py`

3 threads (IMU 1 Hz, HR 0.5 Hz, TEMP 0.33 Hz) publient des lectures Welford réalistes.
Injection automatique d'anomalies (FALL/SOS/MOTIONLESS, fatigue, chaleur WBGT) toutes les 30 s.

```bash
# Démarrage rapide (sans installation)
uv run --with paho-mqtt --with python-dotenv scripts/demo_mqtt.py

# Options
python scripts/demo_mqtt.py --device demo-001 --interval 1 --anomaly-period 20
python scripts/demo_mqtt.py --no-anomalies   # flux normaux uniquement
```

**Corrige aussi** : `ptiType` désormais propagé depuis le payload MQTT vers la table `alerts`
(les vues PTI fleet et `/api/pti/fleet` voient maintenant les alertes FALL/SOS/MOTIONLESS).

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

## Roadmap

### Modules capteurs (Sentinelle / Forge / Vigie)

| Module | Sentinelle | Forge | Vigie | Tests |
|---|---|---|---|---|
| **H1 — PTI** (MPU-6050, chute) | ✅ | ✅ | ✅ | 25+56+24 = 105 |
| **H2 — Fatigue cardiaque** (MAX30102) | ✅ | ✅ | ✅ | 23+67+27 = 117 |
| **H3 — Stress thermique** (DHT22/WBGT) | ✅ | ✅ | ✅ | 43+88+40 = 171 |
| **H4 — ECG / Stress combiné** (AD8232) | 🟡 | 🟡 | 🟡 | — |

> **H4 bloqué** : en attente du module AD8232 (~20 €, voir `docs/hardware-bom.md`).

**Total tests actifs** : 16 (zscore) + 28 (drift) + 10 (forge_integration) + 30 (biosignal_hal) + 251 modules H = **335 tests** — tous passants.

---

### Backlog orienté utilisateur (priorité décroissante)

| Item | Axe | Valeur | Effort | Dépendances |
|---|---|---|---|---|
| **U1** — Alertes unifiées cross-modules | Supervisor | ⭐⭐⭐ | M | Prisma migration |
| **U2** — Vue worker individuelle (multi-capteur) | Supervisor | ⭐⭐⭐ | M | U1 |
| **U3** — Notifications webhook/email | Ops | ⭐⭐⭐ | S | — |
| **U5** — Mode démo / injection synthétique | Commercial | ⭐⭐ | S | Mosquitto local |
| **U4** — Export rapport de session (CSV/JSON) | Compliance | ⭐⭐ | M | — |
| **S10** — Flash ESP32-CAM réel | Validation | ⭐⭐⭐ | — | Nouvelle MB (~19/03) |
| **H4** — ECG AD8232 | Sensing | ⭐⭐ | L | AD8232 hardware |
| **Prod-deploy** — Scaleway VPS, Nginx, HTTPS | Infra | ⭐⭐ | L | — |

---

### Historique sessions

| Session | Produit | Statut | Contenu |
|---|---|---|---|
| Forge-5 | Forge | ✅ | Rapport HTML/JSON + train/test split + métriques |
| Forge-6 | Forge | ✅ | CI GitHub Actions + Scaleway GPU |
| H1.1 | Sentinelle | ✅ | Driver HAL MPU-6050 (I2C callbacks, ±2g, DLPF, 25 tests) |
| H1.2 | Forge | ✅ | FallDetectionPipeline (Dense TFLite INT8 < 32 KB, 56 tests) |
| H1.3 | Sentinelle | ✅ | Profil PTI (FALL/MOTIONLESS/SOS, fenêtre 50 samples, 24 tests) |
| H1.4 | Vigie | ✅ | Vue Flotte PTI (WorkerCard/Map/AlertTimeline, 39 tests API) |
| H2.1 | Sentinelle | ✅ | Driver HAL MAX30102 (Pan-Tompkins BPM, SpO₂, 23 tests) |
| H2.2 | Forge | ✅ | FatigueHRVPipeline (BVP → 7 HRV features → Random Forest AUC ≥ 0.85, 67 tests) |
| H2.3 | Sentinelle | ✅ | Profil Fatigue (EMA BPM + SpO₂ priority, LED RGB, 3 niveaux, 27 tests) |
| H2.4 | Vigie | ✅ | Vue Fatigue (FatigueCard + HRVChart + onglet Fatigue) |
| H3.1 | Sentinelle | ✅ | Driver HAL DHT22 (single-wire, temp + humidity, 43 tests) |
| H3.2 | Forge | ✅ | ThermalStressPipeline (WBGT Stull 2011, RandomForest AUC ≥ 0.90, 88 tests) |
| H3.3 | Sentinelle | ✅ | Profil Thermique (SAFE/WARN/DANGER/COLD, WBGT C99, 40 tests) |
| H3.4 | Vigie | ✅ | Vue Thermique (TempCard + TemperatureChart + onglet Thermique) |
| H4.1 | Sentinelle | 🟡 | Driver HAL AD8232 (ECG single-lead, R-peaks, RR) |
| H4.2 | Forge | 🟡 | Pipeline stress combiné (HR + RMSSD + WBGT + accel — WESAD) |
| H4.3 | Vigie | 🟡 | Vue ECG — tracé temps réel + détection arythmie |
| U1 | Vigie | ✅ | Alertes unifiées cross-modules (PTI + Fatigue + Thermique) |
| U2 | Vigie | ✅ | Vue worker individuelle multi-capteur |
| U3 | Vigie | ✅ | Notifications webhook sortantes |
| U5 | Scripts | ✅ | Mode démo — injection MQTT synthétique |
| S10 | Sentinelle | ⏳ | Flash ESP32-CAM (MB de remplacement) |
| Prod-deploy | Vigie | ⏳ | Scaleway VPS, Nginx, HTTPS, Let's Encrypt |

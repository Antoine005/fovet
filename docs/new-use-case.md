# Fovet — Créer un nouveau use case

Ce guide explique pas à pas comment ajouter un nouveau use case (nouveau capteur, nouveau
type d'anomalie, nouveau site) à la suite Fovet.
Il est conçu pour être reproductible : suivre les mêmes étapes pour chaque nouveau projet.

---

## Vue d'ensemble

Un use case Fovet complet couvre quatre couches :

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. DÉFINIR    Quel capteur ? Quel type d'anomalie ? Quelle freq ?   │
├──────────────────────────────────────────────────────────────────────┤
│  2. SENTINELLE Firmware ESP32 — driver + détecteur + manifest        │
├──────────────────────────────────────────────────────────────────────┤
│  3. FORGE      Calibration offline — config YAML → export C header   │
├──────────────────────────────────────────────────────────────────────┤
│  4. VIGIE      Enregistrer le device → visualiser → alerter          │
└──────────────────────────────────────────────────────────────────────┘
```

Temps estimé pour un use case standard (capteur I2C + Z-Score) : **2–4 h**.

---

## Checklist rapide

Cocher dans l'ordre. Chaque case correspond à une section détaillée ci-dessous.

```
□ 1. Définir : capteur, signal, type d'anomalie, fréquence de sampling
□ 2a. Choisir le ou les détecteurs (tableau de décision)
□ 2b. Créer le manifest par défaut  (fovet_model_manifest.h)
□ 2c. HAL nouveau capteur (si I2C / SPI / OneWire non encore implémenté)
□ 2d. Driver capteur (si non encore disponible)
□ 2e. Créer l'exemple PlatformIO  (edge-core/examples/esp32/<use_case>/)
□ 2f. Tests natifs gcc — couvrir driver + détecteur
□ 3a. Config YAML Forge  (automl-pipeline/configs/<use_case>.yaml)
□ 3b. Collecter (ou générer) des données d'entraînement
□ 3c. uv run forge run --config configs/<use_case>.yaml
□ 3d. forge deploy-manifest → copier fovet_model_manifest.h dans le firmware
□ 4a. Enregistrer le device dans Vigie (POST /api/devices)
□ 4b. Flasher — pio run --target upload
□ 4c. Vérifier les données en temps réel dans Vigie
□ 4d. Valider qu'une anomalie manuelle déclenche une alerte
```

---

## Étape 1 — Définir le use case

Répondre à ces quatre questions avant d'écrire la moindre ligne de code.

| Question | Exemple — vibration machine |
|---|---|
| Quel capteur ? | MPU-6050 (accéléromètre I2C) |
| Quelle valeur surveillée ? | magnitude d'accélération (g) |
| Quel type d'anomalie à détecter ? | pic de vibration soudain |
| Fréquence de sampling ? | 50 Hz |
| Fréquence de publication MQTT ? | 10 Hz (1 point / 5 samples) |

Ces réponses définissent le reste : le détecteur, la config YAML, le manifest.

---

## Étape 2 — Sentinelle (firmware ESP32)

### 2a. Choisir le ou les détecteurs

| Situation | Détecteur recommandé | Fichier C |
|---|---|---|
| Signal propre, Gaussien — détecter les pics | **Z-Score** (`zscore`) | `fovet/zscore.h` |
| Signal bruité ou outliers fréquents | **MAD** (`mad`) | `fovet/mad.h` |
| Dérive lente (vieillissement, changement régime) | **EWMA Drift** (`ewma_drift`) | `fovet/drift.h` |
| Signal complex multidimensionnel | **AutoEncoder** (`autoencoder`) | TFLite Micro |
| Signal périodique (vibration, ECG, rythme) | **LSTM AutoEncoder** (`lstm_autoencoder`) | TFLite Micro |
| Post-traitement cloud / gateway Raspi | **Isolation Forest** (`isolation_forest`) | JSON → serveur |

Combiner Z-Score + EWMA Drift est la combinaison la plus courante :
Z-Score sur les pics, EWMA Drift sur les glissements. Coût : 48 bytes RAM.

### 2b. Créer le manifest par défaut

Le manifest encode les métadonnées du modèle. Il est embarqué dans le firmware et
publié dans chaque payload MQTT.

Créer `edge-core/examples/esp32/<use_case>/src/fovet_model_manifest.h` :

```c
/*
 * Fovet Model Manifest — <use_case>
 * Généré par : forge deploy-manifest (ou manuellement pour le développement)
 * Après calibration Forge, ce fichier sera remplacé par le manifest généré.
 */
#pragma once

/* Identifiant unique du modèle (remplacé par Forge après calibration) */
#define FOVET_MODEL_ID            "<use_case>-zscore-v1"

/* Capteur physique */
#define FOVET_MODEL_SENSOR        "<sensor>"   // ex: "imu", "temperature", "pressure"

/* Unité de la valeur publiée */
#define FOVET_MODEL_UNIT          "<unit>"     // ex: "g", "°C", "Pa", "rpm"

/* Plage de valeurs attendues (pour auto-scale du graphe Vigie) */
#define FOVET_MODEL_VALUE_MIN     (0.0f)       // à ajuster selon le capteur
#define FOVET_MODEL_VALUE_MAX     (4.0f)       // à ajuster selon le capteur

/* Labels de classification */
#define FOVET_MODEL_LABEL_NORMAL  "normal"
#define FOVET_MODEL_LABEL_ANOMALY "anomaly"
```

> Après calibration Forge (étape 3), ce fichier sera remplacé par le manifest généré
> automatiquement avec les vraies valeurs `value_min` / `value_max`.

### 2c. HAL nouveau capteur (si nécessaire)

Si le protocole physique du capteur n'est pas encore implémenté, créer l'interface HAL.

**Exemple — nouveau bus SPI :**

Créer `edge-core/include/fovet/hal/hal_spi.h` :

```c
#pragma once
#include <stdint.h>

typedef enum {
    HAL_SPI_OK      = 0,
    HAL_SPI_ERR_CS  = 1,
    HAL_SPI_ERR_BUS = 2,
} hal_spi_err_t;

void         hal_spi_init    (uint8_t cs_pin, uint32_t freq_hz);
hal_spi_err_t hal_spi_transfer(uint8_t cs_pin, const uint8_t *tx, uint8_t *rx, uint8_t len);
```

Puis implémenter dans `edge-core/src/platform/platform_esp32.cpp` (bloc `#ifdef ARDUINO`).

Écrire les tests mock dans `edge-core/tests/test_spi_hal.c` — même pattern que
`test_i2c_hal.c` (tableau `mock_regs[N][256]`, flag `mock_present[]`).

**Protocoles déjà implémentés :**

| Bus | Fichier HAL | Implémentation ESP32 | Tests |
|---|---|---|---|
| UART | `hal_uart.h` | `platform_esp32.cpp` | — |
| GPIO | `hal_gpio.h` | `platform_esp32.cpp` | — |
| ADC | `hal_adc.h` | `platform_esp32.cpp` | — |
| Temps | `hal_time.h` | `platform_esp32.cpp` | — |
| I2C | `hal_i2c.h` | `platform_esp32.cpp` | `test_i2c_hal.c` (39 tests) |

### 2d. Driver capteur (si nécessaire)

Créer le driver dans `edge-core/include/fovet/drivers/<capteur>.h` et
`edge-core/src/drivers/<capteur>.c`.

**Conventions :**

```c
/* edge-core/include/fovet/drivers/mon_capteur.h */
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define MON_CAPTEUR_ADDR_DEFAULT  0x48U

typedef struct {
    float valeur_a;
    float valeur_b;
} mon_capteur_data_t;

bool mon_capteur_probe (uint8_t addr);
bool mon_capteur_init  (uint8_t addr);
bool mon_capteur_read  (uint8_t addr, mon_capteur_data_t *out);
```

**Règles :**
- Préfixe : `<capteur>_` (ex: `mpu6050_`, `dht22_`, `max30102_`)
- Zéro malloc — struct allouée par l'appelant
- `probe()` retourne true si le capteur répond sur le bus
- `init()` configure les registres, retourne false si absent ou erreur de communication
- `read()` retourne false si erreur I2C

Drivers déjà disponibles : `mpu6050` (I2C, accéléromètre ±2/4/8/16g).

Écrire les tests dans `edge-core/tests/test_<capteur>.c` — mock du HAL I2C,
couvrir : probe, init, read, erreurs, toutes les configurations.

### 2e. Créer l'exemple PlatformIO

Structure minimale :

```
edge-core/examples/esp32/<use_case>/
├── platformio.ini
├── src/
│   ├── main.cpp
│   ├── config.h.example    ← WiFi/MQTT credentials (ne pas commiter)
│   └── fovet_model_manifest.h
└── lib/
    └── fovet-sentinelle/   ← ou référence à la lib locale
```

`platformio.ini` :

```ini
[env:<use_case>]
platform   = espressif32
board      = esp32dev          ; JAMAIS esp32cam avec CH340
framework  = arduino
monitor_speed = 115200

lib_deps =
    bblanchon/ArduinoJson@^7
    knolleary/PubSubClient@^2

build_flags =
    -I${PROJECT_DIR}/../../include
    -DFOVET_ESP32

build_src_filter =
    +<*.cpp>
    +<../../../../src/zscore.c>
    +<../../../../src/drift.c>
    +<../../../../src/platform/platform_esp32.cpp>
```

> **Important :** utiliser `board=esp32dev`, pas `board=esp32cam`.
> `esp32cam` initialise la PSRAM au boot et crashe silencieusement avec l'adaptateur CH340.

`main.cpp` — squelette minimal :

```cpp
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "fovet/zscore.h"
#include "fovet_model_manifest.h"
#include "config.h"

// ── Config ────────────────────────────────────────────────────────────────────
static const char* MQTT_TOPIC = "fovet/devices/" DEVICE_ID "/readings";

// ── Détecteur ─────────────────────────────────────────────────────────────────
static FovetZScore g_detector;

// ── MQTT ──────────────────────────────────────────────────────────────────────
static WiFiClient   wifiClient;
static PubSubClient mqtt(wifiClient);

static void publish(float value, bool anomaly) {
    StaticJsonDocument<256> doc;
    doc["device_id"] = DEVICE_ID;
    doc["firmware"]  = FOVET_MODEL_ID;
    doc["model_id"]  = FOVET_MODEL_ID;
    doc["sensor"]    = FOVET_MODEL_SENSOR;
    doc["unit"]      = FOVET_MODEL_UNIT;
    doc["value"]     = value;
    doc["value_min"] = FOVET_MODEL_VALUE_MIN;
    doc["value_max"] = FOVET_MODEL_VALUE_MAX;
    doc["label"]     = anomaly ? FOVET_MODEL_LABEL_ANOMALY : FOVET_MODEL_LABEL_NORMAL;
    doc["anomaly"]   = anomaly;
    doc["ts"]        = millis();   // remplacer par NTP en prod

    char buf[256];
    serializeJson(doc, buf);
    mqtt.publish(MQTT_TOPIC, buf);
}

void setup() {
    Serial.begin(115200);
    fovet_zscore_init(&g_detector, 3.0f, 30);

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) { delay(500); }

    mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    while (!mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD)) { delay(1000); }
}

void loop() {
    mqtt.loop();
    float value   = read_sensor();   // ← implémenter selon le capteur
    bool  anomaly = fovet_zscore_update(&g_detector, value);
    publish(value, anomaly);
    delay(100);   // 10 Hz
}
```

### 2f. Tests natifs gcc

Ajouter la cible dans `edge-core/tests/Makefile` :

```makefile
# Dans la liste TESTS :
TESTS += test_<capteur>

# Règle de compilation :
test_<capteur>: test_<capteur>.c $(SRC_DIR)/src/drivers/<capteur>.c
    $(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)
```

Vérifier localement :

```bash
cd edge-core/tests
export PATH="/c/msys64/mingw64/bin:$PATH"  # Windows / MSYS2
make test_<capteur>
./test_<capteur>
# Tous les tests doivent passer avant de toucher le hardware
```

---

## Étape 3 — Forge (calibration)

### 3a. Créer la config YAML

Créer `automl-pipeline/configs/<use_case>.yaml` :

```yaml
name: <use_case>
description: "Détection d'anomalies — <capteur> sur ESP32-CAM"

# Prétraitement optionnel
preprocessing:
  normalize: false   # true si les valeurs ont des ordres de grandeur très différents

# Source de données (choisir une)
data:
  source: synthetic   # pour démarrer sans hardware
  signal: random_walk
  n_samples: 5000
  noise_std: 0.05
  anomaly_fraction: 0.0   # données d'entraînement : ZÉRO anomalie

# Détecteurs — adapter selon l'étape 2a
detectors:
  - type: zscore
    threshold_sigma: 3.0

  # Optionnel — détecter aussi les dérives lentes
  # - type: ewma_drift
  #   alpha_fast: 0.10
  #   alpha_slow: 0.01
  #   threshold_percentile: 99.0

# Export
export:
  targets: [c_header]
  output_dir: models/<use_case>
  quantization: float32

# Manifest — métadonnées intégrées dans le payload MQTT
manifest:
  sensor: <sensor>       # ex: imu, temperature, pressure, vibration
  unit: <unit>           # ex: g, °C, Pa, rpm
  # value_min et value_max : laisser absent = calculé automatiquement
  # depuis les percentiles p1/p99 des données d'entraînement
  label_normal:  normal
  label_anomaly: anomaly
```

> **`value_min` / `value_max` optionnels** : si absents, Forge les calcule automatiquement
> depuis les percentiles p1/p99 du dataset d'entraînement. Les définir manuellement si
> la plage physique du capteur est connue à l'avance (ex: température 0–100 °C).

### 3b. Collecter les données d'entraînement

**Option A — données synthétiques (démarrage rapide)**

Déjà configuré dans le YAML ci-dessus. Aucune action nécessaire.

**Option B — données CSV réelles**

Exporter depuis Vigie :
```bash
curl -b /tmp/c.txt \
  "http://localhost:3000/api/devices/<device_id>/report?format=csv&from=2026-01-01T00:00:00Z" \
  -o data/<use_case>_train.csv
```

Puis adapter le YAML :
```yaml
data:
  source: csv
  path: data/<use_case>_train.csv
  value_column: value   # nom de la colonne dans le CSV
```

**Option C — données live MQTT**

```yaml
data:
  source: mqtt
  broker: mqtt://localhost:1883
  topic: fovet/devices/<mqttClientId>/readings
  n_samples: 5000
  username: fovet-vigie
  password: <mot_de_passe>
```

### 3c. Lancer le pipeline

```bash
cd automl-pipeline

# Valider la config sans entraîner (recommandé avant le premier run)
uv run forge validate --config configs/<use_case>.yaml

# Lancer la calibration
uv run forge run --config configs/<use_case>.yaml
```

Artefacts générés dans `models/<use_case>/` :

```
models/<use_case>/
├── fovet_zscore_config.h      ← à inclure dans le firmware
├── fovet_model_manifest.h     ← manifest enrichi avec vraies valeurs
├── report.json                ← métriques de calibration
└── report.html                ← rapport lisible
```

### 3d. Déployer le manifest dans le firmware

```bash
uv run forge deploy-manifest \
    --config configs/<use_case>.yaml \
    --project-dir ../edge-core/examples/esp32/<use_case>
```

Cette commande copie `models/<use_case>/fovet_model_manifest.h` dans
`edge-core/examples/esp32/<use_case>/src/fovet_model_manifest.h`.

Copier aussi le header de calibration manuellement :

```bash
cp models/<use_case>/fovet_zscore_config.h \
   ../edge-core/examples/esp32/<use_case>/src/
```

Et dans `main.cpp`, remplacer `fovet_zscore_init()` par l'include précalibré :

```c
// Avant calibration :
fovet_zscore_init(&g_detector, 3.0f, 30);

// Après calibration Forge :
#include "fovet_zscore_config.h"
// fovet_zscore_<use_case> est initialisé avec count=10000, min_samples=0
// → détection active dès le premier sample, sans warm-up
```

---

## Étape 4 — Vigie (supervision)

### 4a. Enregistrer le device

```bash
# 1. S'authentifier
curl -c /tmp/cookies.txt -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"password":"<dashboard_password>"}'

# 2. Créer le device
curl -b /tmp/cookies.txt -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<Nom affiché dans Vigie>",
    "mqttClientId": "<device_id>",
    "location": "<Localisation optionnelle>"
  }'
```

`mqttClientId` doit correspondre exactement au `DEVICE_ID` défini dans `config.h`.

### 4b. Flasher l'ESP32

```bash
cd edge-core/examples/esp32/<use_case>

# Renseigner les credentials (ne jamais commiter ce fichier)
cp src/config.h.example src/config.h
# Éditer WIFI_SSID, WIFI_PASSWORD, MQTT_BROKER, MQTT_USER, MQTT_PASSWORD, DEVICE_ID

# Compiler et flasher
pio run --target upload

# Monitorer le port série
pio device monitor --baud 115200
```

### 4c. Vérifier dans Vigie

1. Ouvrir http://localhost:3000
2. Le device apparaît avec un point vert (connecté)
3. Le badge `model_id` s'affiche sous le nom du device
4. Le graphe s'auto-scale sur la plage `value_min`/`value_max` du manifest
5. Les anomalies apparaissent en rouge sur le graphe

### 4d. Valider une anomalie

Provoquer manuellement une anomalie selon le type de capteur :
- Accéléromètre : secouer vigoureusement
- Température : approcher une source de chaleur
- Vibration : frapper la surface

Vérifier que :
- Une alerte apparaît dans l'onglet **Alertes flotte**
- Le webhook est appelé (si `ALERT_WEBHOOK_URL` configuré)
- Le graphe affiche un point rouge à l'horodatage de l'anomalie

---

## Étape 5 — Scaler (plusieurs appareils)

### Plusieurs capteurs identiques sur des sites différents

Chaque appareil a son propre `mqttClientId` mais le même firmware.
Seul `DEVICE_ID` change dans `config.h`.

```bash
# Enregistrer chaque device dans Vigie
for id in esp32-site-a esp32-site-b esp32-site-c; do
    curl -b /tmp/cookies.txt -X POST http://localhost:3000/api/devices \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"Capteur ${id}\",\"mqttClientId\":\"${id}\",\"location\":\"${id}\"}"
done
```

Les données arrivent sur des topics MQTT distincts :
```
fovet/devices/esp32-site-a/readings
fovet/devices/esp32-site-b/readings
fovet/devices/esp32-site-c/readings
```

Vigie ingère automatiquement tous les topics qui correspondent à `fovet/devices/+/readings`.

### Plusieurs types de capteurs sur le même appareil

Publier sur le même topic MQTT avec des `model_id` différents pour chaque modalité.
Voir les exemples `fire_detection` (R/G/B sur même ESP32-CAM) et
`person_detection` (magnitude temporelle sur sortie TFLite).

### Déploiement production

```bash
# Depuis la racine du monorepo
docker compose up -d

# Vérifier l'état des services
curl http://localhost:3000/api/healthz
# {"status":"ok","mqtt":{"connected":true,"broker":"mqtt://localhost:1883"},"db":"ok"}
```

Variables d'environnement à configurer dans `platform-dashboard/.env` :
- `DATABASE_URL` — PostgreSQL (+ TimescaleDB en prod)
- `JWT_SECRET` — clé HMAC-SHA256 (générer avec `openssl rand -hex 32`)
- `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`
- `ALERT_WEBHOOK_URL` — optionnel, pour notifications Slack/n8n/Zapier

---

## Référence rapide

### Tableau de décision détecteur

| Signal | Outliers passés ? | Dérive ? | Recommandation |
|---|---|---|---|
| Sinus propre / bruit Gaussien | Non | Non | Z-Score seul |
| Sinus propre | Non | Oui | Z-Score + EWMA Drift |
| Signal bruité ou outliers fréquents | Oui | Non | MAD |
| Signal bruité avec dérive | Oui | Oui | MAD + EWMA Drift |
| Signal multidimensionnel, corrélations | — | — | AutoEncoder Dense |
| Signal périodique (ECG, vibration) | — | — | LSTM AutoEncoder |
| Post-traitement serveur uniquement | — | — | Isolation Forest |

### RAM consommée par configuration

| Configuration | RAM ESP32 |
|---|---|
| Z-Score seul | 24 bytes |
| Z-Score + EWMA Drift | 48 bytes |
| MAD (win=32) | ~264 bytes |
| MAD (win=128, défaut) | ~1040 bytes |
| AutoEncoder Dense (TFLite) | 4–200 KB (arena) |
| LSTM AutoEncoder (TFLite) | 8–200 KB (arena) |

### Exemples existants comme point de départ

| Use case | Dossier | Capteur | Détecteur |
|---|---|---|---|
| Sinus synthétique | `zscore_demo/` | Synthétique | Z-Score + EWMA Drift |
| Détection feu/fumée | `fire_detection/` | OV2640 RGB565 | 3× Z-Score (R, ratio RB, variance) |
| Détection personne | `person_detection/` | OV2640 96×96 GRAY | TFLite MobileNetV1 + Z-Score temporel |
| Accéléromètre IMU | `imu_zscore/` | MPU-6050 I2C | Z-Score sur magnitude |

### Commandes Forge de référence

```bash
# Valider la config sans entraîner
uv run forge validate --config configs/<use_case>.yaml

# Lancer la calibration
uv run forge run --config configs/<use_case>.yaml

# Comparer plusieurs détecteurs sur le même dataset
uv run forge benchmark \
    --config configs/<use_case>_zscore.yaml \
    --config configs/<use_case>_mad.yaml

# Convertir un modèle Keras en TFLite INT8
uv run forge convert \
    --model models/<use_case>/autoencoder.h5 \
    --quantization int8

# Déployer le manifest dans un projet PlatformIO
uv run forge deploy-manifest \
    --config configs/<use_case>.yaml \
    --project-dir ../edge-core/examples/esp32/<use_case>

# Flasher un modèle TFLite sur ESP32
uv run forge deploy \
    --model models/<use_case>/autoencoder.tflite \
    --target <use_case>
```

---

## Convention de nommage

| Élément | Convention | Exemple |
|---|---|---|
| Config YAML | `<capteur>_<détecteur>.yaml` | `vibration_zscore.yaml` |
| Dossier exemple | `edge-core/examples/esp32/<use_case>/` | `vibration_zscore/` |
| `DEVICE_ID` dans firmware | `<type>-<site>-<numéro>` | `vib-usine-001` |
| `mqttClientId` | idem `DEVICE_ID` | `vib-usine-001` |
| `FOVET_MODEL_ID` dans manifest | `<capteur>-<détecteur>-v<N>` | `vibration-zscore-v1` |
| Dossier modèles | `models/<use_case>/` | `models/vibration_zscore/` |

---

## Mise à jour de la doc

Après avoir créé un nouveau use case, mettre à jour selon les règles de `docs/contributing.md` :

| Ce qui a changé | Doc à mettre à jour |
|---|---|
| Nouveau driver capteur | `edge-core/README.md` section "Drivers disponibles" |
| Nouveau exemple ESP32 | `edge-core/README.md` section "Exemples" |
| Nouveau HAL | `edge-core/README.md` section "HAL" |
| Nouvelle config YAML | `automl-pipeline/README.md` section "Configs" |
| Nouveau type de déploiement | `docs/architecture.md` section "Interfaces" |

# Ardent SDK — Product Specification v2.0
> **Date** : 6 avril 2026 | **Auteur** : Antoine Porte
> **Repo** : `github.com/Antoine005/ardent` | **Site** : `ardent-ai.fr`
> **Usage** : document à fournir tel quel en entrée de Claude Code

---

## 0. Vision produit — ce que ce document doit produire

Ardent est un SDK embarqué souverain pour la détection d'anomalies sur microcontrôleurs.

**L'ambition centrale** : un utilisateur doit pouvoir, **depuis une seule interface web (Ardent Watch)** :

1. Déposer un dataset CSV (ou connecter un flux MQTT live)
2. Choisir un algorithme de détection dans une liste
3. Lancer l'entraînement / calibration (Forge, côté serveur)
4. Flasher automatiquement l'ESP32 avec le firmware généré
5. Voir les données et les anomalies remonter en temps réel dans le même dashboard

**Il n'y a aucun outil externe à ouvrir.** Pas de terminal. Pas de CLI Forge séparée. Pas de PlatformIO manuel. Tout passe par le dashboard.

### Ce qui existe aujourd'hui (état repo master, 6 avril 2026)

| Composant | État |
|---|---|
| Ardent Pulse (SDK C99) | DONE — 391 tests, Z-Score 16 bytes, HAL générique |
| Ardent Forge (CLI Python) | DONE — `uv run forge run --config ...` fonctionnel |
| Ardent Watch (dashboard) | DONE local — Next.js + Hono + PostgreSQL/Timescale + MQTT |
| **Forge intégré dans Watch UI** | MISSING — pas d'UI pour lancer Forge depuis le browser |
| **Flash depuis Watch** | MISSING — flash est manuel via flash.bat / PlatformIO |
| **HAL I2C ESP32 réelle** | IN PROGRESS — MPU-6050 câblé, lecture réelle à finaliser |
| **Déploiement production** | IN PROGRESS — VPS Scaleway, domaine ardent-ai.fr |

---

## 1. Architecture cible

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Ardent Watch — UI unique                          │
│                                                                        │
│  [ Devices ]    [ Forge Studio ]    [ Live Monitor ]    [ History ]   │
│       │                │                    │                │        │
│       └────────────────┴────────────────────┴────────────────┘        │
│                        │ Next.js 14 + Hono API                         │
└────────────────────────┼─────────────────────────────────────────────┘
                         │
          ┌──────────────┼───────────────┐
          │              │               │
   ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
   │ PostgreSQL   │ │   Forge    │ │ Mosquitto  │
   │ /Timescale   │ │  Worker    │ │ MQTT Broker│
   │  (Prisma)    │ │ (Python,   │ │            │
   └─────────────┘ │ subprocess)│ └─────┬──────┘
                   └─────┬──────┘       │ WiFi
                         │              │
                 ┌────────▼───────┐  ┌──▼──────────────┐
                 │ ard_zscore_    │  │  ESP32-CAM        │
                 │ config.h       │  │  Ardent Pulse C99 │
                 │ autoenc.tflite │  │  MPU-6050 I2C     │
                 └────────┬───────┘  │  DHT22            │
                          │ USB/OTA  └──────────────────┘
                          └──────────────────────────────►
```

### Contraintes non négociables

| Contrainte | Valeur |
|---|---|
| RAM par détecteur Pulse | < 4 Ko (Z-Score : 16 bytes) |
| Latence traitement | < 1 ms par sample à 80 MHz |
| Allocation dynamique | **Zéro** malloc/free dans edge-core/src/ |
| Dépendances externes C | **Zéro** — C99 pur |
| Cloud américain | **Zéro** — tout on-premise |
| Testabilité Pulse | make dans edge-core/tests/ sans hardware |

---

## 2. Ardent Watch — l'UI unique

Watch est le produit. Il orchestre Forge et le flash depuis le browser.

### 2.1 Pages et routing

```
ardent-ai.fr/
├── /                   → redirect /monitor ou /devices
├── /devices            → liste ESP32 enregistrés + statut online
├── /devices/[id]       → détail : capteurs actifs, modèle déployé, alertes
├── /forge              → Forge Studio (entraînement + export + flash)
├── /forge/[jobId]      → suivi job Forge (logs SSE)
├── /monitor            → Live Monitor temps réel toute la flotte
├── /monitor/[deviceId] → vue device unique, graphes par canal
├── /history            → historique alertes, export CSV
└── /settings           → config MQTT, auth, seuils globaux
```

### 2.2 Page /forge — Forge Studio (fonctionnalité centrale à implémenter)

**Étape 1 — Source des données (3 onglets)**

- **Upload CSV** : drag & drop, validation colonnes, preview 10 lignes, sélection canal(aux) cible(s)
- **MQTT live** : sélectionner un device enregistré → Forge lit N secondes depuis le broker en direct
- **Synthétique** : curseurs bruit / amplitude / taux anomalie → données générées server-side par Forge

**Étape 2 — Choix de l'algorithme**

Rendu depuis `GET /api/forge/algorithms` — liste **dynamique**, jamais hardcodée en frontend.

```
┌────────────────────────────────────────────────────────────┐
│  Algorithme          Description            RAM estimée     │
│  ○ Z-Score           Statistique univarié   16–64 bytes     │
│  ○ Isolation Forest  Multivarié tabulaire   < 512 bytes     │
│  ○ AutoEncoder LSTM  Série temporelle       8–32 Ko         │
│  ○ Seuil adaptatif   Drift progressif       32 bytes        │
│                                                            │
│  Paramètres (dépliables selon algo sélectionné) :         │
│  window_size [slider]  threshold [slider]  warmup [slider] │
└────────────────────────────────────────────────────────────┘
```

**Étape 3 — Exécution job avec logs streaming**

```
[ Lancer l'entraînement ]

▶ Job #47 — en cours...
  ██████████████░░  78%

  > Loading 5000 samples, channel: magnitude
  > Calibrated: mean=9.81, std=0.23
  > Exporting ard_zscore_config.h
  > Validation: precision=97.3%, recall=94.1%
  > Done in 3.2s

✅ Modèle prêt  [ Déployer sur device ]  [ Télécharger ]
```

Le job Forge tourne en **subprocess Python** lancé par le backend Hono.
Les logs sont streamés via **SSE** sur `GET /api/forge/jobs/[id]/logs`.

**Étape 4 — Flash firmware**

```
┌──────────────────────────────────────────────────┐
│  Device cible : [ esp32cam-01 ▼ ]               │
│  Méthode :      ○ OTA WiFi   ● USB/Serial        │
│                                                  │
│  [ Compiler & Flasher ]                          │
│                                                  │
│  > Injecting manifest → edge-core/examples/esp32 │
│  > pio run --target upload                       │
│  > Uploading... 100%                             │
│  ✅ Flash OK — device online, détection active   │
└──────────────────────────────────────────────────┘
```

Implémentation backend :
```
POST /api/forge/jobs/[id]/deploy
Body: { deviceId, method: "usb" | "ota" }

1. Copier manifest dans edge-core/examples/esp32/src/
2. Écrire src/config.h (WiFi creds, MQTT host, device ID, model ID)
3. Subprocess : pio run --target upload -d edge-core/examples/esp32/
4. Streamer stdout PlatformIO via SSE
5. Si succès → UPDATE device SET activeModelId = jobId
```

> OTA (v2) : nécessite serveur OTA dans le firmware. En v1 : USB/Serial uniquement.

### 2.3 Page /monitor — Live Monitor

- Connexion SSE persistante `/api/events` — push uniquement, zéro polling
- Reconnexion automatique back-off exponentiel (max 30s)
- Sparkline 30 derniers points par canal (recharts)
- Pastille NORMAL/ANOMALY mise à jour temps réel
- Latence MQTT→UI affichée dans le header (ts message vs Date.now())

### 2.4 Format message MQTT (à respecter dans le firmware)

**Topic** : `ardent/devices/{mqttClientId}/readings`

```json
{
  "ts": 1743955200000,
  "device": "esp32cam-01",
  "channel": "accel/magnitude",
  "value": 12.47,
  "anomaly": true,
  "zscore": 4.23,
  "algo": "zscore",
  "model_id": "mpu6050_accel_v1"
}
```

### 2.5 Schéma Prisma — entités Forge à ajouter

```prisma
model ForgeJob {
  id            String      @id @default(cuid())
  status        ForgeStatus @default(PENDING)
  algorithm     String      // zscore | isolation_forest | autoencoder | threshold_adaptive
  config        Json        // paramètres complets
  dataSource    String      // "csv" | "mqtt" | "synthetic"
  dataPath      String?     // path CSV uploadé
  deviceId      String?
  device        Device?     @relation(fields: [deviceId], references: [id])
  logs          String[]
  outputPath    String?     // path header C ou .tflite
  metrics       Json?       // precision, recall, f1
  createdAt     DateTime    @default(now())
  completedAt   DateTime?
  activeOnDevices Device[]  @relation("activeModel")
}

enum ForgeStatus { PENDING RUNNING DONE FAILED }

// Ajouter dans Device :
// activeModelId String?
// activeModel   ForgeJob? @relation("activeModel", ...)
```

### 2.6 API REST complète

```
# Auth
POST   /api/auth/token

# Devices
GET    /api/devices
POST   /api/devices
GET    /api/devices/[id]
DELETE /api/devices/[id]

# Live (SSE)
GET    /api/events
GET    /api/events?deviceId=[id]

# History
GET    /api/readings?deviceId=&from=&to=&anomalyOnly=&limit=
GET    /api/readings/export?format=csv

# Forge Studio
GET    /api/forge/algorithms          → liste dynamique depuis `forge algorithms`
POST   /api/forge/upload              → multipart CSV → { filePath, preview }
POST   /api/forge/jobs                → créer job → { jobId }
GET    /api/forge/jobs/[id]           → ForgeJob + métriques
GET    /api/forge/jobs/[id]/logs      → SSE logs streaming
POST   /api/forge/jobs/[id]/deploy    → flash firmware
GET    /api/forge/jobs/[id]/download  → header C ou .tflite

# Health
GET    /health                        → { status, mqtt, db }
```

---

## 3. Ardent Forge — Worker Python

Forge est appelé **uniquement en subprocess** par Watch backend. La CLI reste disponible pour devs.

### 3.1 Commandes utilisées par Watch

```bash
uv run forge algorithms                        # → JSON liste algos + metadata
uv run forge run --config <path> --output <dir> --stream-logs
uv run forge deploy-manifest --config <path> --project-dir edge-core/examples/esp32/
uv run forge validate --manifest <path> --data <csv>
```

### 3.2 Metadata algorithmes (retournée par `forge algorithms`)

```json
[
  {
    "id": "zscore",
    "name": "Z-Score",
    "description": "Détecteur statistique univarié. Baseline stable. Export header C, zéro malloc.",
    "export_format": "c_header",
    "ram_bytes_estimate": "16–64",
    "params": [
      { "key": "window_size",  "type": "int",   "default": 64,  "min": 16,  "max": 256 },
      { "key": "threshold",    "type": "float", "default": 3.0, "min": 1.0, "max": 6.0 },
      { "key": "warmup",       "type": "int",   "default": 128, "min": 32,  "max": 512 }
    ],
    "suitable_for": ["vibration", "acceleration", "single-channel"]
  },
  {
    "id": "isolation_forest",
    "name": "Isolation Forest",
    "description": "Multivarié tabulaire. Pas d'hypothèse temporelle. Export header C.",
    "export_format": "c_header",
    "ram_bytes_estimate": "< 512",
    "params": [
      { "key": "n_estimators",  "type": "int",   "default": 50,   "min": 10,   "max": 200 },
      { "key": "contamination", "type": "float", "default": 0.05, "min": 0.01, "max": 0.2 }
    ],
    "suitable_for": ["multivariate", "tabular"]
  },
  {
    "id": "autoencoder",
    "name": "AutoEncoder LSTM",
    "description": "Réseau récurrent. Détection complexe séries temporelles. Export TFLite Micro.",
    "export_format": "tflite",
    "ram_bytes_estimate": "8000–32000",
    "params": [
      { "key": "sequence_len",  "type": "int",   "default": 30,  "min": 10, "max": 100 },
      { "key": "latent_dim",    "type": "int",   "default": 8,   "min": 4,  "max": 32  },
      { "key": "epochs",        "type": "int",   "default": 30,  "min": 5,  "max": 100 }
    ],
    "suitable_for": ["complex-temporal", "high-accuracy"],
    "requires": "uv sync --extra ml"
  },
  {
    "id": "threshold_adaptive",
    "name": "Seuil adaptatif EMA",
    "description": "Drift progressif. Très faible RAM. Export header C.",
    "export_format": "c_header",
    "ram_bytes_estimate": "32",
    "params": [
      { "key": "alpha",       "type": "float", "default": 0.05, "min": 0.001, "max": 0.5 },
      { "key": "band_factor", "type": "float", "default": 3.0,  "min": 1.0,   "max": 6.0 }
    ],
    "suitable_for": ["slow-drift", "temperature", "pressure"]
  }
]
```

---

## 4. Ardent Pulse — travaux restants (edge-core)

La base est solide. Finaliser :

### 4.1 HAL I2C ESP32 — platform_esp32.cpp

```cpp
// Câblage ESP32-CAM : SDA=GPIO13, SCL=GPIO14
ard_status_t hal_i2c_init(const hal_i2c_config_t *cfg) {
    Wire.begin(cfg->sda_pin, cfg->scl_pin);
    Wire.setClock(cfg->freq_hz);
    return ARD_OK;
}
ard_status_t hal_i2c_read(uint8_t dev_addr, uint8_t reg_addr,
                           uint8_t *buf, uint16_t len) {
    Wire.beginTransmission(dev_addr);
    Wire.write(reg_addr);
    if (Wire.endTransmission(false) != 0) return ARD_ERR_HAL;
    Wire.requestFrom((int)dev_addr, (int)len);
    for (uint16_t i = 0; i < len; i++) buf[i] = Wire.read();
    return ARD_OK;
}
```

### 4.2 Boucle firmware principale (examples/esp32/src/main.cpp)

```cpp
void loop() {
    float ax, ay, az;
    mpu6050_read_accel(&ax, &ay, &az);
    float magnitude = sqrtf(ax*ax + ay*ay + az*az);

    ard_result_t r = ard_zscore_update(&g_ctx, magnitude);

    if (millis() - last_pub > 100) {
        char payload[256];
        snprintf(payload, sizeof(payload),
            "{\"ts\":%lu,\"device\":\"%s\",\"channel\":\"accel/magnitude\","
            "\"value\":%.4f,\"anomaly\":%s,\"zscore\":%.2f,"
            "\"algo\":\"zscore\",\"model_id\":\"%s\"}",
            millis(), DEVICE_ID, magnitude,
            r == ARD_RESULT_ANOMALY ? "true" : "false",
            g_ctx.last_zscore, MODEL_ID);
        mqtt_publish("ardent/devices/" DEVICE_ID "/readings", payload);
        last_pub = millis();
    }
}
```

### 4.3 Config auto-générée lors du deploy (src/config.h)

```c
// Généré par Watch lors du déploiement — ne pas éditer manuellement
#define WIFI_SSID       "MonReseau"
#define WIFI_PASSWORD   "motdepasse"
#define MQTT_HOST       "192.168.1.100"   // ou ardent-ai.fr en prod
#define MQTT_PORT       1883
#define DEVICE_ID       "esp32cam-01"
#define MODEL_ID        "mpu6050_accel_v1"
```

### 4.4 Definition of Done — Pulse

- [ ] `make` dans `edge-core/tests/` → ≥ 400 tests verts
- [ ] `grep -r "malloc\|calloc\|realloc" edge-core/src/` → zéro résultat
- [ ] `gcc -std=c99 -Wall -Wextra -pedantic` → zéro warning
- [ ] Lecture MPU-6050 I2C réelle : ax/ay/az non nuls sur serial
- [ ] Secousse physique → ARD_RESULT_ANOMALY + message MQTT publié
- [ ] Message reçu dans Watch en < 2 secondes

---

## 5. Déploiement production

**Cible** : VPS Scaleway DEV1-S | **Domaine** : ardent-ai.fr

### docker-compose.yml (racine) — à compléter

```yaml
services:
  postgres:
    image: timescale/timescaledb:latest-pg16
    environment:
      POSTGRES_DB: ardent
      POSTGRES_USER: ardent
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: ["postgres_data:/var/lib/postgresql/data"]

  mosquitto:
    image: eclipse-mosquitto:2.0
    ports: ["1883:1883"]
    volumes: ["./mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf"]

  backend:
    build: ./platform-dashboard
    environment:
      DATABASE_URL: postgresql://ardent:${POSTGRES_PASSWORD}@postgres:5432/ardent
      MQTT_HOST: mosquitto
      MQTT_PORT: 1883
      FORGE_WORKER_PATH: /app/forge-worker
      EDGE_CORE_PATH: /app/edge-core
      AUTH_PASSWORD: ${AUTH_PASSWORD}
    volumes:
      - ./automl-pipeline:/app/forge-worker   # Forge accessible en subprocess
      - ./edge-core:/app/edge-core             # PlatformIO pour le flash
      - forge_outputs:/tmp/forge-outputs
    depends_on: [postgres, mosquitto]
    ports: ["3000:3000"]

  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./certbot/conf:/etc/letsencrypt
    depends_on: [backend]

volumes:
  postgres_data:
  forge_outputs:
```

### Definition of Done — Déploiement

- [ ] `docker-compose up` → stack prête en < 90s
- [ ] `https://ardent-ai.fr` → HTTPS valide, cert Let's Encrypt
- [ ] `GET /api/forge/algorithms` → JSON 4 algos
- [ ] `GET /health` → `{"status":"ok","mqtt":"connected","db":"ok"}`
- [ ] Page /monitor accessible sans erreur

---

## 6. CI/CD — GitHub Actions

```yaml
# .github/workflows/ci.yml
pulse-tests:
  - CMake build + CTest
  - grep zéro malloc
  - C99 strict sans warning

forge-tests:
  - uv sync + uv sync --extra ml
  - pytest automl-pipeline/tests/
  - forge run configs/demo_zscore.yaml
  - compiler le header généré en C99

watch-build:
  - docker-compose build
  - up + sleep 15 + curl /health + curl /api/forge/algorithms
  - down
```

---

## 7. Definition of Done global — scénario de démo sans terminal

**Pré-requis** : PC + Chrome + ESP32-CAM USB + MPU-6050 câblé + `docker-compose up`

```
1. Ouvrir http://localhost:3000
   → /devices — "Aucun device"

2. /devices → [+ Nouveau device]
   → Name: "ESP32-CAM Bureau", mqttClientId: "esp32cam-01"
   → [Enregistrer]

3. /forge → [Nouveau modèle]
   → Source : Synthétique
   → Algo : Z-Score | window=64 | threshold=3.0
   → [Lancer l'entraînement]
   → Logs streaming → "Done in 2.1s — precision=97.3%"
   → ✅ Prêt

4. [Déployer sur esp32cam-01] → méthode USB
   → [Compiler & Flasher]
   → Logs PlatformIO streaming → "Uploading... 100% — Done"
   → ✅ Flashé

5. /monitor → esp32cam-01 🟢 Online
   → accel/magnitude : NORMAL — sparkline vivant

6. Secouer le MPU-6050
   → ANOMALY ⚠️ — z=4.23 — en < 2 secondes
   → Pastille rouge, alerte dans le feed

7. (Validation) Terminal : uv run python scripts/demo_mqtt.py
   → Même comportement sans hardware

8. (Validation) make -C edge-core/tests → ≥ 400 passed
   (Validation) uv run pytest automl-pipeline/tests/ → All passed
```

**Critère ultime : étapes 1 à 6 depuis le browser uniquement.**

---

## 8. Règles Claude Code

**C99 (edge-core/)**
- Zéro malloc/calloc/realloc/free — vérifiable par grep
- Zéro dépendance externe — pas de lib tierce
- -std=c99 -Wall -Wextra -pedantic sans warning
- Tailles buffer = #define, jamais VLA
- Fonctions HAL retournent ard_status_t, jamais void pour les inits

**Python (automl-pipeline/)**
- Python ≥ 3.11, uv comme gestionnaire (pas pip direct)
- Type hints sur toutes les fonctions publiques
- Zéro appel réseau externe
- Headers C générés compilent C99 strict sans modification

**TypeScript (platform-dashboard/)**
- "strict": true dans tsconfig
- Zéro any explicite
- Zéro service tiers (analytics, telemetry, cloud)
- Liste algorithmes lue dynamiquement depuis l'API, jamais hardcodée en frontend

**Architecture**
- Forge = subprocess appelé par Watch backend, pas un service réseau séparé
- Tout secret via variable d'environnement, jamais dans le code
- Chaque composant testable indépendamment des deux autres

---

*Ardent SDK — github.com/Antoine005/ardent — contact@ardent-ai.fr*
*Spec v2.0 — 6 avril 2026 — Antoine Porte × Claude*

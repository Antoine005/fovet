# Fovet Vigie — Dashboard de supervision

Dashboard temps réel pour la supervision de flottes de capteurs embarqués.
Reçoit les lectures MQTT des ESP32, stocke en PostgreSQL, expose une API REST sécurisée et un flux SSE temps réel.

---

## Stack

| Couche | Technologie |
|---|---|
| Frontend | Next.js 16 (App Router), Recharts |
| API | Hono 4 (route catch-all `/api/[[...route]]`) |
| Base de données | PostgreSQL 18 + Prisma 7 (TimescaleDB en prod) |
| MQTT ingestion | mqtt.js → `startMqttIngestion()` au boot Next.js |
| Temps réel | SSE via EventEmitter in-process (`event-bus.ts`) |
| Auth | JWT HS256 — cookies httpOnly (pas de localStorage) |
| Tests | Vitest — 23 tests |

---

## Démarrage local

### Prérequis

- Node.js 20+
- PostgreSQL 18 (`fovet_vigie` base créée)
- Mosquitto broker local (ou distant)

### Installation

```bash
cd platform-dashboard
cp .env.example .env    # remplir les variables (voir ci-dessous)
npm install
npx prisma migrate deploy
npm run dev             # http://localhost:3000
```

### Variables d'environnement (`.env`)

| Variable | Description | Exemple |
|---|---|---|
| `DATABASE_URL` | Connexion PostgreSQL | `postgresql://antoine:mdp@localhost:5432/fovet_vigie` |
| `JWT_SECRET` | Clé HS256 (32+ chars) | `openssl rand -hex 32` |
| `DASHBOARD_PASSWORD` | Mot de passe login | `monmotdepasse` |
| `ALLOWED_ORIGIN` | CORS origin autorisée | `http://localhost:3000` |
| `MQTT_BROKER_URL` | URL broker Mosquitto | `mqtt://localhost:1883` |
| `MQTT_USERNAME` | Compte lecture MQTT | `fovet-vigie` |
| `MQTT_PASSWORD` | Mot de passe MQTT | `monmotdepasse` |

---

## Structure du code

```
platform-dashboard/
├── src/
│   ├── app/
│   │   ├── page.tsx                    ← Dashboard principal — vue Flotte / Détail / Santé / Worker
│   │   ├── login/page.tsx              ← Page de connexion
│   │   ├── api/[[...route]]/route.ts   ← API Hono (toutes les routes REST)
│   │   └── instrumentation.ts          ← Boot hook — démarre startMqttIngestion()
│   ├── components/
│   │   ├── ReadingChart.tsx            ← Graphe Recharts avec SSE + fallback polling
│   │   ├── AlertList.tsx               ← Liste alertes + acquittement + pagination cursor
│   │   ├── DeviceCard.tsx              ← Carte dispositif (vue détail)
│   │   ├── FleetPanel.tsx              ← Sparkline compacte + badge alerte (vue flotte)
│   │   ├── FleetHealth.tsx             ← Santé flotte cross-module (alertes par module par dispositif)
│   │   └── WorkerDetail.tsx            ← Vue individuelle cross-module (résumé capteurs + export rapport)
│   └── lib/
│       ├── api.ts                      ← Routes Hono + middleware cookieAuth
│       ├── api-client.ts               ← Fetch wrapper (credentials: include)
│       ├── event-bus.ts                ← EventEmitter singleton MQTT → SSE
│       ├── mqtt-ingestion.ts           ← Subscribe MQTT → insertion PostgreSQL + emit
│       └── prisma.ts                   ← PrismaClient singleton
├── prisma/
│   └── schema.prisma                   ← Modèles Device, Reading (BigInt id, sensorType, value2), Alert (ptiType, alertModule, alertLevel)
├── src/__tests__/
│   └── api.test.ts                     ← 52 tests Vitest
└── .env.example                        ← Template variables d'environnement
```

---

## API REST

Toutes les routes sont préfixées `/api/`. Les routes marquées JWT requièrent le cookie `fovet_token`.

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | Non | État de l'API |
| `POST` | `/api/auth/token` | Non | Login — retourne cookie httpOnly `fovet_token` |
| `POST` | `/api/auth/logout` | Non | Supprime le cookie de session |
| `GET` | `/api/devices` | JWT | Liste tous les dispositifs |
| `POST` | `/api/devices` | JWT | Enregistrer un nouveau dispositif |
| `GET` | `/api/devices/:id/readings` | JWT | Lectures paginées (cursor-based) |
| `GET` | `/api/devices/:id/stream` | JWT | Flux SSE temps réel des nouvelles lectures |
| `GET` | `/api/devices/:id/alerts` | JWT | Alertes non acquittées |
| `PATCH` | `/api/alerts/:id/ack` | JWT | Acquitter une alerte |
| `GET` | `/api/fleet/health` | JWT | Santé flotte cross-module (alertes par module par dispositif) |
| `GET` | `/api/workers/:deviceId/summary` | JWT | Résumé individuel cross-module (lectures HR + TEMP + alertes récentes) |

### Pagination des lectures

```
GET /api/devices/:id/readings?limit=100&cursor=<bigint-id>
```

Réponse :
```json
{
  "data": [
    { "id": "1234", "value": 23.4, "mean": 23.1, "zScore": 0.71, "isAnomaly": false, "timestamp": "..." }
  ],
  "pagination": {
    "limit": 100,
    "hasMore": true,
    "nextCursor": "1133"
  }
}
```

- `cursor` : id de la dernière lecture reçue → retourne les lectures antérieures (ordre DESC)
- `hasMore: true` → passer `nextCursor` comme `cursor` pour la page suivante
- Les ids sont sérialisés en `String` (BigInt → JSON)

### Flux SSE temps réel

```
GET /api/devices/:id/stream
```

Événements émis :
- `event: reading` — nouvelle lecture reçue via MQTT (même format que `data[]`)
- `event: ping` — heartbeat toutes les 30 s

`ReadingChart` se connecte automatiquement en SSE et repasse en polling 5 s si la connexion échoue.

**Authentification :**

```bash
# Login
curl -c cookies.txt -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"password":"monmotdepasse"}'

# Route protégée
curl -b cookies.txt http://localhost:3000/api/devices
```

---

## MQTT — Format des messages

Les ESP32 publient sur le topic `fovet/devices/<DEVICE_ID>/readings` :

```json
{
  "value": 23.4,
  "mean": 23.1,
  "stddev": 0.42,
  "zScore": 0.71,
  "anomaly": false
}
```

Vigie souscrit à `fovet/devices/+/readings`, insère chaque reading, crée une alerte si `anomaly: true`, et émet sur le bus interne pour diffuser aux clients SSE connectés.

---

## Architecture temps réel (SSE)

```
ESP32 → MQTT → mqtt-ingestion.ts → prisma.reading.create()
                                  → emitReading() → EventEmitter (event-bus.ts)
                                                          ↓
                                GET /devices/:id/stream ← subscribeToReadings()
                                          ↓
                                   Browser EventSource (ReadingChart.tsx)
```

Le singleton `global.__fovetEventBus` survit aux hot-reloads Next.js en développement.

---

## Schéma de base de données

```prisma
model Device {
  id           String    @id @default(cuid())
  mqttClientId String    @unique
  name         String
  location     String?
  active       Boolean   @default(true)
  readings     Reading[]
  alerts       Alert[]
  createdAt    DateTime  @default(now())
}

model Reading {
  id         BigInt   @id @default(autoincrement())  // BigInt pour cursor pagination
  deviceId   String
  value      Float                     // Valeur principale (temp °C, BPM, accel g)
  value2     Float?                    // Valeur secondaire (humidité % pour TEMP)
  mean       Float
  stddev     Float
  zScore     Float
  isAnomaly  Boolean
  sensorType String?                   // "IMU" | "HR" | "TEMP"
  timestamp  DateTime
}

model Alert {
  id             String    @id @default(cuid())
  deviceId       String
  value          Float
  zScore         Float
  threshold      Float
  ptiType        String?   // "FALL" | "MOTIONLESS" | "SOS" — null pour alertes non-PTI
  alertModule    String?   // module responsable : null pour alertes z-score legacy
  alertLevel     String?   // "WARN" | "DANGER" | "COLD" | "CRITICAL"
  acknowledged   Boolean   @default(false)
  acknowledgedAt DateTime?
  timestamp      DateTime
}
```

---

## Vue Santé flotte — U1 (alertes unifiées)

La vue **Santé** (`FleetHealth.tsx`) est accessible via l'onglet **Santé** dans le dashboard. Elle agrège l'état de santé de chaque dispositif par module d'alerte.

### Route `/api/fleet/health`

```json
[
  {
    "id": "clxxxx",
    "name": "Pierre Dupont",
    "location": "Zone A",
    "mqttClientId": "pti-001",
    "modules": {
      "PTI":     { "status": "CRITICAL", "count": 1, "lastAt": "2026-03-15T10:00:00.000Z" },
      "FATIGUE": { "status": "WARN",     "count": 2, "lastAt": "2026-03-15T09:55:00.000Z" },
      "THERMAL": { "status": "OK",       "count": 0, "lastAt": null }
    }
  }
]
```

### Champs schema étendus (migration `add_alert_module_sensor_type`)

- `Reading.sensorType` — module producteur (ex: `"IMU"`, `"HR"`, `"TEMP"`)
- `Reading.value2` — valeur secondaire (ex: humidité % pour capteur TEMP)
- `Alert.alertModule` — module responsable de l'alerte
- `Alert.alertLevel` (`"WARN" | "DANGER" | "COLD" | "CRITICAL"`) — niveau Sentinelle

### Payload MQTT étendu (Sentinelle → Vigie)

```json
{
  "value": 38.5,
  "mean": 35.1,
  "stddev": 1.2,
  "zScore": 2.8,
  "anomaly": false,
  "sensorType": "TEMP",
  "level": "DANGER",
  "value2": 75.0
}
```

Les champs `sensorType`, `level`, `value2` sont optionnels — les firmwares existants fonctionnent sans modification.

---

## Tests

```bash
npm run test          # Vitest — 52 tests
npm run test:coverage # Avec couverture
```

Tests couverts : health, auth/login, rate limiting (429), JWT validation, Zod validation, CRUD devices/alerts, pagination cursor (hasMore, nextCursor, erreur cursor invalide), acquittement alertes.

---

## Sécurité

| Mesure | Implémentation |
|---|---|
| Auth JWT | Cookie httpOnly — élimine le vol XSS |
| Rate limiting | 5 req / 15 min sur `/auth/token` par IP (in-memory en dev, Redis prévu en prod) |
| CORS | Restreint à `ALLOWED_ORIGIN` |
| CSP | Security headers stricts |
| Validation | Zod sur `POST /devices` et `POST /auth/token` |
| MQTT | Auth login/mdp (Mosquitto) + ACL par topic |

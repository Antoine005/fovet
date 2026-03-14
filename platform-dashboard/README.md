# Fovet Vigie — Dashboard de supervision

Dashboard temps réel pour la supervision de flottes de capteurs embarqués.
Reçoit les lectures MQTT des ESP32, stocke en PostgreSQL, expose une API REST sécurisée.

---

## Stack

| Couche | Technologie |
|---|---|
| Frontend | Next.js 16 (App Router), Recharts |
| API | Hono 4 (route catch-all `/api/[[...route]]`) |
| Base de données | PostgreSQL 18 + Prisma 7 (TimescaleDB en prod) |
| MQTT ingestion | Paho MQTT → `startMqttIngestion()` au boot Next.js |
| Auth | JWT HS256 — cookies httpOnly (pas de localStorage) |
| Tests | Vitest 18 — 19 tests |

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
│   │   ├── page.tsx                    ← Dashboard principal (graphes, alertes)
│   │   ├── login/page.tsx              ← Page de connexion
│   │   ├── api/[[...route]]/route.ts   ← API Hono (toutes les routes REST)
│   │   └── instrumentation.ts          ← Boot hook — démarre startMqttIngestion()
│   └── lib/
│       ├── api.ts                      ← Routes Hono + middleware cookieAuth
│       ├── api-client.ts               ← Fetch wrapper (credentials: include)
│       ├── mqtt-ingestion.ts           ← Subscribe MQTT → insertion PostgreSQL
│       └── prisma.ts                   ← PrismaClient singleton
├── prisma/
│   └── schema.prisma                   ← Modèles Device, Reading, Alert
├── src/__tests__/
│   └── api.test.ts                     ← 19 tests Vitest
└── .env.example                        ← Template variables d'environnement
```

---

## API REST

Toutes les routes sont préfixées `/api/`.

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/token` | Non | Login — retourne cookie httpOnly `fovet_token` |
| `POST` | `/api/auth/logout` | Non | Supprime le cookie de session |
| `GET` | `/api/health` | Non | État de l'API |
| `GET` | `/api/devices` | JWT | Liste tous les dispositifs |
| `POST` | `/api/devices` | JWT | Enregistrer un nouveau dispositif |
| `GET` | `/api/devices/:id/readings` | JWT | Dernières lectures d'un dispositif |
| `GET` | `/api/alerts` | JWT | Alertes récentes (anomalies) |

**Authentification :** cookie httpOnly `fovet_token` (JWT HS256, durée 7 jours).

```bash
# Obtenir un token
curl -c cookies.txt -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"password":"monmotdepasse"}'

# Appeler une route protégée
curl -b cookies.txt http://localhost:3000/api/devices
```

---

## MQTT — Format des messages

Les ESP32 publient sur le topic :
```
fovet/devices/<DEVICE_ID>/readings
```

Payload JSON attendu :
```json
{
  "value": 23.4,
  "mean": 23.1,
  "stddev": 0.42,
  "zScore": 0.71,
  "anomaly": false
}
```

Vigie souscrit à `fovet/devices/+/readings`, insère chaque reading en base, et crée une alerte si `anomaly: true`.

---

## Schéma de base de données

```prisma
model Device {
  id           String    @id @default(cuid())
  mqttClientId String    @unique
  name         String?
  readings     Reading[]
  alerts       Alert[]
  createdAt    DateTime  @default(now())
}

model Reading {
  id        String   @id @default(cuid())
  deviceId  String
  value     Float
  mean      Float?
  stddev    Float?
  zScore    Float?
  anomaly   Boolean  @default(false)
  timestamp DateTime @default(now())
}

model Alert {
  id        String   @id @default(cuid())
  deviceId  String
  value     Float
  zScore    Float?
  timestamp DateTime @default(now())
  ack       Boolean  @default(false)
}
```

---

## Tests

```bash
npm run test          # Vitest — 19 tests
npm run test:coverage # Avec couverture
```

Les tests couvrent : health, auth/login, rate limiting, JWT validation, Zod validation, CRUD devices/alerts, acknowledgement alertes.

---

## Sécurité

| Mesure | Implémentation |
|---|---|
| Auth JWT | Cookie httpOnly — élimine le vol XSS |
| Rate limiting | 5 req / 15 min sur `/auth/token` par IP |
| CORS | Restreint à `ALLOWED_ORIGIN` |
| CSP | Headers stricts — `unsafe-eval` uniquement en dev |
| Validation | Zod sur `POST /devices` et `POST /auth/token` |
| MQTT | Auth par login/mdp (Mosquitto) + ACL par topic |

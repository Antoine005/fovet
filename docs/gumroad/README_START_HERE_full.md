# Ardent Full Stack — Start Here

**Pulse SDK + Forge AutoML + Watch Dashboard + Docker Compose.**

The complete sovereign anomaly detection stack: from sensor data to supervised fleet dashboard, on-premise, no cloud dependency.

---

## Architecture

```
Sensor (ESP32) → MQTT (Mosquitto) → Watch Dashboard (Next.js)
                                          ↑
                              Forge (AutoML calibration)
                                          ↓
                              Pulse SDK (firmware header)
```

---

## Quick start — demo without hardware (5 minutes)

Requirements: Docker, Python 3.11+, uv (`pip install uv`)

```bash
# 1. Start the full stack
docker-compose up -d

# 2. Create a demo device
curl -c /tmp/c.txt -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" -d '{"password":"demo"}'
curl -b /tmp/c.txt -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo ESP32","mqttClientId":"demo-001","location":"Lab"}'

# 3. Run synthetic sensor stream (IMU + HR + TEMP + auto-anomalies)
uv run --with paho-mqtt --with python-dotenv scripts/demo_mqtt.py

# 4. Open http://localhost:3000 — watch anomalies appear in real time
```

---

## Production deployment (VPS)

```bash
# Fill environment variables
cp platform-dashboard/.env.example platform-dashboard/.env

# Start with Docker Compose (production profile)
docker-compose -f docker-compose.yml up -d

# Optional: Nginx reverse proxy + Let's Encrypt
# See docs/architecture.md for full VPS setup guide
```

---

## Forge — calibrate on your real data

```bash
cd automl-pipeline
uv sync --extra ml

# Run on your CSV data
uv run forge run --config configs/mpu6050_accel.yaml

# Deploy calibrated header to firmware
uv run forge deploy-manifest --config configs/mpu6050_accel.yaml \
    --project-dir ../edge-core/examples/esp32/zscore_demo
```

Output: `ard_zscore_config.h` — ready to `#include` in your firmware.
Detection active **from the first sample**, no warm-up.

---

## What's included

```
ardent-full-stack/
├── README_START_HERE.md         ← this file
├── edge-core/                   ← Ardent Pulse SDK (C99)
├── automl-pipeline/             ← Ardent Forge (Python AutoML)
│   └── configs/                 ← YAML configs: MPU-6050, MAX30102, DHT22
├── platform-dashboard/          ← Ardent Watch (Next.js + Hono + PostgreSQL)
├── mosquitto/                   ← MQTT broker config
├── scripts/
│   └── demo_mqtt.py             ← synthetic sensor stream
├── docker-compose.yml           ← one-command local stack
├── Quick_Start_Guide.pdf
└── LICENCE_LGPL.txt
```

---

## MQTT message format

Topic: `ardent/{device_id}/{channel}`

```json
{
  "ts": 1743955200000,
  "device": "esp32cam-01",
  "channel": "accel",
  "value": 12.47,
  "anomaly": true,
  "zscore": 4.23
}
```

---

## Definition of Done

The stack is working when:

1. `docker-compose up` → Watch at `localhost:3000` in < 60s
2. `python scripts/demo_mqtt.py` → anomalies appear in dashboard < 2s
3. Flash ESP32-CAM → serial: `[ARDENT] Pulse initialized`
4. Physical MPU-6050 shake → dashboard shows `ANOMALY` < 2s
5. `make test-edge` → `391+ tests passed`
6. `pytest automl-pipeline/tests/` → all passed

---

## Support

- GitHub: github.com/Antoine005/ardent
- Email: contact@ardent-ai.fr
- Issues: github.com/Antoine005/ardent/issues

**License:** LGPL v3 for non-commercial / open-source use.
Commercial licensing (production deployments, defense, industrial): contact@ardent-ai.fr

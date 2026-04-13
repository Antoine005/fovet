# Ardent Pulse SDK — Start Here

**You have 5 minutes before your first anomaly detection runs on your PC.**

No hardware needed. No cloud account. No registration.

---

## Step 1 — Run the tests (proof it works)

Requirements: GCC + Make (Linux/Mac native, Windows via MSYS2 or WSL)

```bash
cd edge-core/tests
make
# Expected output: 391/391 tests passed (13 suites)
```

That's it. The SDK is working.

---

## Step 2 — Integrate in your project (3 lines)

Copy `edge-core/include/` and `edge-core/src/` into your project, then:

```c
#include "ardent/zscore.h"

ArdentZScore detector;
ard_zscore_init(&detector, 3.0f, 30);  // 3σ threshold, 30-sample warm-up

while (1) {
    float sample = read_your_sensor();
    if (ard_zscore_update(&detector, sample)) {
        // anomaly detected
    }
}
```

RAM footprint: **24 bytes**. Latency: **< 1 µs @ 80 MHz**.

---

## Step 3 — Flash to ESP32 (PlatformIO)

```bash
cd edge-core/examples/esp32/zscore_demo
cp src/config.h.example src/config.h   # fill WiFi + MQTT credentials
pio run --target upload
pio device monitor --baud 115200
```

Requires PlatformIO CLI (`pip install platformio`).

---

## What's included

```
ardent-pulse-sdk/
├── README_START_HERE.md         ← this file
├── edge-core/
│   ├── include/ardent/          ← public API headers
│   │   ├── zscore.h             ← Z-Score detector (Welford)
│   │   ├── drift.h              ← EWMA Drift detector
│   │   ├── mad.h                ← MAD detector (robust)
│   │   └── hal/                 ← HAL interfaces
│   ├── src/                     ← implementation (C99 pure)
│   ├── tests/                   ← 391 unit tests (native gcc)
│   └── examples/esp32/          ← ready-to-flash ESP32 examples
├── Quick_Start_Guide.pdf        ← this README as PDF
└── LICENCE_LGPL.txt
```

---

## The 3 detectors

| Detector | Best for | RAM |
|---|---|---|
| Z-Score (Welford) | Sudden spikes, voltage surges, shocks | 24 bytes |
| EWMA Drift | Slow baseline drift, aging sensors, bearing wear | 24 bytes |
| MAD | Noisy signals, vibration, ECG, non-gaussian | ~200 bytes (ring buffer) |

**Run Z-Score + EWMA Drift in parallel** — they catch complementary failure modes.

---

## ESP32 wiring (MPU-6050)

```
MPU-6050    ESP32-CAM
VCC      →  3.3V
GND      →  GND
SDA      →  GPIO13
SCL      →  GPIO14
AD0      →  GND  (I2C address 0x68)
```

---

## Support

- GitHub: github.com/Antoine005/ardent
- Email: contact@ardent-ai.fr
- Issues: github.com/Antoine005/ardent/issues

**License:** LGPL v3 for non-commercial / open-source use.
Commercial licensing (production deployments, defense, industrial): contact@ardent-ai.fr

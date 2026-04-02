# Ardent Pulse — SDK embarqué C99

SDK C/C++ pour la détection d'anomalies en temps réel sur microcontrôleurs.
Zéro malloc. Zéro dépendance. Testable sur PC avant de toucher le hardware.

---

## Démarrage rapide

### Tests natifs sur PC (gcc — MSYS2 requis sur Windows)

```bash
# Depuis un terminal MSYS2 MINGW64
export PATH="/c/msys64/mingw64/bin:/c/msys64/usr/bin:$PATH"
cd edge-core/tests
make
```

Résultats attendus :

| Suite | Tests |
|---|---|
| test_zscore | 41/41 |
| test_drift | 28/28 |
| test_mad | 28/28 |
| test_forge_integration | 10/10 |
| test_biosignal_hal | 30/30 |
| test_i2c_hal | 39/39 |
| test_mpu6050 | 33/33 |
| test_mpu6050_hal | 25/25 |
| test_pti_profile | 24/24 |
| test_max30102_hal | 23/23 |
| test_fatigue_profile | 27/27 |
| test_dht22_hal | 43/43 |
| test_temp_profile | 40/40 |
| **Total** | **391/391** |

Ou depuis la racine du monorepo :

```bash
make test-edge   # lance la suite complète
```

### Build PlatformIO ESP32-CAM

```bash
cd edge-core/examples/esp32/imu_zscore
cp src/config.h.example src/config.h   # remplir WiFi/MQTT credentials
pio run --target upload
pio device monitor --baud 115200
```

---

## Structure

```
edge-core/
├── include/ardent/
│   ├── zscore.h              ← API publique Z-Score detector
│   ├── drift.h               ← API publique EWMA Drift detector
│   ├── mad.h                 ← API publique MAD detector (Streaming MAD)
│   ├── model_manifest.h      ← Format manifest Forge → firmware (doc)
│   ├── hal/
│   │   ├── hal_uart.h        ← Interface UART (print, init)
│   │   ├── hal_gpio.h        ← Interface GPIO (mode, read, write)
│   │   ├── hal_adc.h         ← Interface ADC (read channel)
│   │   ├── hal_time.h        ← Interface temps (ms, delay)
│   │   ├── hal_i2c.h         ← Interface I2C (init, read, write, probe)
│   │   ├── ard_biosignal_hal.h ← Registre HAL biosignaux (IMU, HR, TEMP, ECG)
│   │   ├── mpu6050_hal.h     ← Driver HAL MPU-6050 (accéléromètre/gyroscope I2C)
│   │   ├── max30102_hal.h    ← Driver HAL MAX30102 (fréquence cardiaque + SpO₂)
│   │   └── dht22_hal.h       ← Driver HAL DHT22 (température + humidité, single-wire)
│   ├── drivers/
│   │   └── mpu6050.h         ← Driver MPU-6050 générique (±2/4/8/16g)
│   └── profiles/
│       ├── pti_profile.h     ← Profil PTI : détection chute/immobilité/SOS
│       ├── fatigue_profile.h ← Profil Fatigue : classification HRV 3 niveaux + LED RGB
│       └── temp_profile.h    ← Profil Thermique : WBGT Stull (2011), 4 niveaux
├── src/
│   ├── zscore.c              ← Algorithme de Welford (C99 pur)
│   ├── drift.c               ← Double EWMA fast/slow
│   ├── mad.c                 ← MAD detector (ring buffer + tri par insertion)
│   ├── biosignal_hal.c       ← Registre HAL biosignaux (4 slots statiques)
│   ├── mpu6050_hal.c         ← Pilote MPU-6050 I2C via callbacks injectés
│   ├── max30102_hal.c        ← Pilote MAX30102 I2C : Pan-Tompkins simplifié + SpO₂
│   ├── dht22_hal.c           ← Pilote DHT22 single-wire via callbacks pin/pulse/delay
│   ├── drivers/
│   │   └── mpu6050.c         ← Driver MPU-6050 générique
│   ├── profiles/
│   │   ├── pti_profile.c     ← Profil PTI (chute + immobilité + SOS)
│   │   ├── fatigue_profile.c ← Profil Fatigue (EMA BPM + SpO₂ + LED RGB)
│   │   └── temp_profile.c    ← Profil Thermique (EMA temp + WBGT + COLD/WARN/DANGER)
│   └── platform/
│       └── platform_esp32.cpp ← Implémentation HAL ESP32 (UART, GPIO, ADC, time, I2C)
├── tests/
│   ├── test_zscore.c         ← 41 tests : Welford, warm-up, saturation, windowed mode
│   ├── test_drift.c          ← 28 tests : EWMA, complémentarité zscore/drift
│   ├── test_mad.c            ← 28 tests : ring buffer, médiane, MAD, score, détection
│   ├── test_forge_integration.c ← 10 tests : validation header Forge → Pulse
│   ├── test_i2c_hal.c        ← 39 tests : HAL I2C mock (probe, read, write, erreurs)
│   ├── test_mpu6050.c        ← 33 tests : driver MPU-6050 (init, ranges, read, NACK)
│   ├── test_biosignal_hal.c  ← 30 tests : registre, register/read/reset, 4 sources
│   ├── test_mpu6050_hal.c    ← 25 tests : I2C mock, WHO_AM_I, ±2g, rate, magnitude
│   ├── test_pti_profile.c    ← 24 tests : chute/immobilité/SOS, debounce, callbacks
│   ├── test_max30102_hal.c   ← 23 tests : init, FIFO, warmup, BPM 60/80, SpO₂, reset
│   ├── test_fatigue_profile.c ← 27 tests : niveaux OK/ALERT/CRITICAL, EMA, SpO₂, LED
│   ├── test_dht22_hal.c      ← 43 tests : pulse mock, T+/T−/T=0, checksum, range, HAL
│   └── test_temp_profile.c   ← 40 tests : WBGT, SAFE/WARN/DANGER/COLD, EMA, callbacks
├── examples/
│   └── esp32/
│       ├── smoke_test/       ← Premier flash : sinus + ±5σ, sans WiFi/MQTT
│       ├── zscore_demo/      ← Sinus synthétique + Z-Score + EWMA Drift + MQTT → Watch
│       ├── fire_detection/   ← OV2640 RGB565 : 3× Z-Score (R/ratio/variance) → Watch
│       ├── person_detection/ ← OV2640 + TFLite MobileNetV1 + Z-Score temporel → Watch
│       └── imu_zscore/       ← MPU-6050 I2C + Z-Score sur magnitude → Watch
└── library.json              ← Manifest PlatformIO (ardent-pulse)
```

---

## API publique — Z-Score detector

### Struct

```c
#include "ardent/zscore.h"

typedef struct {
    uint32_t count;           // Nombre de samples traités (sature à UINT32_MAX)
    float    mean;            // Moyenne courante (Welford)
    float    M2;              // Somme des carrés des écarts (Welford)
    float    threshold_sigma; // Seuil d'anomalie (ex: 3.0f = 3σ)
    uint32_t min_samples;     // Warm-up : détection suspendue avant ce nombre de samples
    uint32_t window_size;     // Mode fenêtré : 0 = désactivé, N = reset toutes les N mesures
} ArdentZScore;
// sizeof(ArdentZScore) == 24 bytes
```

### Fonctions

```c
// Initialiser le détecteur
// min_samples : warm-up avant activation (minimum forcé à 2)
void ard_zscore_init(ArdentZScore *ctx, float threshold_sigma, uint32_t min_samples);

// Ajouter un sample — retourne true si anomalie détectée
bool ard_zscore_update(ArdentZScore *ctx, float sample);

// Accesseurs en lecture seule
float    ard_zscore_get_mean(const ArdentZScore *ctx);
float    ard_zscore_get_stddev(const ArdentZScore *ctx);
uint32_t ard_zscore_get_count(const ArdentZScore *ctx);

// Réinitialiser les stats (conserve threshold_sigma, min_samples et window_size)
void ard_zscore_reset(ArdentZScore *ctx);

// Mode fenêtré (optionnel) : reset automatique toutes les window_size mesures
// window_size == 0 désactive le mode fenêtré (comportement par défaut)
// Retourne false si window_size > 0 et window_size < min_samples (invalide)
bool ard_zscore_set_window(ArdentZScore *ctx, uint32_t window_size);
```

### Exemple minimal

```c
#include "ardent/zscore.h"

ArdentZScore detector;
ard_zscore_init(&detector, 3.0f, 30);  // seuil 3σ, warm-up 30 samples

while (1) {
    float sample = read_sensor();
    if (ard_zscore_update(&detector, sample)) {
        trigger_alert();
    }
}
```

### Mode fenêtré — adaptation à la dérive lente

Par défaut, Welford accumule un historique infini : la moyenne absorbe les dérives lentes et le détecteur devient aveugle. Le mode fenêtré force un reset périodique pour que la baseline suive le régime actuel.

```c
ArdentZScore detector;
ard_zscore_init(&detector, 3.0f, 30);      // seuil 3σ, warm-up 30 samples
ard_zscore_set_window(&detector, 500U);    // reset toutes les 500 mesures

// La baseline s'adapte automatiquement toutes les 500 mesures.
while (1) {
    float sample = read_sensor();
    if (ard_zscore_update(&detector, sample)) {
        trigger_alert();
    }
}
```

> **Note :** après chaque reset automatique il y a une période de warm-up (`min_samples` mesures sans détection). Pour un capteur à 10 Hz avec `window_size=500` et `min_samples=30`, la période aveugle est de 3 secondes toutes les 50 secondes.

---

## API publique — EWMA Drift detector

Détecte les dérives lentes (vieillissement capteur, changement de régime) en comparant deux EWMA (fast/slow). Complémentaire au Z-Score qui ne détecte que les pics ponctuels.

### Struct

```c
#include "ardent/drift.h"

typedef struct {
    float    ewma_fast;   // EWMA rapide (suit le signal de près)
    float    ewma_slow;   // EWMA lente (référence stable)
    float    alpha_fast;  // Coefficient lissage rapide
    float    alpha_slow;  // Coefficient lissage lent
    float    threshold;   // Seuil sur |ewma_fast - ewma_slow|
    uint32_t count;       // Nombre de samples (sature à UINT32_MAX)
} ArdentDrift;
// sizeof(ArdentDrift) == 24 bytes
```

### Fonctions

```c
void ard_drift_init(ArdentDrift *ctx, float alpha_fast, float alpha_slow, float threshold);
bool ard_drift_update(ArdentDrift *ctx, float sample);
float ard_drift_get_fast(const ArdentDrift *ctx);
float ard_drift_get_slow(const ArdentDrift *ctx);
float ard_drift_get_magnitude(const ArdentDrift *ctx); // |fast - slow|
void ard_drift_reset(ArdentDrift *ctx);
```

### Exemple combiné Z-Score + Drift

```c
#include "ardent/zscore.h"
#include "ardent/drift.h"

ArdentZScore spike_detector;
ArdentDrift  drift_detector;

ard_zscore_init(&spike_detector, 3.0f, 30);
ard_drift_init(&drift_detector, 0.1f, 0.01f, 0.5f);

while (1) {
    float sample = read_sensor();
    bool spike = ard_zscore_update(&spike_detector, sample);
    bool drift = ard_drift_update(&drift_detector, sample);
    if (spike) handle_spike();
    if (drift)  handle_drift();
}
```

---

## API publique — MAD detector

Détecte les anomalies via la Médiane Absolue des Déviations sur une fenêtre glissante. Plus robuste que le Z-Score aux outliers : la médiane n'est pas influencée par les valeurs extrêmes.

```c
#include "ardent/mad.h"

ArdentMAD ctx;
ard_mad_init(&ctx, 32, 3.5f);        // fenêtre 32 samples, seuil 3.5 MAD

while (1) {
    float sample = read_sensor();
    if (ard_mad_update(&ctx, sample)) {
        trigger_alert();
    }
    // Accesseurs : ard_mad_get_median(), ard_mad_get_mad(), ard_mad_score()
}
```

---

## API publique — Biosignal HAL

Registre de fonctions de lecture pour les sources de biosignaux. Permet aux algorithmes d'accéder aux capteurs sans couplage direct au hardware.

### Sources supportées

| Enum | Valeur | Capteur |
|---|---|---|
| `ARD_SOURCE_IMU` | 0 | Accéléromètre/gyroscope (IMU) |
| `ARD_SOURCE_HR` | 1 | Fréquence cardiaque |
| `ARD_SOURCE_TEMP` | 2 | Température corporelle |
| `ARD_SOURCE_ECG` | 3 | ECG |

### Fonctions

```c
#include "ardent/hal/ard_biosignal_hal.h"

// Enregistrer un driver pour une source
int ard_hal_biosignal_register(ard_biosignal_source_t source, ard_hal_read_fn_t fn);

// Lire un sample depuis la source enregistrée
// Retourne ARD_HAL_OK (0), ARD_HAL_ERR_NULL (-1), ARD_HAL_ERR_NOREG (-3)
int ard_hal_biosignal_read(ard_biosignal_source_t source, ard_biosignal_sample_t *out);

// Effacer tous les drivers enregistrés (tests uniquement)
void ard_hal_biosignal_reset(void);
```

### Struct sample

```c
typedef union {
    struct { float ax, ay, az, gx, gy, gz; } imu;   // 24 bytes
    struct { float bpm, spo2, rmssd; }        hr;    // 12 bytes
    struct { float celsius; }                 temp;   //  4 bytes
    struct { float mv; }                      ecg;    //  4 bytes
} ard_biosignal_value_t;

typedef struct {
    ard_biosignal_source_t source;
    uint32_t               timestamp_ms;
    ard_biosignal_value_t  value;
} ard_biosignal_sample_t;              // sizeof == 32 bytes
```

---

## API publique — Driver MPU-6050

Pilote HAL pour le MPU-6050 (accéléromètre 3 axes ±2/4/8/16g, gyroscope 3 axes ±250°/s).
L'accès I2C est entièrement injecté via callbacks — pas de dépendance à Wire.h.

### Fonctions

```c
#include "ardent/hal/mpu6050_hal.h"

// Injecter les callbacks I2C (appeler avant ard_hal_imu_init)
void ard_mpu6050_set_i2c(ard_i2c_write_fn_t write_fn, ard_i2c_read_fn_t read_fn);

// Initialiser le MPU-6050 à l'adresse i2c_addr (0x68 ou 0x69)
// Retourne ARD_HAL_OK, ARD_MPU_ERR_I2C (-1), ARD_MPU_ERR_ID (-2)
int ard_hal_imu_init(uint8_t i2c_addr);

// Lire un sample IMU (ax/ay/az en g, gx/gy/gz en °/s)
int ard_hal_imu_read(ard_biosignal_sample_t *out);

// Calculer |a| = sqrt(ax²+ay²+az²)
float ard_hal_imu_get_magnitude(const ard_biosignal_sample_t *s);

// Configurer la fréquence d'échantillonnage (10–200 Hz)
int ard_hal_imu_set_sample_rate(uint32_t hz);
```

### Câblage ESP32-CAM (imu_zscore example)

```
MPU-6050  →  ESP32-CAM
VCC       →  3.3V
GND       →  GND
SDA       →  GPIO13
SCL       →  GPIO14
AD0       →  GND (adresse I2C = 0x68)
```

### Exemple ESP32

```cpp
#include "ardent/hal/mpu6050_hal.h"

// Callbacks Wire.h
static int esp32_i2c_write(uint8_t addr, uint8_t reg, uint8_t data) {
    Wire.beginTransmission(addr);
    Wire.write(reg); Wire.write(data);
    return Wire.endTransmission() == 0 ? 0 : -1;
}
static int esp32_i2c_read(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
    Wire.beginTransmission(addr); Wire.write(reg);
    Wire.endTransmission(false);
    Wire.requestFrom(addr, len);
    for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
    return 0;
}

// Initialisation
hal_i2c_init(13, 14, 400000);           // SDA=GPIO13, SCL=GPIO14, 400 kHz
ard_mpu6050_set_i2c(esp32_i2c_write, esp32_i2c_read);
ard_hal_imu_init(0x68);
ard_hal_imu_set_sample_rate(25);        // 25 Hz

// Lecture
ard_biosignal_sample_t s;
ard_hal_biosignal_read(ARD_SOURCE_IMU, &s);
float mag = ard_hal_imu_get_magnitude(&s); // |a| en g
```

---

## API publique — Profil PTI (Protection du Travailleur Isolé)

Détection en temps réel de trois alertes critiques à partir d'un accéléromètre MPU-6050.

| Alerte | Déclenchement |
|---|---|
| `ARD_ALERT_FALL` | Score modèle chute > seuil sur fenêtre glissante 2 s |
| `ARD_ALERT_MOTIONLESS` | `\|a\| < 0.1 g` pendant > 30 s consécutives |
| `ARD_ALERT_SOS` | GPIO bouton actif-bas enfoncé |

### Initialisation et boucle

```c
#include "ardent/profiles/pti_profile.h"

ard_pti_ctx_t ctx;
ard_pti_config_t cfg = ard_pti_default_config();
// cfg.fall_threshold        = 0.85f
// cfg.motion_threshold_g    = 0.1f
// cfg.motionless_timeout_ms = 30000U
// cfg.sleep_between_ticks_ms = 40U  (25 Hz)

ard_pti_init(&ctx, &cfg,
    my_alert_handler,   // void fn(ard_pti_alert_t, void*)
    my_fall_score_fn,   // float fn(const float*, uint32_t) → [0,1]
    my_gpio_read_fn,    // int fn(uint8_t pin) → 0=enfoncé
    my_sleep_fn,        // void fn(uint32_t ms) — NULL pour désactiver
    user_data);

while (1) { ard_pti_tick(&ctx); }
```

---

## API publique — Driver MAX30102

Pilote HAL pour le MAX30102 (HR/SpO₂). Pan-Tompkins simplifié sur fenêtre 100 samples (4 s @ 25 Hz).

| Constante | Valeur |
|---|---|
| `ARD_MAX30102_I2C_ADDR` | `0x57` |
| `ARD_MAX30102_WINDOW_SIZE` | `100` |

```c
#include "ardent/hal/max30102_hal.h"

ard_max30102_set_i2c(write_fn, read_fn);
ard_max30102_init();   // s'enregistre dans ARD_SOURCE_HR

ard_biosignal_sample_t s;
int rc = ard_hal_biosignal_read(ARD_SOURCE_HR, &s);
if (rc == ARD_HAL_OK) {
    float bpm  = s.value.hr.bpm;
    float spo2 = s.value.hr.spo2;
}
```

---

## API publique — Driver DHT22

Pilote HAL pour le DHT22 (température + humidité). Single-wire 40 bits. GPIO/timing entièrement injectés.

```c
#include "ardent/hal/dht22_hal.h"

ard_dht22_io_t io = {
    .pin_write = esp32_gpio_write,
    .pulse_us  = esp32_pulse_us,
    .delay_us  = esp32_delay_us,
};
ard_dht22_set_io(&io);
ard_dht22_init();   // s'enregistre dans ARD_SOURCE_TEMP

ard_biosignal_sample_t s;
int rc = ard_hal_biosignal_read(ARD_SOURCE_TEMP, &s);
if (rc == ARD_HAL_OK) {
    float t = s.value.temp.celsius;
    float h = s.value.temp.humidity_pct;
}
```

---

## Démarrage avec stats précalibrées (Forge → Pulse)

Ardent Forge calibre les statistiques hors-ligne et exporte un header C prêt à l'emploi :

```bash
# Calibrer avec Forge
uv run forge run --config configs/mon_capteur.yaml
# Export : models/mon_capteur/ard_zscore_config.h
```

```c
// Fichier généré par Forge — inclure dans le firmware
#include "ardent/zscore.h"

static ArdentZScore ard_zscore_value = {
    .count            = 10000U,
    .mean             = 23.847f,
    .M2               = 1842.3f,
    .threshold_sigma  = 3.0f,
    .min_samples      = 0U,   // pré-calibré : actif dès le premier sample
    .window_size      = 0U,
};
// Remplace ard_zscore_init() — détection active immédiatement, sans warm-up
```

---

## HAL — Hardware Abstraction Layer

| Interface | Header | Fonctions clés |
|---|---|---|
| UART | `hal_uart.h` | `hal_uart_init()`, `hal_uart_print()` |
| GPIO | `hal_gpio.h` | `hal_gpio_set_mode()`, `hal_gpio_read()`, `hal_gpio_write()` |
| ADC | `hal_adc.h` | `hal_adc_read()` |
| Temps | `hal_time.h` | `hal_time_ms()`, `hal_delay_ms()` |
| I2C | `hal_i2c.h` | `hal_i2c_init()`, `hal_i2c_write_reg()`, `hal_i2c_read_reg()`, `hal_i2c_probe()` |

**Ajouter un nouveau MCU :** créer `src/platform/platform_<mcu>.c` qui implémente toutes les fonctions `hal_*`.

---

## Exemples ESP32-CAM

| Exemple | Capteur | Détecteur | Prérequis |
|---|---|---|---|
| `smoke_test` | Synthétique | Z-Score | Aucun (premier flash) |
| `zscore_demo` | Synthétique | Z-Score + EWMA Drift | WiFi + MQTT + Watch |
| `fire_detection` | OV2640 (caméra) | 3× Z-Score (R/ratio/var) | WiFi + MQTT + Watch |
| `person_detection` | OV2640 (caméra) | TFLite MobileNetV1 + Z-Score | WiFi + MQTT + Watch |
| `imu_zscore` | MPU-6050 I2C | Z-Score sur magnitude | MPU-6050 câblé + WiFi + MQTT + Watch |

Tous utilisent `board=esp32dev` — voir [Hardware gotchas](../CLAUDE.md) pour le détail.

---

## Demo ESP32-CAM (zscore_demo)

La démo fait tourner **Z-Score et EWMA Drift en parallèle** sur un signal sinus synthétique :

| Événement injecté | Fréquence | Détecté par |
|---|---|---|
| Spike 5σ soudain | toutes les 200 mesures | **Z-Score** ✓ — Drift ✗ |
| Rampe lente +0.05/sample × 100 samples | toutes les 600 mesures | **Drift** ✓ — Z-Score ✗ |

**Fichier `src/config.h` à créer** (ne pas commiter) :

```c
#define WIFI_SSID       "mon_wifi"
#define WIFI_PASSWORD   "mon_mdp"
#define MQTT_BROKER     "192.168.1.x"    // IP LAN du poste qui fait tourner Mosquitto
#define MQTT_PORT       1883
#define MQTT_USER       "ardent-device"
#define MQTT_PASSWORD   "mot_de_passe"
#define DEVICE_ID       "esp32-cam-001"
```

---

## Contraintes

| Contrainte | Valeur |
|---|---|
| Norme C | C99 pur |
| Malloc | Interdit dans les algos |
| RAM / détecteur | < 4 KB (Z-Score : 24 bytes, Drift : 24 bytes, MAD : 2 × fenêtre × 4 bytes) |
| Latence | < 1 ms / sample @ 80 MHz (mesuré : ~0.04 µs) |
| Préfixe fonctions | `ard_` (public), `hal_` (HAL) |
| Nommage fichiers | snake_case |
| Testabilité | gcc natif (sans hardware) |

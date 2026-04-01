# Fovet Sentinelle — SDK embarqué C99

SDK C/C++ pour la détection d'anomalies en temps réel sur microcontrôleurs.
Zéro malloc. Zéro dépendance. Testable sur PC avant de toucher le hardware.

---

## Démarrage rapide

### Tests natifs sur PC (gcc)

```bash
cd edge-core/tests
export PATH="/c/msys64/mingw64/bin:$PATH"   # MSYS2 / Windows uniquement
make
# Résultats attendus :
# test_zscore             : 41/41 passed
# test_drift              : 28/28 passed
# test_forge_integration  : 10/10 passed
# test_biosignal_hal      : 30/30 passed
# test_mpu6050_hal        : 25/25 passed
# test_pti_profile        : 24/24 passed
# test_max30102_hal       : 23/23 passed
# test_fatigue_profile    : 27/27 passed
# test_dht22_hal          : 43/43 passed
# test_temp_profile       : 40/40 passed
```

### Build PlatformIO ESP32-CAM

```bash
cd edge-core/examples/esp32/zscore_demo
cp src/config.h.example src/config.h   # remplir WiFi/MQTT credentials
pio run --target upload
pio device monitor --baud 115200
```

---

## Structure

```
edge-core/
├── include/fovet/
│   ├── zscore.h              ← API publique Z-Score detector
│   ├── drift.h               ← API publique EWMA Drift detector
│   ├── hal/
│   │   ├── hal_uart.h        ← Interface UART (print, init)
│   │   ├── hal_gpio.h        ← Interface GPIO (mode, read, write)
│   │   ├── hal_adc.h         ← Interface ADC (read channel)
│   │   ├── hal_time.h        ← Interface temps (ms, delay)
│   │   ├── fovet_biosignal_hal.h ← Registre HAL biosignaux (IMU, HR, TEMP, ECG)
│   │   ├── mpu6050_hal.h     ← Driver HAL MPU-6050 (accéléromètre/gyroscope I2C)
│   │   ├── max30102_hal.h    ← Driver HAL MAX30102 (fréquence cardiaque + SpO₂)
│   │   └── dht22_hal.h       ← Driver HAL DHT22 (température + humidité, single-wire)
│   └── profiles/
│       ├── pti_profile.h     ← Profil PTI : détection chute/immobilité/SOS
│       ├── fatigue_profile.h ← Profil Fatigue : classification HRV 3 niveaux + LED RGB
│       └── temp_profile.h    ← Profil Thermique : WBGT Stull (2011), 4 niveaux (H3.3)
├── src/
│   ├── zscore.c              ← Algorithme de Welford (C99 pur)
│   ├── drift.c               ← Double EWMA fast/slow
│   ├── biosignal_hal.c       ← Registre HAL biosignaux (4 slots statiques)
│   ├── mpu6050_hal.c         ← Pilote MPU-6050 I2C via callbacks injectés (monitoring)
│   ├── max30102_hal.c        ← Pilote MAX30102 I2C : Pan-Tompkins simplifié + SpO₂
│   ├── dht22_hal.c           ← Pilote DHT22 single-wire via callbacks pin/pulse/delay
│   ├── profiles/
│   │   ├── pti_profile.c     ← Profil PTI (chute + immobilité + SOS)
│   │   ├── fatigue_profile.c ← Profil Fatigue (EMA BPM + SpO₂ + LED RGB)
│   │   └── temp_profile.c    ← Profil Thermique (EMA temp + WBGT + COLD/WARN/DANGER)
│   ├── mad.c                 ← MAD detector (ring buffer + tri par insertion)
│   ├── drivers/
│   │   └── mpu6050.c         ← Driver MPU-6050 générique (accéléromètre I2C ±2/4/8/16g)
│   └── platform/
│       └── platform_esp32.cpp ← Implémentation HAL (UART, GPIO, ADC, time, I2C)
├── tests/
│   ├── test_zscore.c         ← 41 tests : Welford, warm-up, saturation, windowed mode
│   ├── test_drift.c          ← 28 tests : EWMA, complémentarité zscore/drift
│   ├── test_forge_integration.c ← 12 tests : validation header Forge→Sentinelle
│   ├── test_mad.c            ← 28 tests : ring buffer, médiane, MAD, score, détection
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
│       ├── zscore_demo/      ← Sinus synthétique + Z-Score + EWMA Drift + MQTT → Vigie
│       ├── fire_detection/   ← OV2640 RGB565 : 3× Z-Score (R/ratio/variance) → Vigie
│       ├── person_detection/ ← OV2640 + TFLite MobileNetV1 + Z-Score temporel → Vigie
│       └── imu_zscore/       ← MPU-6050 I2C + Z-Score sur magnitude → Vigie
└── library.json              ← Manifest PlatformIO (fovet-sentinelle)
```

---

## API publique — Z-Score detector

### Struct

```c
#include "fovet/zscore.h"

typedef struct {
    uint32_t count;           // Nombre de samples traités (sature à UINT32_MAX)
    float    mean;            // Moyenne courante (Welford)
    float    M2;              // Somme des carrés des écarts (Welford)
    float    threshold_sigma; // Seuil d'anomalie (ex: 3.0f = 3σ)
    uint32_t min_samples;     // Warm-up : détection suspendue avant ce nombre de samples
    uint32_t window_size;     // Mode fenêtré : 0 = désactivé, N = reset toutes les N mesures
} FovetZScore;
// sizeof(FovetZScore) == 24 bytes
```

### Fonctions

```c
// Initialiser le détecteur
// min_samples : warm-up avant activation (minimum forcé à 2)
void fovet_zscore_init(FovetZScore *ctx, float threshold_sigma, uint32_t min_samples);

// Ajouter un sample — retourne true si anomalie détectée
bool fovet_zscore_update(FovetZScore *ctx, float sample);

// Accesseurs en lecture seule
float    fovet_zscore_get_mean(const FovetZScore *ctx);
float    fovet_zscore_get_stddev(const FovetZScore *ctx);
uint32_t fovet_zscore_get_count(const FovetZScore *ctx);

// Réinitialiser les stats (conserve threshold_sigma, min_samples et window_size)
void fovet_zscore_reset(FovetZScore *ctx);

// Mode fenêtré (optionnel) : reset automatique toutes les window_size mesures
// window_size == 0 désactive le mode fenêtré (comportement par défaut)
// Retourne false si window_size > 0 et window_size < min_samples (invalide)
bool fovet_zscore_set_window(FovetZScore *ctx, uint32_t window_size);
```

### Exemple minimal

```c
#include "fovet/zscore.h"

FovetZScore detector;
fovet_zscore_init(&detector, 3.0f, 30);  // seuil 3σ, warm-up 30 samples

while (1) {
    float sample = read_sensor();
    if (fovet_zscore_update(&detector, sample)) {
        trigger_alert();
    }
}
```

### Mode fenêtré — adaptation à la dérive lente

Par défaut, Welford accumule un historique infini : la moyenne absorbe les dérives lentes et le détecteur devient aveugle. Le mode fenêtré force un reset périodique pour que la baseline suive le régime actuel.

```c
#include "fovet/zscore.h"

FovetZScore detector;
fovet_zscore_init(&detector, 3.0f, 30);      // seuil 3σ, warm-up 30 samples
fovet_zscore_set_window(&detector, 500U);     // reset toutes les 500 mesures

// La baseline s'adapte automatiquement toutes les 500 mesures.
// Utile pour capteurs à longue durée de vie (température, pression ambiante).
while (1) {
    float sample = read_sensor();
    if (fovet_zscore_update(&detector, sample)) {
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
#include "fovet/drift.h"

typedef struct {
    float    ewma_fast;   // EWMA rapide (suit le signal de près)
    float    ewma_slow;   // EWMA lente (référence stable)
    float    alpha_fast;  // Coefficient lissage rapide
    float    alpha_slow;  // Coefficient lissage lent
    float    threshold;   // Seuil sur |ewma_fast - ewma_slow|
    uint32_t count;       // Nombre de samples (sature à UINT32_MAX)
} FovetDrift;
// sizeof(FovetDrift) == 24 bytes
```

### Fonctions

```c
// Initialiser le détecteur
// alpha_fast : [0,1] — plus grand = plus réactif (ex: 0.1)
// alpha_slow : [0,1] — plus petit = plus stable (ex: 0.01)
// threshold  : seuil sur |ewma_fast - ewma_slow|
void fovet_drift_init(FovetDrift *ctx, float alpha_fast, float alpha_slow, float threshold);

// Ajouter un sample — retourne true si dérive détectée
bool fovet_drift_update(FovetDrift *ctx, float sample);

// Accesseurs
float fovet_drift_get_fast(const FovetDrift *ctx);
float fovet_drift_get_slow(const FovetDrift *ctx);
float fovet_drift_get_magnitude(const FovetDrift *ctx); // |fast - slow|

// Réinitialiser les stats (conserve alphas et threshold)
void fovet_drift_reset(FovetDrift *ctx);
```

### Exemple combiné Z-Score + Drift

```c
#include "fovet/zscore.h"
#include "fovet/drift.h"

FovetZScore spike_detector;
FovetDrift  drift_detector;

fovet_zscore_init(&spike_detector, 3.0f, 30);
fovet_drift_init(&drift_detector, 0.1f, 0.01f, 0.5f);

while (1) {
    float sample = read_sensor();
    bool spike = fovet_zscore_update(&spike_detector, sample);
    bool drift = fovet_drift_update(&drift_detector, sample);
    if (spike) handle_spike();
    if (drift)  handle_drift();
}
```

---

## API publique — Biosignal HAL

Registre de fonctions de lecture pour les sources de biosignaux. Permet aux algorithmes d'accéder aux capteurs sans couplage direct au hardware.

### Sources supportées

| Enum | Valeur | Capteur |
|---|---|---|
| `FOVET_SOURCE_IMU` | 0 | Accéléromètre/gyroscope (IMU) |
| `FOVET_SOURCE_HR` | 1 | Fréquence cardiaque |
| `FOVET_SOURCE_TEMP` | 2 | Température corporelle |
| `FOVET_SOURCE_ECG` | 3 | ECG |

### Fonctions

```c
#include "fovet/hal/fovet_biosignal_hal.h"

// Enregistrer un driver pour une source
// fn : fonction de lecture → remplit fovet_biosignal_sample_t
int fovet_hal_biosignal_register(fovet_biosignal_source_t source, fovet_hal_read_fn_t fn);

// Lire un sample depuis la source enregistrée
// Retourne FOVET_HAL_OK (0), FOVET_HAL_ERR_NULL (-1), FOVET_HAL_ERR_NOREG (-3)
int fovet_hal_biosignal_read(fovet_biosignal_source_t source, fovet_biosignal_sample_t *out);

// Effacer tous les drivers enregistrés (tests uniquement)
void fovet_hal_biosignal_reset(void);
```

### Struct sample

```c
typedef union {
    struct { float ax, ay, az, gx, gy, gz; } imu;            // 24 bytes
    struct { float bpm, spo2, rmssd; }        hr;             // 12 bytes
    struct { float celsius; }                 temp;            //  4 bytes
    struct { float mv; }                      ecg;             //  4 bytes
} fovet_biosignal_value_t;

typedef struct {
    fovet_biosignal_source_t source;    // Source du sample
    uint32_t                 timestamp_ms;
    fovet_biosignal_value_t  value;
} fovet_biosignal_sample_t;             // sizeof == 32 bytes
```

---

## API publique — Driver MPU-6050

Pilote HAL pour le MPU-6050 (accéléromètre 3 axes ±2g, gyroscope 3 axes ±250°/s).
L'accès I2C est entièrement injecté via callbacks — pas de dépendance à Wire.h.

### Fonctions

```c
#include "fovet/hal/mpu6050_hal.h"

// Injecter les callbacks I2C (appeler avant fovet_hal_imu_init)
void fovet_mpu6050_set_i2c(fovet_i2c_write_fn_t write_fn, fovet_i2c_read_fn_t read_fn);

// Initialiser le MPU-6050 à l'adresse i2c_addr (0x68 ou 0x69)
// Vérifie WHO_AM_I, configure DLPF, s'enregistre dans le biosignal HAL
// Retourne FOVET_HAL_OK, FOVET_MPU_ERR_I2C (-1), FOVET_MPU_ERR_ID (-2)
int fovet_hal_imu_init(uint8_t i2c_addr);

// Lire un sample IMU (ax/ay/az en g, gx/gy/gz en °/s)
int fovet_hal_imu_read(fovet_biosignal_sample_t *out);

// Calculer |a| = sqrt(ax²+ay²+az²)
float fovet_hal_imu_get_magnitude(const fovet_biosignal_sample_t *s);

// Configurer la fréquence d'échantillonnage (10–200 Hz)
// SMPLRT_DIV = 1000/hz - 1 (DLPF actif → fréquence gyroscope interne = 1 kHz)
int fovet_hal_imu_set_sample_rate(uint32_t hz);
```

### Exemple ESP32

```c
#include "fovet/hal/mpu6050_hal.h"

// Callbacks Wire.h
static int esp32_i2c_write(uint8_t addr, uint8_t reg, const uint8_t *buf, uint8_t len) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    for (uint8_t i = 0; i < len; i++) Wire.write(buf[i]);
    return Wire.endTransmission() == 0 ? 0 : -1;
}
static int esp32_i2c_read(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.endTransmission(false);
    Wire.requestFrom(addr, len);
    for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
    return 0;
}

// Initialisation
Wire.begin();
fovet_mpu6050_set_i2c(esp32_i2c_write, esp32_i2c_read);
fovet_hal_imu_init(0x68);
fovet_hal_imu_set_sample_rate(25); // 25 Hz

// Lecture
fovet_biosignal_sample_t s;
fovet_hal_biosignal_read(FOVET_SOURCE_IMU, &s);
float mag = fovet_hal_imu_get_magnitude(&s); // |a| en g
```

---

## API publique — Profil PTI (Protection du Travailleur Isolé)

Détection en temps réel de trois alertes critiques pour les travailleurs isolés, à partir d'un accéléromètre MPU-6050. Conçu pour tourner dans une boucle principale à ~25 Hz.

| Alerte | Déclenchement |
|---|---|
| `FOVET_ALERT_FALL` | Score modèle chute > seuil sur fenêtre glissante 2 s |
| `FOVET_ALERT_MOTIONLESS` | `|a| < 0.1 g` pendant > 30 s consécutives |
| `FOVET_ALERT_SOS` | GPIO bouton actif-bas enfoncé |

### Configuration

```c
#include "fovet/profiles/pti_profile.h"

fovet_pti_config_t cfg = fovet_pti_default_config();
// Valeurs par défaut :
// cfg.fall_threshold        = 0.85f     // Seuil score modèle chute [0,1]
// cfg.motion_threshold_g    = 0.1f      // Seuil immobilité (g)
// cfg.motionless_timeout_ms = 30000U    // Délai avant alerte immobilité (ms)
// cfg.sos_gpio_pin          = 0U        // Pin GPIO bouton SOS (actif-bas)
// cfg.sleep_between_ticks_ms = 40U      // Pause fin de tick (25 Hz)
```

### Initialisation et boucle

```c
fovet_pti_ctx_t ctx;

fovet_pti_init(
    &ctx,
    &cfg,
    my_alert_handler,     // void fn(fovet_pti_alert_t, void*)
    my_fall_score_fn,     // float fn(const float*, uint32_t) → score [0,1]
    my_gpio_read_fn,      // int   fn(uint8_t pin) → 0=enfoncé, 1=relâché
    my_sleep_fn,          // void  fn(uint32_t ms) — NULL pour désactiver
    user_data
);

// Boucle principale (~25 Hz)
while (1) {
    int rc = fovet_pti_tick(&ctx);
    if (rc != FOVET_HAL_OK) handle_imu_error();
}
```

### Séquence d'un tick (`fovet_pti_tick`)

```
1. Lit IMU via fovet_hal_biosignal_read(FOVET_SOURCE_IMU)
2. Calcule |a| = sqrt(ax²+ay²+az²)
3. Pousse |a| dans la fenêtre circulaire (50 samples = 2 s @ 25 Hz)
4. Si fenêtre pleine → fall_score_fn() ; si score > seuil → FOVET_ALERT_FALL
5. Si |a| < motion_threshold_g → vérifie timeout → FOVET_ALERT_MOTIONLESS
   Sinon → réinitialise horloge immobilité
6. Si gpio_read_fn(pin) == 0 → FOVET_ALERT_SOS (actif-bas)
7. Si sleep_fn != NULL → sleep(sleep_between_ticks_ms)
```

### Intégration du modèle TFLite Micro (Forge)

```c
// Généré par Fovet Forge / FallDetectionPipeline.export()
#include "fall_detection_model.h"

float my_fall_score_fn(const float *mag, uint32_t n) {
    // Normalise avec scaler_mean / scaler_std (depuis fall_detection_config.json)
    // Lance l'inférence TFLite Micro sur les 10 features extraites
    // Retourne le score sigmoid [0.0, 1.0]
    return tflite_infer(mag, n);
}
```

---

## API publique — Driver MAX30102

Pilote HAL pour le MAX30102 (capteur optique Maxim Integrated — fréquence cardiaque + SpO₂).
Algorithme Pan-Tompkins simplifié sur fenêtre glissante de 100 samples (4 s @ 25 Hz).
L'accès I2C est entièrement injecté via callbacks — même interface que le MPU-6050.

### Constantes

| Constante | Valeur | Description |
|---|---|---|
| `FOVET_MAX30102_I2C_ADDR` | `0x57` | Adresse I2C fixe |
| `FOVET_MAX30102_PART_ID` | `0x15` | Valeur attendue du registre PART_ID (0xFF) |
| `FOVET_MAX30102_WINDOW_SIZE` | `100` | Fenêtre glissante (4 s @ 25 Hz) |
| `FOVET_MAX30102_SAMPLE_RATE` | `25` | Fréquence de sortie après moyennage FIFO (Hz) |

### Codes d'erreur

| Code | Valeur | Description |
|---|---|---|
| `FOVET_HR_ERR_I2C` | `-1` | Erreur de communication I2C |
| `FOVET_HR_ERR_ID` | `-2` | PART_ID inattendu (≠ 0x15) |
| `FOVET_HR_ERR_NODATA` | `-4` | FIFO vide ou fenêtre en cours de warm-up |

### Fonctions

```c
#include "fovet/hal/max30102_hal.h"

// Injecter les callbacks I2C (appeler avant fovet_max30102_init)
void fovet_max30102_set_i2c(fovet_i2c_write_fn_t write_fn, fovet_i2c_read_fn_t read_fn);

// Initialiser le MAX30102
// Séquence : vérification PART_ID → reset logiciel → config SpO2 25 Hz →
//            reset FIFO → enregistrement FOVET_SOURCE_HR dans le biosignal HAL
// Retourne FOVET_HAL_OK, FOVET_HR_ERR_I2C (-1), FOVET_HR_ERR_ID (-2)
int fovet_max30102_init(void);

// Lire un sample depuis le FIFO et mettre à jour BPM / SpO₂
// out->value.hr.bpm    = BPM courant (0 si pas encore de pics)
// out->value.hr.spo2   = SpO₂ en % [0, 100]
// out->value.hr.rmssd  = intervalle RR moyen en ms (0 si pas de pics)
// Retourne FOVET_HAL_OK, FOVET_HR_ERR_NODATA, FOVET_HR_ERR_I2C
int fovet_hal_hr_read(fovet_biosignal_sample_t *out);

// Retourner le dernier SpO₂ calculé (0.0 avant la première computation)
float fovet_max30102_get_spo2(void);

// Réinitialiser l'état du driver (fenêtre, BPM, SpO₂) — pour les tests uniquement
void fovet_max30102_reset(void);
```

### Algorithme interne

**BPM — Pan-Tompkins simplifié :**
1. Signal IR : suppression DC (moyenne Welford sur la fenêtre)
2. Seuil adaptatif : `threshold = min_AC + 0.4 × (max_AC - min_AC)`
3. Détection des maxima locaux au-dessus du seuil, période réfractaire 280 ms (7 samples)
4. BPM = 60 000 / RR_moyen_ms, limité à [30, 220] BPM

**SpO₂ — ratio des ratios :**
```
R = (RMS_red / DC_red) / (RMS_ir / DC_ir)
SpO₂ = 110 - 25 × R     (formule empirique Maxim)
SpO₂ ∈ [0, 100] %
```

### Exemple ESP32

```c
#include "fovet/hal/max30102_hal.h"

// Callbacks Wire.h
static int esp32_i2c_write(uint8_t addr, uint8_t reg, const uint8_t *buf, uint8_t len) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    for (uint8_t i = 0; i < len; i++) Wire.write(buf[i]);
    return Wire.endTransmission() == 0 ? 0 : -1;
}
static int esp32_i2c_read(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.endTransmission(false);
    Wire.requestFrom(addr, len);
    for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
    return 0;
}

// Initialisation
Wire.begin();
fovet_max30102_set_i2c(esp32_i2c_write, esp32_i2c_read);
fovet_max30102_init();  // Enregistre automatiquement FOVET_SOURCE_HR

// Lecture (dans la boucle principale ~25 Hz)
fovet_biosignal_sample_t s;
int rc = fovet_hal_biosignal_read(FOVET_SOURCE_HR, &s);
if (rc == FOVET_HAL_OK) {
    float bpm  = s.value.hr.bpm;    // BPM courant
    float spo2 = s.value.hr.spo2;   // SpO₂ %
    float rr   = s.value.hr.rmssd;  // RR moyen (ms)
}
```

---

## API publique — Driver DHT22 (H3.1)

Pilote HAL pour le DHT22 (capteur AmbiMate — température ambiante + humidité relative).
Protocole single-wire 40 bits.  L'accès GPIO + timing est entièrement injecté via callbacks — testable PC sans hardware.
Enregistre `FOVET_SOURCE_TEMP` dans le biosignal HAL (`value.temp.celsius` + `value.temp.humidity_pct`).

### Codes d'erreur

| Code | Valeur | Description |
|---|---|---|
| `FOVET_DHT22_ERR_TIMEOUT`  | `-1` | Timeout pulse — capteur ne répond pas ou ligne bloquée |
| `FOVET_DHT22_ERR_CHECKSUM` | `-2` | Trame corrompue |
| `FOVET_DHT22_ERR_RANGE`    | `-3` | Valeur hors plage physique (T: -40..80 °C, H: 0..100 %) |
| `FOVET_DHT22_ERR_IO`       | `-4` | Callbacks non injectés — appeler `fovet_dht22_set_io()` d'abord |

### Plages valides

| Paramètre | Min | Max |
|---|---|---|
| Température | -40 °C | 80 °C |
| Humidité | 0 % | 100 % |

### Callbacks injectés

```c
typedef struct {
    void     (*pin_write)(uint8_t level);                         // Forcer ligne DATA HIGH/LOW
    uint32_t (*pulse_us)(uint8_t expected_level, uint32_t timeout_us); // Mesure durée impulsion µs
    void     (*delay_us)(uint32_t us);                            // Attente µs
} fovet_dht22_io_t;
```

`pulse_us` retourne 0 en cas de timeout → le driver interprète 0 comme `FOVET_DHT22_ERR_TIMEOUT`.

### Fonctions

```c
#include "fovet/hal/dht22_hal.h"

// Injecter les callbacks GPIO + timing (appeler avant fovet_dht22_init)
void fovet_dht22_set_io(const fovet_dht22_io_t *io);

// Initialiser le driver et enregistrer FOVET_SOURCE_TEMP dans le biosignal HAL
// Retourne FOVET_HAL_OK, FOVET_DHT22_ERR_IO
int fovet_dht22_init(void);

// Lire un sample directement (sans passer par le biosignal HAL)
// out->celsius / out->humidity_pct
// Retourne FOVET_HAL_OK, FOVET_DHT22_ERR_TIMEOUT/-CHECKSUM/-RANGE/-IO
int fovet_dht22_read(fovet_dht22_reading_t *out);

// Réinitialiser l'état du driver (tests uniquement)
void fovet_dht22_reset(void);
```

### Intégration firmware

```c
// 1. Injecter les callbacks
fovet_dht22_io_t io = {
    .pin_write = esp32_gpio_write,   // digitalWrite(DHT_PIN, level)
    .pulse_us  = esp32_pulse_us,     // pulseIn() wrapper
    .delay_us  = esp32_delay_us,     // delayMicroseconds()
};
fovet_dht22_set_io(&io);

// 2. Enregistrer dans le biosignal HAL
fovet_dht22_init();

// 3. Lire depuis le biosignal HAL (0.5 Hz max)
fovet_biosignal_sample_t s;
int rc = fovet_hal_biosignal_read(FOVET_SOURCE_TEMP, &s);
if (rc == FOVET_HAL_OK) {
    float t = s.value.temp.celsius;       // Température ambiante (°C)
    float h = s.value.temp.humidity_pct;  // Humidité relative (%)
}
```

---

## API publique — Profil Fatigue (H2.3)

Classification HRV-based en 3 niveaux de fatigue à partir du MAX30102. Tourne à ~25 Hz.
Compatible avec les seuils exportés par `FatigueHRVPipeline` (Forge H2.2).

### Niveaux

| Niveau | Valeur | Condition | LED |
|---|---|---|---|
| `FOVET_FATIGUE_LEVEL_UNKNOWN` | 0 | Warm-up (< 25 samples) | off |
| `FOVET_FATIGUE_LEVEL_OK` | 1 | BPM < hr_ok ET SpO₂ ≥ spo2_critical | verte |
| `FOVET_FATIGUE_LEVEL_ALERT` | 2 | hr_ok ≤ BPM ≤ hr_alert | ambre |
| `FOVET_FATIGUE_LEVEL_CRITICAL` | 3 | BPM > hr_alert OU SpO₂ < 94 % | rouge |

### Configuration (valeurs par défaut)

```c
cfg.hr_ok                  = 72.0f   // BPM < 72 → OK
cfg.hr_alert               = 82.0f   // BPM > 82 → CRITICAL
cfg.spo2_critical          = 94.0f   // SpO₂ < 94 % → CRITICAL (prioritaire)
cfg.ema_alpha              = 0.05f   // EMA ~20-sample memory (résistance aux pics)
cfg.warmup_samples         = 25U     // 1 s à 25 Hz avant première classification
cfg.sleep_between_ticks_ms = 40U     // ~25 Hz
```

### Initialisation et boucle

```c
#include "fovet/profiles/fatigue_profile.h"

fovet_fatigue_ctx_t ctx;

// Seuils depuis FatigueHRVPipeline.export() (optionnel)
// #include "fatigue_hrv_thresholds.h"
// cfg.hr_ok    = FOVET_FATIGUE_HR_OK;
// cfg.hr_alert = FOVET_FATIGUE_HR_ALERT;

fovet_fatigue_init(
    &ctx,
    NULL,               // NULL = defaults
    my_alert_fn,        // void fn(fovet_fatigue_level_t, void*)  — changement de niveau
    my_led_fn,          // void fn(fovet_fatigue_level_t)          — LED RGB chaque tick
    my_sleep_fn,        // void fn(uint32_t ms) — NULL pour désactiver
    user_data
);

// Boucle principale (~25 Hz)
while (1) {
    int rc = fovet_fatigue_tick(&ctx);
    if (rc < 0) handle_hr_error(rc);
}
```

### Séquence d'un tick (`fovet_fatigue_tick`)

```
1. fovet_hal_biosignal_read(FOVET_SOURCE_HR) → BPM + SpO₂
2. NODATA (capteur en warm-up) → skip, return OK
3. EMA BPM : ema = α×bpm + (1-α)×ema  (α = 0.05)
4. Classification : UNKNOWN / OK / ALERT / CRITICAL
5. SpO₂ < spo2_critical → force CRITICAL (prioritaire)
6. Changement de niveau → alert_fn()
7. Niveau connu → led_fn()
8. sleep_fn(40 ms)
```

---

## Algorithme de Welford

Calcul de la moyenne et de la variance en un seul passage, sans malloc, numériquement stable :

```
mean_n = mean_{n-1} + (x - mean_{n-1}) / n
M2_n   = M2_{n-1}  + (x - mean_{n-1}) * (x - mean_n)
stddev = sqrt(M2 / (n - 1))           // variance d'échantillon
z      = |x - mean| / stddev
anomaly = z > threshold_sigma  AND  n >= min_samples
```

Le compteur `count` sature à `UINT32_MAX` (~4 milliards) pour éviter l'overflow.

---

## Démarrage avec stats précalibrées (Forge → Sentinelle)

Fovet Forge calibre les statistiques hors-ligne et exporte un header C prêt à l'emploi :

```c
// Généré par : uv run forge run --config configs/mon_capteur.yaml
// Fichier    : models/fovet_zscore_config.h

#include "fovet/zscore.h"

static FovetZScore fovet_zscore_value = {
    .count            = 10000U,
    .mean             = 23.847f,
    .M2               = 1842.3f,
    .threshold_sigma  = 3.0f,
    .min_samples      = 0U,   // précalibré : détection active dès le premier sample
    .window_size      = 0U,   // infini — Forge précalibre sur données propres
};
```

**Workflow :**
```
1. Collecter données propres (CSV ou MQTT)
2. uv run forge run --config configs/mon_capteur.yaml
3. Copier models/fovet_zscore_config.h dans src/
4. #include "fovet_zscore_config.h"  ← remplace fovet_zscore_init()
```

---

## HAL — Hardware Abstraction Layer

Les algorithmes n'appellent jamais directement les registres hardware.
Tout passe par des fonctions `hal_*` définies dans `include/fovet/hal/`.

| Interface | Fichier | Fonctions clés |
|---|---|---|
| UART | `hal_uart.h` | `hal_uart_init()`, `hal_uart_print()`, `hal_uart_println()` |
| GPIO | `hal_gpio.h` | `hal_gpio_set_mode()`, `hal_gpio_read()`, `hal_gpio_write()` |
| ADC | `hal_adc.h` | `hal_adc_read()` |
| Temps | `hal_time.h` | `hal_time_ms()`, `hal_delay_ms()` |
| I2C | `hal_i2c.h` | `hal_i2c_init()`, `hal_i2c_write_reg()`, `hal_i2c_read_reg()`, `hal_i2c_probe()` |

**Ajouter un nouveau MCU :** créer `src/platform/platform_<mcu>.c` qui implémente toutes les fonctions `hal_*`.

---

## Drivers capteurs disponibles

| Driver | Fichier | Capteur | Interface | Tests |
|---|---|---|---|---|
| MPU-6050 | `drivers/mpu6050.h` | Accéléromètre 3 axes ±2/4/8/16g | I2C | 33 tests |

### MPU-6050 — accéléromètre I2C

```c
#include "fovet/drivers/mpu6050.h"

mpu6050_accel_t accel;

// Initialiser : adresse 0x68 (AD0=GND), plage ±4g
if (!mpu6050_init(MPU6050_ADDR_DEFAULT, MPU6050_RANGE_4G)) {
    // capteur absent ou erreur I2C
}

// Lire l'accélération
if (mpu6050_read_accel(MPU6050_ADDR_DEFAULT, &accel)) {
    // accel.x, accel.y, accel.z en g
    // accel.magnitude = sqrt(x²+y²+z²) en g
}
```

Câblage ESP32-CAM : SDA → GPIO13, SCL → GPIO14, AD0 → GND (adresse 0x68).

**Ajouter un nouveau driver :** créer `include/fovet/drivers/<capteur>.h` +
`src/drivers/<capteur>.c` + `tests/test_<capteur>.c` (mock HAL I2C).
Voir `docs/new-use-case.md` pour le guide complet.

---

## Exemples ESP32-CAM

| Exemple | Capteur | Détecteur | Prérequis |
|---|---|---|---|
| `smoke_test` | Synthétique | Z-Score | Aucun (premier flash) |
| `zscore_demo` | Synthétique | Z-Score + EWMA Drift | WiFi + MQTT + Vigie |
| `fire_detection` | OV2640 (caméra) | 3× Z-Score (R/ratio/var) | WiFi + MQTT + Vigie |
| `person_detection` | OV2640 (caméra) | TFLite MobileNetV1 + Z-Score | WiFi + MQTT + Vigie |
| `imu_zscore` | MPU-6050 I2C | Z-Score sur magnitude | MPU-6050 câblé + WiFi + MQTT + Vigie |

Tous utilisent `board=esp32dev` — voir [Hardware gotchas](../CLAUDE.md) pour le détail.

---

## Demo ESP32-CAM (zscore_demo)

La démo fait tourner **Z-Score et EWMA Drift en parallèle** sur un signal sinus synthétique à 100 Hz, illustrant la complémentarité des deux détecteurs :

| Événement injecté | Fréquence | Détecté par |
|---|---|---|
| Spike 5σ soudain | toutes les 200 mesures | **Z-Score** ✓ — Drift ✗ (EWMAs pas perturbés) |
| Rampe lente +0.05/sample × 100 samples | toutes les 600 mesures | **Drift** ✓ — Z-Score ✗ (Welford absorbe) |

**Format serial CSV :**
```
index,value,mean,stddev,drift_mag,spike_det,drift_det,event
```

**Payload MQTT :**
```json
{
  "value": 0.9877,
  "mean": 0.0031,
  "stddev": 0.7071,
  "zScore": 1.39,
  "anomaly": false,
  "driftMag": 0.0012,
  "driftAlert": false
}
```

**Fichier `src/config.h` à créer** (ne pas commiter) :
```c
#define WIFI_SSID       "mon_wifi"
#define WIFI_PASSWORD   "mon_mdp"
#define MQTT_BROKER     "192.168.1.x"
#define MQTT_PORT       1883
#define MQTT_USER       "fovet-device"
#define MQTT_PASSWORD   "mot_de_passe"
#define DEVICE_ID       "esp32-cam-001"
```

**Utilisation mémoire** (build esp32cam) :
- RAM : ~14% (46 KB / 320 KB)
- Flash : ~24% (749 KB / 3 MB)

---

## Contraintes

| Contrainte | Valeur |
|---|---|
| Norme C | C99 pur |
| Malloc | Interdit dans les algos |
| RAM / détecteur | < 4 KB (Z-Score : 24 bytes, Drift : 24 bytes) |
| Latence | < 1 ms / sample @ 80 MHz (mesuré : ~0.04 µs) |
| Préfixe fonctions | `fovet_` (public), `hal_` (HAL) |
| Nommage fichiers | snake_case |
| Testabilité | gcc natif (sans hardware) |

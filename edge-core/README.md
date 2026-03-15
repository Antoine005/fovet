# Fovet Sentinelle — SDK embarqué C99

SDK C/C++ pour la détection d'anomalies en temps réel sur microcontrôleurs.
Zéro malloc. Zéro dépendance. Testable sur PC avant de toucher le hardware.

---

## Démarrage rapide

### Tests natifs sur PC (gcc)

```bash
cd edge-core/tests
make
# Résultats attendus :
# test_zscore            : 26/26 passed
# test_drift             : 28/28 passed
# test_forge_integration : 10/10 passed
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
│   └── hal/
│       ├── hal_uart.h        ← Interface UART (print, init)
│       ├── hal_gpio.h        ← Interface GPIO (mode, read, write)
│       ├── hal_adc.h         ← Interface ADC (read channel)
│       └── hal_time.h        ← Interface temps (ms, delay)
├── src/
│   ├── zscore.c              ← Algorithme de Welford (C99 pur)
│   ├── drift.c               ← Double EWMA fast/slow
│   └── platform/
│       └── platform_esp32.cpp ← Implémentation HAL pour ESP32/Arduino
├── tests/
│   ├── test_zscore.c         ← 26 tests : Welford, warm-up, saturation, benchmark
│   ├── test_drift.c          ← 28 tests : EWMA, complémentarité zscore/drift
│   └── test_forge_integration.c ← 10 tests : validation header Forge→Sentinelle
├── examples/
│   └── esp32/zscore_demo/    ← Demo PlatformIO : sinus + MQTT + Vigie
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
} FovetZScore;
// sizeof(FovetZScore) == 20 bytes
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

// Réinitialiser les stats (conserve threshold_sigma et min_samples)
void fovet_zscore_reset(FovetZScore *ctx);
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

**Ajouter un nouveau MCU :** créer `src/platform/platform_<mcu>.c` qui implémente toutes les fonctions `hal_*`.

---

## Demo ESP32-CAM (zscore_demo)

La démo génère un signal sinus synthétique à 100 Hz, injecte une anomalie 5σ toutes les 200 samples, et publie en MQTT vers Fovet Vigie.

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

---

## Contraintes

| Contrainte | Valeur |
|---|---|
| Norme C | C99 pur |
| Malloc | Interdit dans les algos |
| RAM / détecteur | < 4 KB (Z-Score : 20 bytes, Drift : 24 bytes) |
| Latence | < 1 ms / sample @ 80 MHz (mesuré : ~0.04 µs) |
| Préfixe fonctions | `fovet_` (public), `hal_` (HAL) |
| Nommage fichiers | snake_case |
| Testabilité | gcc natif (sans hardware) |

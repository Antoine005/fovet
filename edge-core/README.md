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
# test_zscore            : 56/56 passed
# test_drift             : 28/28 passed
# test_forge_integration : 12/12 passed
# test_mad               : 28/28 passed
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
│   ├── mad.h                 ← API publique MAD detector
│   └── hal/
│       ├── hal_uart.h        ← Interface UART (print, init)
│       ├── hal_gpio.h        ← Interface GPIO (mode, read, write)
│       ├── hal_adc.h         ← Interface ADC (read channel)
│       └── hal_time.h        ← Interface temps (ms, delay)
├── src/
│   ├── zscore.c              ← Algorithme de Welford (C99 pur)
│   ├── drift.c               ← Double EWMA fast/slow
│   ├── mad.c                 ← MAD detector (ring buffer + tri par insertion)
│   └── platform/
│       └── platform_esp32.cpp ← Implémentation HAL pour ESP32/Arduino
├── tests/
│   ├── test_zscore.c         ← 56 tests : Welford, warm-up, saturation, windowed mode
│   ├── test_drift.c          ← 28 tests : EWMA, complémentarité zscore/drift
│   ├── test_forge_integration.c ← 12 tests : validation header Forge→Sentinelle
│   └── test_mad.c            ← 28 tests : ring buffer, médiane, MAD, score, détection
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

## API publique — MAD detector

Détecte les anomalies ponctuelles de manière robuste : contrairement au Z-Score basé sur la moyenne/variance (sensibles aux outliers), le MAD utilise la médiane et la déviation absolue médiane — insensibles aux valeurs extrêmes passées.

**Quand utiliser MAD vs Z-Score :**
- **Z-Score** : signal propre, Gaussien, peu d'outliers passés → moyenne/variance fiables
- **MAD** : signal bruité ou avec outliers récurrents → médiane robuste, pas de contamination historique

### Struct

```c
#include "fovet/mad.h"

typedef struct {
    float    window[FOVET_MAD_MAX_WINDOW]; // ring buffer des derniers samples (128 max)
    float    scratch[FOVET_MAD_MAX_WINDOW];// zone de tri temporaire — ne pas toucher
    uint16_t head;                          // prochain index d'écriture
    uint16_t count;                         // samples reçus (plafonne à win_size)
    uint16_t win_size;                      // taille effective de la fenêtre
    float    threshold_mad;                 // seuil d'anomalie en unités MAD (ex: 3.5f)
} FovetMAD;
// sizeof(FovetMAD) ≈ 1040 bytes pour win_size=128 (configurable via FOVET_MAD_MAX_WINDOW)
```

### Fonctions

```c
// Initialiser le détecteur
// win_size : taille de la fenêtre glissante (1 … 128)
// threshold_mad : seuil d'anomalie (3.5 ≈ 3σ pour données Gaussiennes)
void fovet_mad_init(FovetMAD *ctx, uint16_t win_size, float threshold_mad);

// Ajouter un sample — retourne true si anomalie détectée
// Pas de détection pendant le warm-up (< win_size samples)
bool fovet_mad_update(FovetMAD *ctx, float sample);

// Accesseurs — utiles pour debug ou export série
float fovet_mad_get_median(const FovetMAD *ctx);
float fovet_mad_get_mad(const FovetMAD *ctx);

// Score brut : |value - médiane| / (1.4826 * MAD)
// Signal constant : retourne 0.0f si value == médiane, 1e9f sinon
float fovet_mad_score(const FovetMAD *ctx, float value);
```

### Exemple minimal

```c
#include "fovet/mad.h"

FovetMAD detector;
fovet_mad_init(&detector, 32, 3.5f);  // fenêtre 32 samples, seuil 3.5 MAD

while (1) {
    float sample = read_sensor();
    if (fovet_mad_update(&detector, sample)) {
        trigger_alert();
    }
}
```

### Réduire la RAM — `FOVET_MAD_MAX_WINDOW`

La taille du ring buffer est fixée à la compilation par `FOVET_MAD_MAX_WINDOW` (défaut : 128).
Pour économiser de la RAM sur un microcontrôleur avec peu de mémoire :

```c
// Avant d'inclure le header, réduire la taille max :
#define FOVET_MAD_MAX_WINDOW 32
#include "fovet/mad.h"
// FovetMAD occupe désormais ~264 bytes au lieu de ~1040 bytes
```

### Démarrage précalibré (Forge → Sentinelle)

Fovet Forge calibre le seuil hors-ligne et exporte un header prêt à l'emploi :

```c
// Généré par : uv run forge run --config configs/mon_capteur.yaml
// Fichier    : models/fovet_mad_config.h

#include "fovet/mad.h"

static FovetMAD fovet_mad_value = {
    .window        = {23.85f, 23.91f, /* … 128 entrées … */},
    .scratch       = {0},
    .head          = 0U,
    .count         = 32U,
    .win_size      = 32U,
    .threshold_mad = 3.500000f,
};
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

**Ajouter un nouveau MCU :** créer `src/platform/platform_<mcu>.c` qui implémente toutes les fonctions `hal_*`.

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
| RAM / détecteur | < 4 KB (Z-Score : 24 bytes, Drift : 24 bytes, MAD : ~1040 bytes @ win=128) |
| Latence | < 1 ms / sample @ 80 MHz (mesuré : ~0.04 µs) |
| Préfixe fonctions | `fovet_` (public), `hal_` (HAL) |
| Nommage fichiers | snake_case |
| Testabilité | gcc natif (sans hardware) |

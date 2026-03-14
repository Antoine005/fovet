# Fovet Sentinelle — SDK embarqué C99

SDK C/C++ pour la détection d'anomalies en temps réel sur microcontrôleurs.
Zéro malloc. Zéro dépendance. Testable sur PC avant de toucher le hardware.

---

## Démarrage rapide

### Tests natifs sur PC (gcc)

```bash
cd edge-core/tests
make
./test_zscore
# 16/16 passed
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
│   └── hal/
│       ├── hal_uart.h        ← Interface UART (print, init)
│       ├── hal_gpio.h        ← Interface GPIO (mode, read, write)
│       ├── hal_adc.h         ← Interface ADC (read channel)
│       └── hal_time.h        ← Interface temps (ms, delay)
├── src/
│   ├── zscore.c              ← Algorithme de Welford (C99 pur)
│   └── platform/
│       └── platform_esp32.cpp ← Implémentation HAL pour ESP32/Arduino
├── tests/
│   └── test_zscore.c         ← 16 tests unitaires compilés en natif (gcc)
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
    uint32_t count;           // Nombre de samples traités
    float    mean;            // Moyenne courante (Welford)
    float    M2;              // Somme des carrés des écarts (Welford)
    float    threshold_sigma; // Seuil d'anomalie (ex: 3.0f = 3σ)
} FovetZScore;
// sizeof(FovetZScore) == 16 bytes
```

### Fonctions

```c
// Initialiser le détecteur
void fovet_zscore_init(FovetZScore *ctx, float threshold_sigma);

// Ajouter un sample — retourne true si anomalie détectée
bool fovet_zscore_update(FovetZScore *ctx, float sample);

// Accesseurs en lecture seule
float    fovet_zscore_get_mean(const FovetZScore *ctx);
float    fovet_zscore_get_stddev(const FovetZScore *ctx);
uint32_t fovet_zscore_get_count(const FovetZScore *ctx);

// Réinitialiser les stats (conserve le seuil)
void fovet_zscore_reset(FovetZScore *ctx);
```

### Exemple minimal

```c
#include "fovet/zscore.h"

FovetZScore detector;
fovet_zscore_init(&detector, 3.0f);   // seuil 3σ

while (1) {
    float sample = read_sensor();
    if (fovet_zscore_update(&detector, sample)) {
        trigger_alert();
    }
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
anomaly = z > threshold_sigma
```

Les 2 premiers samples ne peuvent jamais déclencher une alerte (variance indéfinie).

---

## Démarrage avec stats précalibrées (Forge → Sentinelle)

Au lieu de laisser le détecteur apprendre in situ, Fovet Forge calibre les statistiques hors-ligne et exporte un header C :

```c
// Généré par : uv run forge run --config configs/mon_capteur.yaml
// Fichier    : models/fovet_zscore_config.h

#include "fovet/zscore.h"

static FovetZScore fovet_zscore_value = {
    .count            = 10000U,
    .mean             = 23.847f,
    .M2               = 1842.3f,
    .threshold_sigma  = 3.0f,
};
```

Le détecteur est opérationnel dès le premier sample, sans warm-up.

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

La démo génère un signal sinus synthétique à 100 Hz, injecte une anomalie 5σ toutes les 200 samples, et publie les résultats en MQTT vers Fovet Vigie.

**Prérequis :**
1. PlatformIO installé (VS Code extension)
2. ESP32-CAM avec adaptateur USB (CH340 ou FTDI)
3. Fovet Vigie démarré localement (optionnel — la démo fonctionne sans)

**Fichier `src/config.h` à créer** (ne pas commiter) :
```c
#define WIFI_SSID       "mon_wifi"
#define WIFI_PASSWORD   "mon_mdp"
#define MQTT_BROKER     "192.168.1.x"   // IP du serveur Mosquitto
#define MQTT_PORT       1883
#define MQTT_USER       "fovet-device"
#define MQTT_PASSWORD   "mot_de_passe"
#define DEVICE_ID       "esp32-cam-001"
```

**Sortie série (115200 baud) :**
```
=== Fovet Sentinelle — Z-Score + MQTT Demo ===
0,0.0000,0.0000,0.0000,0
1,0.0628,0.0314,0.0222,0
...
200,5.2341,0.0012,0.7071,1 <-- INJECTED
```

---

## Contraintes

| Contrainte | Valeur |
|---|---|
| Norme C | C99 pur |
| Malloc | Interdit dans les algos |
| RAM / détecteur | < 4 KB (Z-Score : 16 bytes) |
| Latence | < 1 ms / sample @ 80 MHz |
| Préfixe fonctions | `fovet_` (public), `hal_` (HAL) |
| Nommage fichiers | snake_case |
| Testabilité | gcc natif (sans hardware) |

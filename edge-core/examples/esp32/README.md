# Exemples ESP32 — Fovet Sentinelle

> Tous les exemples ciblent l'ESP32-CAM (AI-Thinker) avec adaptateur CH340 sur COM4.
> **Toujours utiliser `board=esp32dev`** — `board=esp32cam` crashe silencieusement sur l'init PSRAM. Voir `CLAUDE.md` § Hardware gotchas.

## Flash rapide

Depuis la racine du repo, double-cliquez sur **`flash.bat`** pour choisir le firmware à flasher via un menu interactif.

Ou manuellement depuis le répertoire de l'exemple :

```bash
pio run -e <env> --target upload
pio device monitor -e <env>
```

---

## 1. `smoke_test` — Validation SDK

**Environnement PIO :** `smoke`

### Description

Test de fumée du SDK complet : algorithme Z-Score de Welford sur un signal sinusoïdal synthétique (1 Hz, 100 échantillons/s). Toutes les 200 samples, une anomalie ±5σ est injectée et doit être détectée. La LED GPIO33 clignote à chaque anomalie.

### Capteurs requis

Aucun — signal purement synthétique.

### Sortie

Pas de MQTT. Sortie CSV sur UART à 115200 baud :

```
idx,value,mean,stddev,zscore,anomaly,event
0,0.0000,0.0000,0.0000,0.0000,0,
...
200,5.2341,0.0012,0.7123,7.3351,1,+5SIGMA
```

### Usage type

Valider que le SDK fonctionne sur hardware avant d'ajouter WiFi ou capteurs réels.

---

## 2. `fire_detection` — Détection feu/fumée

**Environnement PIO :** `fire_detection`

### Description

Détection visuelle de feu et de fumée via la caméra OV2640 (QQVGA 160×120, RGB565). Chaque frame est réduite à 3 scalaires passés dans 3 détecteurs Z-Score indépendants :

| Scalaire | Signal | Anomalie typique |
|---|---|---|
| `R_mean` | Rouge moyen normalisé [0–255] | Flamme (augmentation canal rouge) |
| `ratio_rb` | `total_R / (total_G + total_B)` | Flamme vs lumière blanche ambiante |
| `variance` | Variance de luminance intra-frame (Welford) | Fumée (flou, texture dégradée) |

Une anomalie est déclenchée si au moins un des 3 détecteurs dépasse son seuil.

### Capteurs requis

- **OV2640** (intégrée sur ESP32-CAM AI-Thinker)

### Sortie

Pas de MQTT. Sortie sur UART à 115200 baud :

```
[FRAME 150] R_mean=28.3 ratio_rb=0.72 variance=312.1 → FIRE DETECTED
```

---

## 3. `person_detection` — Détection de personne

**Environnement PIO :** `person_detection`

### Description

Détection de personne par inférence TFLite Micro (Visual Wake Words) + suivi temporel Z-Score.

**Pipeline :**

```
OV2640 GRAYSCALE 96×96 ──► TFLite Micro (MobileNetV1 0.25×) ──► person_score [0.0–1.0]
                                                                         │
                                                                   FovetZScore ──► MQTT → Vigie
```

Le modèle VWW produit un score de présence humaine. Le Z-Score modélise le comportement normal de la scène (WARMUP_FRAMES premières inférences, scène vide) et signale une anomalie quand une personne entre dans le champ.

**Note :** Utilise la partition `huge_app` (4 MB flash) pour loger le modèle (~300 KB).

### Capteurs requis

- **OV2640** (intégrée sur ESP32-CAM AI-Thinker)
- **WiFi** (credentials dans `src/config.h` — ne pas commiter)

### Credentials requis

Copier `src/config.h.example` → `src/config.h` et remplir :

```c
#define WIFI_SSID     "mon-reseau"
#define WIFI_PASSWORD "mon-mdp"
#define MQTT_BROKER   "192.168.x.x"
#define DEVICE_ID     "esp32-cam-001"
```

### Topic MQTT publié

```
fovet/devices/<DEVICE_ID>/readings
```

### Format JSON

```json
{
  "value": 0.87,
  "mean": 0.43,
  "stddev": 0.22,
  "zScore": 2.8,
  "anomaly": true,
  "ts": 1700000000000,
  "sensorType": "VIS",
  "level": "WARN"
}
```

---

## 4. `zscore_demo` — Z-Score + Drift vers Vigie

**Environnement PIO :** `esp32cam`

### Description

Démo complète de deux détecteurs complémentaires en parallèle sur un signal sinusoïdal synthétique, avec publication MQTT vers Fovet Vigie :

| Détecteur | Cible | Signal injecté |
|---|---|---|
| `FovetZScore` | Pics soudains (spike ±5σ) | Toutes les 200 samples |
| `FovetDrift` | Dérive lente de la baseline | Rampe +0.05/sample sur 100 samples, toutes les 600 samples |

Cette démo illustre pourquoi les deux détecteurs sont nécessaires : le Z-Score absorbe les dérives lentes dans sa moyenne courante, le Drift ne détecte pas les spikes isolés.

### Capteurs requis

- **WiFi** (credentials dans `src/config.h` — ne pas commiter)
- Aucun capteur physique — signal synthétique

### Credentials requis

Copier `src/config.h.example` → `src/config.h` et remplir :

```c
#define WIFI_SSID     "mon-reseau"
#define WIFI_PASSWORD "mon-mdp"
#define MQTT_BROKER   "192.168.x.x"
#define DEVICE_ID     "esp32-cam-001"
```

### Prérequis Vigie

1. Mosquitto doit écouter sur `0.0.0.0:1883` (pas `localhost`) pour l'accès LAN depuis l'ESP32.
2. Enregistrer le device : `POST /api/devices { "mqttClientId": "esp32-cam-001" }`

### Topic MQTT publié

```
fovet/devices/<DEVICE_ID>/readings
```

### Format JSON

```json
{
  "value": 0.8412,
  "mean": 0.0023,
  "stddev": 0.7071,
  "zScore": 1.1893,
  "anomaly": false,
  "driftMag": 0.0031,
  "driftAlert": false
}
```

### Sortie UART

```
index,value,mean,stddev,drift_mag,spike,drift,event
0,0.0000,0.0000,0.0000,0.0000,0,0,
...
200,5.1234,0.0012,0.7071,0.0031,1,0,SPIKE+5SIGMA
600,<ramp>,<mean>,<stddev>,0.2341,0,1,DRIFT
```

# Fovet — Bill of Materials (BOM) hardware

> Liste du matériel à acquérir pour valider les modules Sentinelle H1 → H4 sur ESP32-CAM.
> Mise à jour : 2026-03-15

---

## Statut actuel

| Composant | Statut |
|---|---|
| ESP32-CAM (Espressif) | ✅ En stock |
| MB ESP32-CAM-MB (UART intégrée) | ⚠️ Défectueuse — remplacement en cours (livraison ~19/03) |
| Adaptateur USB-UART FTDI (CH340/FTDI232) | 🛒 À commander |
| Driver CH341SER Windows | ✅ Installé (COM4) |

---

## Priorité 1 — Outillage de base (bloquant pour tout flash)

| Référence | Usage | Qté | Prix indicatif | Lien de recherche |
|---|---|---|---|---|
| **Adaptateur USB-UART FTDI CH340** ou **CP2102** | Flash ESP32-CAM (câblage TX/RX + IO0 GND) | 1 | ~5 € | "USB to TTL UART CP2102" |
| **Breadboard 830 points** | Câblage des capteurs | 2 | ~3 €/u | "breadboard 830 points" |
| **Jumper wires M-M + M-F 40 cm** | Connexions rapides | 2 paquets | ~3 €/u | "dupont jumper wires 40cm" |
| **Câble USB-A → Micro-USB** | Alimentation ESP32-CAM via MB | 1 | ~2 € | — |

**Total estimé : ~17 €**

---

## Priorité 2 — Module H1 (PTI — détection de chute)

> Valider `mpu6050_hal.c` + `pti_profile.c` sur hardware réel.

| Référence | Usage | Qté | Prix indicatif | Notes |
|---|---|---|---|---|
| **MPU-6050 breakout** (GY-521) | Accéléromètre/gyroscope I2C — `FOVET_SOURCE_IMU` | 2 | ~2 €/u | Prévoir spare — fragile aux chutes de test |
| **Résistances pull-up 4,7 kΩ** | Bus I2C (SDA + SCL) | 10 | < 1 € | Paquet assortiment résistances suffit |
| **Bouton poussoir 6 mm** | SOS actif-bas (pti_profile SOS GPIO) | 3 | < 1 € | "tactile push button 6mm" |
| **LED rouge 5 mm** | Indication alerte PTI (FALL/SOS) | 5 | < 1 € | Résistance 330 Ω en série |
| **Résistances 330 Ω** | Limitation courant LED | 10 | < 1 € | — |

**Total estimé : ~10 €**

---

## Priorité 3 — Module H2 (Fatigue cardiaque — MAX30102)

> Valider `max30102_hal.c` + `fatigue_profile.c` sur hardware réel.

| Référence | Usage | Qté | Prix indicatif | Notes |
|---|---|---|---|---|
| **MAX30102 breakout** | HR + SpO₂ — `FOVET_SOURCE_HR` | 2 | ~5 €/u | Module avec condensateurs de découplage intégrés |
| **LED RGB anode commune ou cathode commune** | Feedback visuel profil fatigue (OK→vert, ALERT→ambre, CRITICAL→rouge) | 3 | ~1 €/u | "LED RGB 5mm common cathode" |
| **Résistances 330 Ω** (supplément) | Limitation courant LED RGB (3 × par LED) | 10 | < 1 € | — |

> ⚠️ Le MAX30102 est un capteur de contact (doigt sur le module). Prévoir un support/boîtier ou du ruban adhésif double face pour maintenir le contact lors des tests.

**Total estimé : ~13 €**

---

## Priorité 4 — Module H3 (Température + Humidité — DHT22)

> Valider `dht22_hal.c` sur hardware réel.

| Référence | Usage | Qté | Prix indicatif | Notes |
|---|---|---|---|---|
| **DHT22 / AM2302 breakout** | Temp + humidité ambiante — `FOVET_SOURCE_TEMP` | 2 | ~4 €/u | Module avec résistance pull-up intégrée préférable |
| **Résistance pull-up 10 kΩ** | Ligne DATA single-wire si module nu (sans pull-up) | 5 | < 1 € | Inutile si module breakout avec pull-up intégrée |

> **Alternative I2C envisageable** : si le protocole single-wire du DHT22 s'avère peu fiable sur ESP32 à haute fréquence, remplacer par **SHT31-D** (I2C, ±0,3°C, ±2% RH) — même API HAL, driver plus simple. Prix : ~8 €/u.

**Total estimé : ~10 €**

---

## Priorité 5 — Module H4 (ECG — AD8232)

> Valider `FOVET_SOURCE_ECG` + mesure RR précise sur hardware réel.

| Référence | Usage | Qté | Prix indicatif | Notes |
|---|---|---|---|---|
| **AD8232 ECG module** (SparkFun ou clone) | ECG single-lead — `FOVET_SOURCE_ECG` | 1 | ~8–15 € | Sortie analogique → ADC ESP32 |
| **Électrodes ECG adhesives** (patchs gel) | Contact cutané | 1 paquet (50 u) | ~5–10 € | "ECG electrode snap 24mm" — compatible AD8232 |
| **Câbles électrodes snap 3,5 mm** | Connexion AD8232 → électrodes | 1 set (3 fils) | ~3 € | Souvent fournis avec le module AD8232 |

> ⚠️ L'AD8232 nécessite une alimentation 3,3 V propre (pas de bruit). Prévoir un condensateur 100 nF sur la ligne d'alim si instabilité du signal.

**Total estimé : ~20 €**

---

## Récapitulatif budgétaire

| Priorité | Module | Composants | Coût estimé |
|---|---|---|---|
| 0 | Outillage de base | USB-UART, breadboard, jumpers | ~17 € |
| 1 | H1 — PTI | MPU-6050, bouton SOS, LED | ~10 € |
| 2 | H2 — Fatigue | MAX30102, LED RGB | ~13 € |
| 3 | H3 — Température | DHT22 (ou SHT31) | ~10 € |
| 4 | H4 — ECG | AD8232, électrodes | ~20 € |
| **Total** | | | **~70 €** |

---

## Fournisseurs recommandés

| Fournisseur | Délai | Usage |
|---|---|---|
| **AliExpress** | 2–4 semaines | MPU-6050, MAX30102, DHT22, LED, résistances — prix minimal |
| **Amazon FR** | 24–48 h | FTDI USB-UART, breadboard — si bloquant pour démarrer |
| **Mouser / Farnell** | 2–5 jours | AD8232 officiel SparkFun, SHT31 Sensirion — composants certifiés |
| **LCSC** | 2–3 semaines | Composants nus (résistances, condensateurs) en lot |

---

## Connexions ESP32-CAM — rappel câblage I2C

```
ESP32-CAM     Capteur (MPU-6050 ou MAX30102)
──────────────────────────────────────────
GPIO14  ───── SDA  (+ résistance pull-up 4,7 kΩ vers 3,3 V)
GPIO15  ───── SCL  (+ résistance pull-up 4,7 kΩ vers 3,3 V)
3,3 V   ───── VCC
GND     ───── GND
```

```
ESP32-CAM     DHT22
─────────────────────────────────────────
GPIO13  ───── DATA (+ résistance pull-up 10 kΩ vers 3,3 V)
3,3 V   ───── VCC
GND     ───── GND
```

```
ESP32-CAM     AD8232
─────────────────────────────────────────
GPIO34  ───── OUTPUT (ADC1_CH6 — entrée analogique)
GPIO4   ───── LO+    (leads-off detection)
GPIO2   ───── LO−    (leads-off detection)
3,3 V   ───── 3,3 V
GND     ───── GND
```

> GPIO34–39 sur ESP32 sont ADC uniquement (input only) — parfaits pour l'AD8232.

---

*Généré par Fovet Forge — `docs/hardware-bom.md`*

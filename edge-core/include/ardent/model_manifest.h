/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * ardent/model_manifest.h — Documentation du format de manifest de modèle.
 *
 * Ce fichier N'EST PAS inclus directement par les firmwares.
 * Il documente les macros attendues dans fovet_model_manifest.h,
 * généré par Ardent Forge et à copier dans src/ du projet PlatformIO.
 *
 * --- Workflow ---
 *
 *   1. Lancer Forge :
 *        uv run forge run --config configs/mon_capteur.yaml
 *
 *   2. Copier le manifest généré dans le projet PlatformIO :
 *        cp models/mon_capteur/fovet_model_manifest.h \
 *           edge-core/examples/esp32/mon_firmware/src/
 *
 *   3. Dans le firmware :
 *        #include "fovet_model_manifest.h"
 *
 *   4. Utiliser les macros dans le payload MQTT canonique :
 *        "model_id": ARD_MODEL_ID
 *        "sensor":   ARD_MODEL_SENSOR
 *        "unit":     ARD_MODEL_UNIT
 *        "value_min": ARD_MODEL_VALUE_MIN  (float)
 *        "value_max": ARD_MODEL_VALUE_MAX  (float)
 *        "label":    ARD_MODEL_LABEL_NORMAL / ARD_MODEL_LABEL_ANOMALY
 *
 * --- Macros définies dans fovet_model_manifest.h ---
 *
 *   ARD_MODEL_ID           string literal   "demo-zscore-sine"
 *   ARD_MODEL_SENSOR       string literal   "synthetic"|"imu"|"camera"|"temperature"|"hr"
 *   ARD_MODEL_UNIT         string literal   "z_score"|"g"|"score"|"bpm"|"C"|"r_mean"
 *   ARD_MODEL_VALUE_MIN    float constant   e.g. (-6.0f)
 *   ARD_MODEL_VALUE_MAX    float constant   e.g.  (6.0f)
 *   ARD_MODEL_LABEL_NORMAL  string literal  "normal"
 *   ARD_MODEL_LABEL_ANOMALY string literal  "anomaly"|"person"|"fire"|...
 *
 * --- Payload MQTT canonique v2 ---
 *
 * {
 *   "device_id":  "esp32-cam-001",
 *   "model_id":   "demo-zscore-sine",     // ARD_MODEL_ID
 *   "firmware":   "zscore_demo",          // nom du firmware (constant dans le code)
 *   "sensor":     "synthetic",            // ARD_MODEL_SENSOR
 *   "value":      1.23,                   // valeur primaire mesurée
 *   "value_min":  -6.0,                   // ARD_MODEL_VALUE_MIN (float → %.4f)
 *   "value_max":   6.0,                   // ARD_MODEL_VALUE_MAX
 *   "label":      "normal",               // ARD_MODEL_LABEL_NORMAL ou ARD_MODEL_LABEL_ANOMALY
 *   "unit":       "z_score",              // ARD_MODEL_UNIT
 *   "anomaly":    false,
 *   "ts":         1700000000000
 * }
 *
 * Vigie lit model_id/unit/value_min/value_max pour :
 *   - auto-scaler le graphe Y (value_min → value_max)
 *   - afficher l'unité sur l'axe Y
 *   - afficher le label humain sur les points d'anomalie
 */

#ifndef ARD_MODEL_MANIFEST_DOCS_H
#define ARD_MODEL_MANIFEST_DOCS_H
/* This file is documentation only — no code. */
#endif /* ARD_MODEL_MANIFEST_DOCS_H */

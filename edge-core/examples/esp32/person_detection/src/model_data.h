/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * model_data.h — Déclarations externes du modèle TFLite person_detect.
 *
 * Le fichier model_data.cpp (array C ~300 KB) est généré par :
 *   python scripts/get_person_model.py
 *
 * Source du modèle :
 *   TFLite Micro Arduino Examples — person_detection
 *   https://github.com/tensorflow/tflite-micro-arduino-examples
 *
 * Modèle : MobileNetV1 0.25× entraîné sur Visual Wake Words (COCO subset)
 *   - Input  : 96×96×1, int8, range [-128, 127]
 *   - Output : 2 scores int8 → [no_person, person]
 *   - Taille : ~250 KB en flash (format FlatBuffer TFLite)
 */

#pragma once

#include <stdint.h>

extern const unsigned char g_person_detect_model_data[];
extern const unsigned int  g_person_detect_model_data_len;

/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * model_data.h — Déclarations du modèle TFLite person_detect.
 *
 * Le fichier model_data.cpp (array C ~300 KB) doit être copié depuis la
 * librairie TensorFlowLite_ESP32 installée par PlatformIO :
 *
 *   cp .pio/libdeps/person_detection/TensorFlowLite_ESP32/examples/person_detection/person_detect_model_data.cpp src/model_data.cpp
 *
 * model_data.cpp est gitignored (300 KB, régénérable depuis la librairie).
 *
 * Modèle : MobileNetV1 0.25× entraîné sur Visual Wake Words (COCO subset)
 *   - Input  : 96×96×1, int8, range [-128, 127]
 *   - Output : 2 scores int8 → [no_person, person]
 *   - Taille : ~300 KB en flash (format FlatBuffer TFLite)
 */

#pragma once

#include <stdint.h>

extern const unsigned char g_person_detect_model_data[];
extern const int           g_person_detect_model_data_len;

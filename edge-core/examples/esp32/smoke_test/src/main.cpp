/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * smoke_test/main.cpp — diagnostic de premier flash, Arduino brut.
 *
 * ÉTAPE 1 (actuelle) : zéro HAL, zéro bibliothèque Fovet.
 *   But : vérifier que Serial fonctionne physiquement sur le CH340.
 *   Si "HELLO" apparaît → le hardware est OK, on peut passer à l'étape 2.
 *   Si rien → problème hardware (pins, port COM, baud rate, câblage).
 *
 * ÉTAPE 2 (à décommenter une fois l'étape 1 validée) :
 *   Réintroduire le HAL Fovet + fovet_zscore_update().
 */

#include <Arduino.h>

void setup()
{
    Serial.begin(115200);

    /* 3 s pour laisser le CH340 s'énumérer et le moniteur se connecter.
     * Ouvrir le moniteur série AVANT d'appuyer sur RST. */
    delay(3000);

    Serial.println();
    Serial.println("=== Fovet smoke test — HELLO FROM ESP32-CAM ===");
    Serial.println("setup() OK");
}

void loop()
{
    /* Imprime toutes les secondes — visible même si setup() est manqué
     * parce que le moniteur était fermé au moment du boot. */
    static uint32_t last = 0;
    if (millis() - last >= 1000) {
        last = millis();
        Serial.print("loop tick ms=");
        Serial.println(millis());
    }
}

/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * smoke_test/main.cpp — diagnostic série exhaustif.
 *
 * Le baud rate est paramétré par build_flag -DBAUD_RATE=xxx dans chaque env.
 * Aucune dépendance Fovet — Arduino brut uniquement.
 */

#include <Arduino.h>

#ifndef BAUD_RATE
#define BAUD_RATE 115200
#endif

/* HardwareSerial explicite sur UART0 (GPIO1=TX, GPIO3=RX).
 * Équivalent à Serial sur ESP32 Arduino, mais sans ambiguïté. */
static HardwareSerial uart0(0);

void setup()
{
    /* UART0 explicite : GPIO1 TX, GPIO3 RX — pins du CH340 sur ESP32-CAM */
    uart0.begin(BAUD_RATE, SERIAL_8N1, 3 /*RX*/, 1 /*TX*/);

    /* Délai généreux : CH340 enumération + ouverture moniteur.
     * Pendant ces 4 s, si CORE_DEBUG_LEVEL=5 est actif, des messages
     * IDF apparaîtront ici avant même le premier println(). */
    delay(4000);

    uart0.println();
    uart0.print("=== Fovet smoke test — HELLO === baud=");
    uart0.println(BAUD_RATE);
    uart0.print("board=");
#if defined(ARDUINO_ESP32CAM_DEV)
    uart0.println("esp32cam");
#elif defined(ARDUINO_ESP32_DEV)
    uart0.println("esp32dev");
#else
    uart0.println("unknown");
#endif
    uart0.println("setup() OK");
    uart0.flush();
}

void loop()
{
    static uint32_t last = 0;
    if (millis() - last >= 1000) {
        last = millis();
        uart0.print("tick ms=");
        uart0.println(millis());
        uart0.flush();
    }
}

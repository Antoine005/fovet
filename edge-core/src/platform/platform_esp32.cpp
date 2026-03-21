/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * HAL implementation for ESP32 (Arduino-ESP-IDF via PlatformIO).
 *
 * Include path must expose:
 *   - Arduino.h  (millis, micros, delay, analogRead, pinMode, digitalWrite)
 *   - HardwareSerial (Serial)
 */

#ifdef ARDUINO  /* Guard: only compile when targeting ESP32 via Arduino */

#include "fovet/hal/hal_adc.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_gpio.h"
#include "fovet/hal/hal_time.h"

#include <Arduino.h>

/* -------------------------------------------------------------------------
 * HAL — ADC
 * ESP32 ADC: 12-bit (0–4095), channels mapped to GPIO pins.
 * ------------------------------------------------------------------------- */

void hal_adc_init(void)
{
    /* Arduino analogRead() works without explicit init on ESP32.
     * Set default attenuation for 0–3.3 V range if needed. */
    analogSetAttenuation(ADC_11db);  /* ~0–3.3 V */
}

uint16_t hal_adc_read(uint8_t channel)
{
    return (uint16_t)analogRead((uint8_t)channel);
}

uint16_t hal_adc_to_mv(uint16_t raw, uint16_t vref_mv)
{
    /* ESP32 ADC is 12-bit: 0–4095 maps to 0–vref_mv */
    return (uint16_t)(((uint32_t)raw * vref_mv) / 4095U);
}

/* -------------------------------------------------------------------------
 * HAL — UART
 * Uses Serial (UART0) by default — TX=GPIO1, RX=GPIO3 on ESP32.
 * ESP32-CAM: use Serial (UART0) with FTDI adapter on GPIO1/GPIO3.
 * ------------------------------------------------------------------------- */

void hal_uart_init(uint32_t baud_rate)
{
    Serial.begin((unsigned long)baud_rate);
    /* NOTE: do NOT use while (!Serial) here — on ESP32 with CH340 (UART bridge),
     * Serial is always truthy and this guard is only meaningful for boards with
     * native USB (e.g. Arduino Leonardo). Caller must add a startup delay if
     * the monitor needs time to connect before the first print. */
}

void hal_uart_write(const char *data, uint32_t len)
{
    Serial.write((const uint8_t *)data, (size_t)len);
}

void hal_uart_print(const char *str)
{
    Serial.print(str);
}

void hal_uart_flush(void)
{
    Serial.flush();
}

/* -------------------------------------------------------------------------
 * HAL — GPIO
 * ------------------------------------------------------------------------- */

void hal_gpio_set_mode(uint8_t pin, hal_gpio_mode_t mode)
{
    pinMode(pin, (mode == HAL_GPIO_MODE_OUTPUT) ? OUTPUT : INPUT);
}

void hal_gpio_write(uint8_t pin, hal_gpio_level_t level)
{
    digitalWrite(pin, (level == HAL_GPIO_HIGH) ? HIGH : LOW);
}

hal_gpio_level_t hal_gpio_read(uint8_t pin)
{
    return (digitalRead(pin) == HIGH) ? HAL_GPIO_HIGH : HAL_GPIO_LOW;
}

void hal_gpio_toggle(uint8_t pin)
{
    digitalWrite(pin, !digitalRead(pin));
}

/* -------------------------------------------------------------------------
 * HAL — Time
 * millis()/micros() are provided by the Arduino/ESP-IDF runtime.
 * ------------------------------------------------------------------------- */

uint32_t hal_time_ms(void)
{
    return (uint32_t)millis();
}

uint32_t hal_time_us(void)
{
    return (uint32_t)micros();
}

void hal_delay_ms(uint32_t ms)
{
    delay((unsigned long)ms);
}

#endif /* ARDUINO */

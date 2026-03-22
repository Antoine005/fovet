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
#include "fovet/hal/hal_i2c.h"

#include <Arduino.h>
#include <Wire.h>

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

/* -------------------------------------------------------------------------
 * HAL — I2C
 * Uses Wire (Arduino I2C) with configurable SDA/SCL pins.
 * ESP32-CAM external sensor header: SDA=GPIO13, SCL=GPIO14.
 * Timeout: 10 ms (Wire.setTimeOut is in ms on ESP32 Arduino).
 * ------------------------------------------------------------------------- */

#define HAL_I2C_TIMEOUT_MS 10U

void hal_i2c_init(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    Wire.begin((int)sda_pin, (int)scl_pin);
    Wire.setClock(freq_hz);
    Wire.setTimeOut(HAL_I2C_TIMEOUT_MS);
}

hal_i2c_err_t hal_i2c_write_reg(uint8_t addr, uint8_t reg,
                                  const uint8_t *data, uint8_t len)
{
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(data, len);
    uint8_t status = Wire.endTransmission(true);
    switch (status) {
        case 0:  return HAL_I2C_OK;
        case 2:  return HAL_I2C_ERR_NACK;   /* NACK on address */
        case 3:  return HAL_I2C_ERR_NACK;   /* NACK on data */
        case 5:  return HAL_I2C_ERR_TIMEOUT;
        default: return HAL_I2C_ERR_BUS;
    }
}

hal_i2c_err_t hal_i2c_read_reg(uint8_t addr, uint8_t reg,
                                 uint8_t *buf, uint8_t len)
{
    /* Set register pointer */
    Wire.beginTransmission(addr);
    Wire.write(reg);
    uint8_t status = Wire.endTransmission(false);  /* repeated START */
    if (status == 2 || status == 3) return HAL_I2C_ERR_NACK;
    if (status == 5)                return HAL_I2C_ERR_TIMEOUT;
    if (status != 0)                return HAL_I2C_ERR_BUS;

    /* Read bytes */
    uint8_t received = Wire.requestFrom(addr, (uint8_t)len, (bool)true);
    if (received < len) return HAL_I2C_ERR_NACK;

    for (uint8_t i = 0; i < len; i++) {
        buf[i] = (uint8_t)Wire.read();
    }
    return HAL_I2C_OK;
}

hal_i2c_err_t hal_i2c_read_byte(uint8_t addr, uint8_t reg, uint8_t *out)
{
    return hal_i2c_read_reg(addr, reg, out, 1);
}

hal_i2c_err_t hal_i2c_write_byte(uint8_t addr, uint8_t reg, uint8_t value)
{
    return hal_i2c_write_reg(addr, reg, &value, 1);
}

bool hal_i2c_probe(uint8_t addr)
{
    Wire.beginTransmission(addr);
    return Wire.endTransmission(true) == 0;
}

#endif /* ARDUINO */

/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * dht22_hal.h — Driver HAL DHT22 (H3.1)
 *
 * Measures ambient temperature (°C) and relative humidity (%) using the
 * DHT22 single-wire protocol.  Registers as ARD_SOURCE_TEMP in the
 * biosignal HAL, filling both celsius and humidity_pct fields.
 *
 * Hardware interface:
 *   The DHT22 uses a proprietary single-wire half-duplex protocol.
 *   All timing is abstracted via three injected callbacks:
 *     • pin_write  — drive the data line high or low
 *     • pulse_us   — wait for a level transition and return its duration
 *     • delay_us   — block for a fixed duration
 *
 *   This injection makes the driver fully testable on PC without hardware.
 *
 * Protocol summary (40-bit frame):
 *   1. Host: pull LOW ≥ 1 ms, release HIGH
 *   2. Sensor: LOW ~80 µs, then HIGH ~80 µs (handshake)
 *   3. 40 data bits, MSB first (bit-LOW ~50 µs then bit-HIGH ~26 µs→0 / ~70 µs→1)
 *   4. Byte layout: [Hum_MSB][Hum_LSB][Temp_MSB][Temp_LSB][Checksum]
 *      Temperature MSB bit 15: sign bit (1 = negative)
 *
 * Maximum sample rate: 0.5 Hz (1 reading every 2 s minimum).
 *
 * Typical integration:
 *   1. ard_dht22_set_io(&io) — inject pin/timing callbacks
 *   2. ard_dht22_init()      — registers ARD_SOURCE_TEMP in biosignal HAL
 *   3. ard_hal_biosignal_read(ARD_SOURCE_TEMP, &s) — read sample
 *      s.value.temp.celsius / s.value.temp.humidity_pct
 * -------------------------------------------------------------------------
 */

#ifndef ARD_DHT22_HAL_H
#define ARD_DHT22_HAL_H

#include <stdint.h>
#include "ardent/hal/ard_biosignal_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Error codes (in addition to ARD_HAL_OK = 0)
 * ------------------------------------------------------------------------- */

/** Pulse timeout — sensor did not respond or line stuck. */
#define ARD_DHT22_ERR_TIMEOUT  -1

/** Checksum mismatch — frame corrupted. */
#define ARD_DHT22_ERR_CHECKSUM -2

/** Reading outside physical range (T: -40..80 °C, H: 0..100 %). */
#define ARD_DHT22_ERR_RANGE    -3

/** IO callbacks not set — call ard_dht22_set_io() first. */
#define ARD_DHT22_ERR_IO       -4

/* -------------------------------------------------------------------------
 * Physical validity ranges
 * ------------------------------------------------------------------------- */

/** Minimum valid temperature (°C). */
#define ARD_DHT22_TEMP_MIN    -40.0f

/** Maximum valid temperature (°C). */
#define ARD_DHT22_TEMP_MAX     80.0f

/** Maximum valid relative humidity (%). */
#define ARD_DHT22_HUMIDITY_MAX 100.0f

/* -------------------------------------------------------------------------
 * IO callbacks
 * ------------------------------------------------------------------------- */

/**
 * @brief Drive the data line HIGH (1) or LOW (0).
 *
 * On hardware: configure GPIO as output then write the level.
 * On PC mock: track state for assertion purposes.
 *
 * @param level  0 = LOW, 1 = HIGH.
 */
typedef void (*ard_dht22_pin_write_fn_t)(uint8_t level);

/**
 * @brief Wait for the data line to reach @p expected_level, then measure
 *        how long it stays at that level before changing again.
 *
 * On hardware: busy-wait with microsecond timer.
 * On PC mock: return a pre-programmed duration from a sequence.
 *
 * @param expected_level  Level to wait for (0 or 1).
 * @param timeout_us      Maximum wait time in microseconds.
 *
 * @return Duration in µs that the line held @p expected_level.
 *         Returns 0 on timeout (caller must treat 0 as ARD_DHT22_ERR_TIMEOUT).
 */
typedef uint32_t (*ard_dht22_pulse_us_fn_t)(uint8_t expected_level,
                                              uint32_t timeout_us);

/**
 * @brief Block for @p us microseconds.
 *
 * On hardware: delayMicroseconds() or similar.
 * On PC mock: no-op.
 *
 * @param us  Duration in microseconds.
 */
typedef void (*ard_dht22_delay_us_fn_t)(uint32_t us);

/* -------------------------------------------------------------------------
 * IO bundle
 * ------------------------------------------------------------------------- */

/**
 * @brief Bundle of the three IO callbacks required by the DHT22 driver.
 *
 * All three fields must be non-NULL before calling ard_dht22_init().
 */
typedef struct {
    ard_dht22_pin_write_fn_t pin_write; /**< Drive data line HIGH or LOW   */
    ard_dht22_pulse_us_fn_t  pulse_us;  /**< Measure pulse duration (µs)   */
    ard_dht22_delay_us_fn_t  delay_us;  /**< Busy-wait (µs)                */
} ard_dht22_io_t;

/* -------------------------------------------------------------------------
 * Raw reading
 * ------------------------------------------------------------------------- */

/**
 * @brief Raw DHT22 measurement (temperature + humidity).
 */
typedef struct {
    float celsius;      /**< Ambient temperature (°C, range: -40..80)   */
    float humidity_pct; /**< Relative humidity (%, range: 0..100)        */
} ard_dht22_reading_t;

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * @brief Inject the IO callbacks used by the DHT22 driver.
 *
 * Must be called before ard_dht22_init().
 *
 * @param io  Non-NULL pointer to the IO bundle.  The struct is copied
 *            internally — the caller's struct need not persist.
 */
void ard_dht22_set_io(const ard_dht22_io_t *io);

/**
 * @brief Initialise the DHT22 driver and register ARD_SOURCE_TEMP in the
 *        biosignal HAL.
 *
 * Requires ard_dht22_set_io() to have been called first.
 * Safe to call multiple times (re-registers the same handler).
 *
 * @return ARD_HAL_OK   on success.
 * @return ARD_DHT22_ERR_IO  if IO callbacks are not set.
 */
int ard_dht22_init(void);

/**
 * @brief Read one sample from the DHT22 sensor.
 *
 * Issues the single-wire start sequence, receives 40 bits, verifies the
 * checksum, and fills @p out.
 *
 * @param[out] out  Destination for the reading.  Must not be NULL.
 *
 * @return ARD_HAL_OK             on success.
 * @return ARD_DHT22_ERR_IO       if IO callbacks not set.
 * @return ARD_DHT22_ERR_TIMEOUT  if any pulse timed out.
 * @return ARD_DHT22_ERR_CHECKSUM if frame checksum mismatch.
 * @return ARD_DHT22_ERR_RANGE    if decoded values are out of range.
 */
int ard_dht22_read(ard_dht22_reading_t *out);

/**
 * @brief HAL read function — registered as the ARD_SOURCE_TEMP handler.
 *
 * Called by ard_hal_biosignal_read(ARD_SOURCE_TEMP, &s).
 * Fills s.value.temp.celsius and s.value.temp.humidity_pct.
 *
 * @param[out] out  Biosignal sample to populate.
 *
 * @return ARD_HAL_OK or a negative DHT22 error code.
 */
int ard_hal_temp_read(ard_biosignal_sample_t *out);

/**
 * @brief Reset driver state — for unit tests only.
 *
 * Clears IO callbacks so subsequent init/read calls return ARD_DHT22_ERR_IO.
 */
void ard_dht22_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* ARD_DHT22_HAL_H */

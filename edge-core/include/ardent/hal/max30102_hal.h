/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * max30102_hal.h — MAX30102 pulse-oximeter / heart-rate driver
 *
 * Provides a hardware-abstracted driver for the MAX30102 optical sensor
 * (Maxim Integrated).  The driver reads RED and IR channels from the FIFO,
 * computes:
 *   - BPM   via a simplified Pan-Tompkins peak-detection algorithm
 *   - SpO₂  via the empirical ratio-of-ratios formula: SpO₂ = 110 - 25*R
 *             where R = (AC_red/DC_red) / (AC_ir/DC_ir)
 *
 * Design:
 *   - I2C is accessed through the same injected callbacks as mpu6050_hal
 *     (ard_i2c_write_fn_t / ard_i2c_read_fn_t from mpu6050_hal.h).
 *   - Zero malloc: all state lives in a static context (one sensor per system).
 *   - Sliding window of ARD_MAX30102_WINDOW_SIZE samples (100 = 4 s @ 25 Hz).
 *   - ard_hal_hr_read() returns ARD_HR_ERR_NODATA during warm-up (< 100 samples).
 *   - Auto-registers with the biosignal HAL on successful init.
 *
 * Error codes:
 *   ARD_HR_ERR_I2C    (-1) — I2C communication failure
 *   ARD_HR_ERR_ID     (-2) — PART_ID returned unexpected value (not 0x15)
 *   ARD_HR_ERR_NODATA (-3) — FIFO empty or window warming up
 * -------------------------------------------------------------------------
 */

#ifndef ARD_MAX30102_HAL_H
#define ARD_MAX30102_HAL_H

#include <stdint.h>
#include "ardent/hal/ard_biosignal_hal.h"
#include "ardent/hal/mpu6050_hal.h"   /* reuse ard_i2c_write_fn_t / ard_i2c_read_fn_t */

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** Fixed I2C address (cannot be changed by hardware). */
#define ARD_MAX30102_I2C_ADDR      0x57U

/** Expected value of the PART_ID register (0xFF). */
#define ARD_MAX30102_PART_ID       0x15U

/** Sliding window size in samples.  100 samples = 4 s at 25 Hz. */
#define ARD_MAX30102_WINDOW_SIZE   100U

/** Effective output sample rate after FIFO averaging (Hz). */
#define ARD_MAX30102_SAMPLE_RATE   25U

/* -------------------------------------------------------------------------
 * Error codes
 * ------------------------------------------------------------------------- */

#define ARD_HR_ERR_I2C     (-1)   /**< I2C bus error                    */
#define ARD_HR_ERR_ID      (-2)   /**< PART_ID mismatch                 */
#define ARD_HR_ERR_NODATA  (-4)   /**< FIFO empty or window warming up  */

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * @brief Inject I2C implementation callbacks.
 *
 * Must be called before ard_max30102_init().
 * On Arduino targets pass Wire-based wrappers; in unit tests pass mocks.
 *
 * @param write_fn  Single-register write callback.  Must not be NULL.
 * @param read_fn   Burst-read callback.  Must not be NULL.
 */
void ard_max30102_set_i2c(ard_i2c_write_fn_t write_fn,
                             ard_i2c_read_fn_t  read_fn);

/**
 * @brief Initialise the MAX30102.
 *
 * Sequence:
 *   1. Read PART_ID (0xFF) — must be 0x15.
 *   2. Reset the device (MODE_CONFIG bit 6).
 *   3. Configure SpO2 mode @ 25 Hz (4-sample FIFO average), ±8192 nA range,
 *      18-bit ADC, RED and IR LEDs at ~7.2 mA.
 *   4. Reset FIFO pointers.
 *   5. Register ard_hal_hr_read as the ARD_SOURCE_HR handler.
 *
 * @return ARD_HAL_OK, ARD_HR_ERR_I2C, or ARD_HR_ERR_ID.
 */
int ard_max30102_init(void);

/**
 * @brief Read one sample from the FIFO and update BPM / SpO₂ estimates.
 *
 * Reads a single RED + IR sample (6 bytes) from the hardware FIFO and
 * appends it to the sliding window.  Once the window is full (100 samples),
 * BPM and SpO₂ are recomputed on every call.
 *
 * @param out  Output biosignal sample.
 *             out->value.hr.bpm    = current BPM estimate (0 if no peaks).
 *             out->value.hr.rr_ms  = mean RR interval in ms (0 if no peaks).
 *
 * @return ARD_HAL_OK      — sample ready, out filled.
 *         ARD_HR_ERR_NODATA — FIFO empty or window still warming up.
 *         ARD_HR_ERR_I2C  — I2C failure.
 */
int ard_hal_hr_read(ard_biosignal_sample_t *out);

/**
 * @brief Return the last computed SpO₂ percentage.
 *
 * Valid only after window_count >= ARD_MAX30102_WINDOW_SIZE.
 *
 * @return SpO₂ in [0.0, 100.0].  Returns 0.0 before first computation.
 */
float ard_max30102_get_spo2(void);

/**
 * @brief Reset driver state (clears window, BPM, SpO₂).
 *
 * Intended for unit-test isolation.  Does not communicate with hardware.
 */
void ard_max30102_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* ARD_MAX30102_HAL_H */

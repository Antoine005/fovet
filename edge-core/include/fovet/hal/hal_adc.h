/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#ifndef FOVET_HAL_ADC_H
#define FOVET_HAL_ADC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Initialize ADC peripheral.
 * Must be called once before any hal_adc_read().
 */
void hal_adc_init(void);

/**
 * @brief Read raw ADC value from a channel.
 * @param channel ADC channel index (platform-defined)
 * @return Raw ADC value (resolution is platform-dependent, typically 12-bit)
 */
uint16_t hal_adc_read(uint8_t channel);

/**
 * @brief Convert raw ADC value to millivolts.
 * @param raw    Raw ADC value from hal_adc_read()
 * @param vref_mv Reference voltage in millivolts (e.g. 3300)
 * @return Voltage in millivolts
 */
uint16_t hal_adc_to_mv(uint16_t raw, uint16_t vref_mv);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_HAL_ADC_H */

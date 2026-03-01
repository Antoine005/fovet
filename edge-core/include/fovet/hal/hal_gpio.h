/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#ifndef FOVET_HAL_GPIO_H
#define FOVET_HAL_GPIO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    HAL_GPIO_MODE_INPUT  = 0,
    HAL_GPIO_MODE_OUTPUT = 1,
} hal_gpio_mode_t;

typedef enum {
    HAL_GPIO_LOW  = 0,
    HAL_GPIO_HIGH = 1,
} hal_gpio_level_t;

/**
 * @brief Configure a GPIO pin mode.
 * @param pin  Pin number (platform-defined)
 * @param mode Input or Output
 */
void hal_gpio_set_mode(uint8_t pin, hal_gpio_mode_t mode);

/**
 * @brief Write a level to an output GPIO pin.
 * @param pin   Pin number
 * @param level HAL_GPIO_LOW or HAL_GPIO_HIGH
 */
void hal_gpio_write(uint8_t pin, hal_gpio_level_t level);

/**
 * @brief Read the level of an input GPIO pin.
 * @param pin Pin number
 * @return HAL_GPIO_LOW or HAL_GPIO_HIGH
 */
hal_gpio_level_t hal_gpio_read(uint8_t pin);

/**
 * @brief Toggle an output GPIO pin.
 * @param pin Pin number
 */
void hal_gpio_toggle(uint8_t pin);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_HAL_GPIO_H */

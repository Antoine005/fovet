/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * biosignal_hal.c — Generic biosignal HAL implementation
 *
 * Static registry of ard_hal_read_fn_t callbacks, one slot per source type.
 * Zero malloc, zero global state except the registry array.
 * -------------------------------------------------------------------------
 */

#include "ardent/hal/ard_biosignal_hal.h"

/* -------------------------------------------------------------------------
 * Static registry — one function pointer per source type
 * ------------------------------------------------------------------------- */

static ard_hal_read_fn_t s_registry[ARD_BIOSIGNAL_SOURCE_COUNT] = {
    NULL, /* ARD_SOURCE_IMU  */
    NULL, /* ARD_SOURCE_HR   */
    NULL, /* ARD_SOURCE_TEMP */
    NULL, /* ARD_SOURCE_ECG  */
};

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

int ard_hal_biosignal_register(ard_biosignal_source_t type,
                                  ard_hal_read_fn_t      fn)
{
    if (fn == NULL)
        return ARD_HAL_ERR_NULL;
    if ((unsigned)type >= ARD_BIOSIGNAL_SOURCE_COUNT)
        return ARD_HAL_ERR_TYPE;

    s_registry[type] = fn;
    return ARD_HAL_OK;
}

int ard_hal_biosignal_read(ard_biosignal_source_t  type,
                              ard_biosignal_sample_t *out)
{
    if (out == NULL)
        return ARD_HAL_ERR_NULL;
    if ((unsigned)type >= ARD_BIOSIGNAL_SOURCE_COUNT)
        return ARD_HAL_ERR_TYPE;
    if (s_registry[type] == NULL)
        return ARD_HAL_ERR_NOREG;

    return s_registry[type](out);
}

void ard_hal_biosignal_reset(void)
{
    unsigned i;
    for (i = 0; i < ARD_BIOSIGNAL_SOURCE_COUNT; i++)
        s_registry[i] = NULL;
}

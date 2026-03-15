/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * biosignal_hal.c — Generic biosignal HAL implementation
 *
 * Static registry of fovet_hal_read_fn_t callbacks, one slot per source type.
 * Zero malloc, zero global state except the registry array.
 * -------------------------------------------------------------------------
 */

#include "fovet/hal/fovet_biosignal_hal.h"

/* -------------------------------------------------------------------------
 * Static registry — one function pointer per source type
 * ------------------------------------------------------------------------- */

static fovet_hal_read_fn_t s_registry[FOVET_BIOSIGNAL_SOURCE_COUNT] = {
    NULL, /* FOVET_SOURCE_IMU  */
    NULL, /* FOVET_SOURCE_HR   */
    NULL, /* FOVET_SOURCE_TEMP */
    NULL, /* FOVET_SOURCE_ECG  */
};

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

int fovet_hal_biosignal_register(fovet_biosignal_source_t type,
                                  fovet_hal_read_fn_t      fn)
{
    if (fn == NULL)
        return FOVET_HAL_ERR_NULL;
    if ((unsigned)type >= FOVET_BIOSIGNAL_SOURCE_COUNT)
        return FOVET_HAL_ERR_TYPE;

    s_registry[type] = fn;
    return FOVET_HAL_OK;
}

int fovet_hal_biosignal_read(fovet_biosignal_source_t  type,
                              fovet_biosignal_sample_t *out)
{
    if (out == NULL)
        return FOVET_HAL_ERR_NULL;
    if ((unsigned)type >= FOVET_BIOSIGNAL_SOURCE_COUNT)
        return FOVET_HAL_ERR_TYPE;
    if (s_registry[type] == NULL)
        return FOVET_HAL_ERR_NOREG;

    return s_registry[type](out);
}

void fovet_hal_biosignal_reset(void)
{
    unsigned i;
    for (i = 0; i < FOVET_BIOSIGNAL_SOURCE_COUNT; i++)
        s_registry[i] = NULL;
}

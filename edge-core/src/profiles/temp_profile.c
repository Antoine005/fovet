/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * temp_profile.c — WBGT-based thermal stress profile implementation (H3.3)
 * -------------------------------------------------------------------------
 */

#include "ardent/profiles/temp_profile.h"
#include "ardent/hal/dht22_hal.h"   /* FOVET_DHT22_ERR_* */

#include <math.h>
#include <string.h>
#include <stddef.h>

/* -------------------------------------------------------------------------
 * ard_temp_default_config
 * ------------------------------------------------------------------------- */

ard_temp_config_t ard_temp_default_config(void)
{
    ard_temp_config_t cfg;
    cfg.wbgt_warn_c            = ARD_TEMP_DEFAULT_WBGT_WARN_C;
    cfg.wbgt_danger_c          = ARD_TEMP_DEFAULT_WBGT_DANGER_C;
    cfg.cold_alert_c           = ARD_TEMP_DEFAULT_COLD_ALERT_C;
    cfg.ema_alpha              = ARD_TEMP_DEFAULT_EMA_ALPHA;
    cfg.warmup_samples         = ARD_TEMP_DEFAULT_WARMUP;
    cfg.sleep_between_ticks_ms = ARD_TEMP_DEFAULT_SLEEP_MS;
    return cfg;
}

/* -------------------------------------------------------------------------
 * ard_temp_compute_wbgt
 *
 * Stull (2011) indoor WBGT approximation.
 *   NWB = T * atan(0.151977 * sqrt(H + 8.313659))
 *           + atan(T + H)
 *           - atan(H - 1.676331)
 *           + 0.00391838 * H^1.5 * atan(0.023101 * H)
 *           - 4.686035
 *   WBGT = 0.7 * NWB + 0.3 * T
 * ------------------------------------------------------------------------- */

float ard_temp_compute_wbgt(float celsius, float humidity_pct)
{
    float t = celsius;
    float h = humidity_pct;

    float nwb =
        t * atanf(0.151977f * sqrtf(h + 8.313659f))
        + atanf(t + h)
        - atanf(h - 1.676331f)
        + 0.00391838f * powf(h, 1.5f) * atanf(0.023101f * h)
        - 4.686035f;

    return 0.7f * nwb + 0.3f * t;
}

/* -------------------------------------------------------------------------
 * ard_temp_init
 * ------------------------------------------------------------------------- */

void ard_temp_init(ard_temp_ctx_t           *ctx,
                     const ard_temp_config_t  *cfg,
                     ard_temp_alert_fn_t       alert_fn,
                     ard_temp_led_fn_t         led_fn,
                     ard_temp_sleep_fn_t       sleep_fn,
                     void                       *user_data)
{
    if (ctx == NULL)
        return;

    memset(ctx, 0, sizeof(*ctx));

    ctx->config     = (cfg != NULL) ? *cfg : ard_temp_default_config();
    ctx->alert_fn   = alert_fn;
    ctx->led_fn     = led_fn;
    ctx->sleep_fn   = sleep_fn;
    ctx->user_data  = user_data;
    ctx->last_level = ARD_TEMP_LEVEL_UNKNOWN;
}

/* -------------------------------------------------------------------------
 * ard_temp_tick
 * ------------------------------------------------------------------------- */

int ard_temp_tick(ard_temp_ctx_t *ctx)
{
    ard_biosignal_sample_t sample;
    int rc;

    /* 1. Read TEMP biosignal */
    rc = ard_hal_biosignal_read(ARD_SOURCE_TEMP, &sample);

    /* 2. Transient errors (timeout / checksum / range) — skip this tick.
     *    These are recoverable; try again on the next cycle.             */
    if (rc == ARD_DHT22_ERR_TIMEOUT  ||
        rc == ARD_DHT22_ERR_CHECKSUM ||
        rc == ARD_DHT22_ERR_RANGE)
    {
        if (ctx->sleep_fn != NULL)
            ctx->sleep_fn(ctx->config.sleep_between_ticks_ms);
        return ARD_HAL_OK;
    }

    if (rc != ARD_HAL_OK)
        return rc;   /* Unexpected error (e.g. ERR_IO — not recoverable) */

    {
        float celsius      = sample.value.temp.celsius;
        float humidity_pct = sample.value.temp.humidity_pct;
        ard_temp_level_t new_level;
        float wbgt;

        /* 3. Update EMA temperature — seed with first valid sample */
        if (ctx->sample_count == 0U)
            ctx->ema_celsius = celsius;
        else
            ctx->ema_celsius = ctx->config.ema_alpha * celsius
                             + (1.0f - ctx->config.ema_alpha) * ctx->ema_celsius;

        /* 4. Increment sample counter */
        ctx->sample_count++;

        /* 5. Classify */
        if (ctx->sample_count < ctx->config.warmup_samples)
        {
            new_level = ARD_TEMP_LEVEL_UNKNOWN;
        }
        else if (ctx->ema_celsius <= ctx->config.cold_alert_c)
        {
            /* Cold check takes priority over WBGT */
            new_level = ARD_TEMP_LEVEL_COLD;
        }
        else
        {
            /* Compute WBGT from EMA temperature + current humidity */
            wbgt = ard_temp_compute_wbgt(ctx->ema_celsius, humidity_pct);

            if (wbgt >= ctx->config.wbgt_danger_c)
                new_level = ARD_TEMP_LEVEL_DANGER;
            else if (wbgt >= ctx->config.wbgt_warn_c)
                new_level = ARD_TEMP_LEVEL_WARN;
            else
                new_level = ARD_TEMP_LEVEL_SAFE;
        }

        /* 6. Alert on level change */
        if (new_level != ctx->last_level)
        {
            if (ctx->alert_fn != NULL && new_level != ARD_TEMP_LEVEL_UNKNOWN)
                ctx->alert_fn(new_level, ctx->user_data);
        }

        ctx->last_level = new_level;

        /* 7. LED update every tick (when level known) */
        if (new_level != ARD_TEMP_LEVEL_UNKNOWN && ctx->led_fn != NULL)
            ctx->led_fn(new_level);
    }

    /* 8. Optional sleep */
    if (ctx->sleep_fn != NULL)
        ctx->sleep_fn(ctx->config.sleep_between_ticks_ms);

    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_temp_get_level
 * ------------------------------------------------------------------------- */

ard_temp_level_t ard_temp_get_level(const ard_temp_ctx_t *ctx)
{
    if (ctx == NULL)
        return ARD_TEMP_LEVEL_UNKNOWN;
    return ctx->last_level;
}

/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * fatigue_profile.c — HRV-based fatigue profile implementation
 * -------------------------------------------------------------------------
 */

#include "ardent/profiles/fatigue_profile.h"
#include "ardent/hal/max30102_hal.h"   /* ARD_HR_ERR_NODATA */

#include <string.h>
#include <stddef.h>

/* -------------------------------------------------------------------------
 * ard_fatigue_default_config
 * ------------------------------------------------------------------------- */

ard_fatigue_config_t ard_fatigue_default_config(void)
{
    ard_fatigue_config_t cfg;
    cfg.hr_ok                  = ARD_FATIGUE_DEFAULT_HR_OK;
    cfg.hr_alert               = ARD_FATIGUE_DEFAULT_HR_ALERT;
    cfg.spo2_critical          = ARD_FATIGUE_DEFAULT_SPO2_CRITICAL;
    cfg.ema_alpha              = ARD_FATIGUE_DEFAULT_EMA_ALPHA;
    cfg.warmup_samples         = ARD_FATIGUE_DEFAULT_WARMUP;
    cfg.sleep_between_ticks_ms = ARD_FATIGUE_DEFAULT_SLEEP_MS;
    return cfg;
}

/* -------------------------------------------------------------------------
 * ard_fatigue_init
 * ------------------------------------------------------------------------- */

void ard_fatigue_init(ard_fatigue_ctx_t           *ctx,
                        const ard_fatigue_config_t  *cfg,
                        ard_fatigue_alert_fn_t       alert_fn,
                        ard_fatigue_led_fn_t         led_fn,
                        ard_fatigue_sleep_fn_t       sleep_fn,
                        void                          *user_data)
{
    if (ctx == NULL)
        return;

    memset(ctx, 0, sizeof(*ctx));

    ctx->config     = (cfg != NULL) ? *cfg : ard_fatigue_default_config();
    ctx->alert_fn   = alert_fn;
    ctx->led_fn     = led_fn;
    ctx->sleep_fn   = sleep_fn;
    ctx->user_data  = user_data;
    ctx->last_level = ARD_FATIGUE_LEVEL_UNKNOWN;
}

/* -------------------------------------------------------------------------
 * ard_fatigue_tick
 * ------------------------------------------------------------------------- */

int ard_fatigue_tick(ard_fatigue_ctx_t *ctx)
{
    ard_biosignal_sample_t sample;
    int rc;

    /* 1. Read HR biosignal */
    rc = ard_hal_biosignal_read(ARD_SOURCE_HR, &sample);

    /* 2. NODATA = sensor warming up — not an error, skip this tick */
    if (rc == ARD_HR_ERR_NODATA)
    {
        if (ctx->sleep_fn != NULL)
            ctx->sleep_fn(ctx->config.sleep_between_ticks_ms);
        return ARD_HAL_OK;
    }

    if (rc != ARD_HAL_OK)
        return rc;   /* I2C or other hard error */

    {
        float bpm  = sample.value.hr.bpm;
        float spo2 = sample.value.hr.spo2;
        ard_fatigue_level_t new_level;

        /* 3. Update EMA — seed with first valid sample */
        if (ctx->sample_count == 0U)
            ctx->ema_bpm = bpm;
        else
            ctx->ema_bpm = ctx->config.ema_alpha * bpm
                         + (1.0f - ctx->config.ema_alpha) * ctx->ema_bpm;

        /* 4. Increment sample counter */
        ctx->sample_count++;

        /* 5. Classify (warmup guard) */
        if (ctx->sample_count < ctx->config.warmup_samples)
        {
            new_level = ARD_FATIGUE_LEVEL_UNKNOWN;
        }
        else if (spo2 > 0.0f && spo2 < ctx->config.spo2_critical)
        {
            /* 6. SpO2 check takes priority */
            new_level = ARD_FATIGUE_LEVEL_CRITICAL;
        }
        else if (ctx->ema_bpm > ctx->config.hr_alert)
        {
            new_level = ARD_FATIGUE_LEVEL_CRITICAL;
        }
        else if (ctx->ema_bpm >= ctx->config.hr_ok)
        {
            new_level = ARD_FATIGUE_LEVEL_ALERT;
        }
        else
        {
            new_level = ARD_FATIGUE_LEVEL_OK;
        }

        /* 7. Alert on level change */
        if (new_level != ctx->last_level)
        {
            if (ctx->alert_fn != NULL && new_level != ARD_FATIGUE_LEVEL_UNKNOWN)
                ctx->alert_fn(new_level, ctx->user_data);
        }

        ctx->last_level = new_level;

        /* 8. LED update every tick (when level known) */
        if (new_level != ARD_FATIGUE_LEVEL_UNKNOWN && ctx->led_fn != NULL)
            ctx->led_fn(new_level);
    }

    /* 9. Optional sleep */
    if (ctx->sleep_fn != NULL)
        ctx->sleep_fn(ctx->config.sleep_between_ticks_ms);

    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_fatigue_get_level
 * ------------------------------------------------------------------------- */

ard_fatigue_level_t ard_fatigue_get_level(const ard_fatigue_ctx_t *ctx)
{
    if (ctx == NULL)
        return ARD_FATIGUE_LEVEL_UNKNOWN;
    return ctx->last_level;
}

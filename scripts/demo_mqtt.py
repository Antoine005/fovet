#!/usr/bin/env python3
"""
Fovet Vigie — Demo MQTT Publisher (U5)

Simule trois flux capteurs réalistes pour un dispositif de démonstration :
  - IMU  (sensorType=IMU)  : accéléromètre, détection chute/immobilité, 1 Hz
  - HR   (sensorType=HR)   : fréquence cardiaque BPM, 0.5 Hz
  - TEMP (sensorType=TEMP) : température + humidité DHT22, 0.33 Hz

Chaque lecture publie zScore (Welford) ET madScore (MAD fenêtré, win=32).
Cela permet de comparer les deux détecteurs sur le même signal en temps réel :
  - zScore : Welford — sensible aux outliers passés accumulés
  - madScore : médiane glissante — robuste, insensible aux outliers précédents

Publie sur le topic : fovet/devices/<mqttClientId>/readings

Usage :
  pip install paho-mqtt python-dotenv   # une seule fois
  python scripts/demo_mqtt.py

  # ou sans installation (uv) :
  uv run --with paho-mqtt --with python-dotenv scripts/demo_mqtt.py

  # options :
  python scripts/demo_mqtt.py --broker mqtt://localhost:1883 \\
      --device demo-001 --interval 2 --no-anomalies

Prérequis :
  1. Le dispositif <mqttClientId> doit exister dans la BDD.
     Créer via : curl -b cookies.txt -X POST http://localhost:3000/api/devices \\
       -H "Content-Type: application/json" \\
       -d '{"name":"Démo Travailleur","mqttClientId":"demo-001","location":"Zone démo"}'
  2. Broker Mosquitto actif (service Windows ou npm start dans platform-dashboard)
"""

import argparse
import json
import math
import os
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

try:
    import paho.mqtt.client as mqtt
except ImportError:
    raise SystemExit("paho-mqtt requis — pip install paho-mqtt")

try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "platform-dashboard", ".env"))
except ImportError:
    pass  # python-dotenv optionnel


# ---------------------------------------------------------------------------
# Welford running stats — même algorithme que zscore.c
# ---------------------------------------------------------------------------

class Welford:
    def __init__(self) -> None:
        self.count = 0
        self.mean  = 0.0
        self._M2   = 0.0

    def update(self, x: float) -> None:
        self.count += 1
        delta      = x - self.mean
        self.mean += delta / self.count
        self._M2  += delta * (x - self.mean)

    @property
    def stddev(self) -> float:
        if self.count < 2:
            return 0.0
        return math.sqrt(self._M2 / (self.count - 1))

    def zscore(self, x: float) -> float:
        s = self.stddev
        if s < 1e-6:
            return 0.0
        return abs(x - self.mean) / s


# ---------------------------------------------------------------------------
# StreamingMAD — miroir Python de fovet_mad C99 (mad.h / mad.c)
#
# Utilise un ring buffer de taille fixe (win_size).  Score calculé AVANT
# insertion du sample, comme dans fovet_mad_update().
# ---------------------------------------------------------------------------

class StreamingMAD:
    """Rolling MAD anomaly scorer.

    Mirrors fovet_mad_update() exactly:
    - score is computed against the CURRENT window (before inserting the new sample)
    - returns 0.0 during warm-up (fewer than win_size samples)
    score = |x - median| / (1.4826 * MAD)
    """

    def __init__(self, win_size: int = 32) -> None:
        self._win  = win_size
        self._buf: list[float] = []

    def update(self, x: float) -> float:
        """Add sample, return MAD score (0.0 during warm-up)."""
        score = 0.0
        if len(self._buf) >= self._win:
            score = self._score(x, self._buf[-self._win:])
        # Add to ring buffer
        self._buf.append(x)
        if len(self._buf) > self._win:
            self._buf = self._buf[-self._win:]
        return score

    @staticmethod
    def _score(value: float, window: list[float]) -> float:
        n = len(window)
        if n == 0:
            return 0.0
        sorted_w = sorted(window)
        mid = n // 2
        med = sorted_w[mid] if n % 2 == 1 else (sorted_w[mid - 1] + sorted_w[mid]) / 2.0
        abs_devs = sorted([abs(v - med) for v in sorted_w])
        mid2 = len(abs_devs) // 2
        mad = abs_devs[mid2] if len(abs_devs) % 2 == 1 else (abs_devs[mid2 - 1] + abs_devs[mid2]) / 2.0
        deviation = abs(value - med)
        if mad < 1e-9:
            return 0.0 if deviation < 1e-9 else 1e9
        return deviation / (1.4826 * mad)


# ---------------------------------------------------------------------------
# WBGT Stull (2011) — identique à temp_profile.c et TempCard.tsx
# ---------------------------------------------------------------------------

def compute_wbgt(celsius: float, humidity_pct: float) -> float:
    H, T = humidity_pct, celsius
    nwb = (
        T * math.atan(0.151977 * math.sqrt(H + 8.313659))
        + math.atan(T + H)
        - math.atan(H - 1.676331)
        + 0.00391838 * H ** 1.5 * math.atan(0.023101 * H)
        - 4.686035
    )
    return 0.7 * nwb + 0.3 * T


# ---------------------------------------------------------------------------
# EMA
# ---------------------------------------------------------------------------

def ema_update(prev: Optional[float], x: float, alpha: float) -> float:
    if prev is None:
        return x
    return alpha * x + (1.0 - alpha) * prev


# ---------------------------------------------------------------------------
# Simulation state
# ---------------------------------------------------------------------------

@dataclass
class SimState:
    welford:      Welford      = field(default_factory=Welford)
    mad:          StreamingMAD = field(default_factory=StreamingMAD)
    ema:          Optional[float] = None
    sample_count: int = 0
    anomaly_due:  bool = False      # inject anomaly on next tick
    pti_type_due: Optional[str] = None   # "FALL" | "MOTIONLESS" | "SOS"


# ---------------------------------------------------------------------------
# ANSI colours for console output
# ---------------------------------------------------------------------------

C_RESET  = "\033[0m"
C_GREEN  = "\033[32m"
C_AMBER  = "\033[33m"
C_RED    = "\033[31m"
C_BLUE   = "\033[34m"
C_GRAY   = "\033[90m"
C_BOLD   = "\033[1m"

def level_color(level: str) -> str:
    return {
        "SAFE": C_GREEN, "WARN": C_AMBER, "DANGER": C_RED,
        "COLD": C_BLUE,  "CRITICAL": C_RED,
    }.get(level, C_GRAY)


# ---------------------------------------------------------------------------
# Publish helper
# ---------------------------------------------------------------------------

def publish(client: mqtt.Client, device_id: str, payload: dict, label: str) -> None:
    topic   = f"fovet/devices/{device_id}/readings"
    message = json.dumps(payload)
    client.publish(topic, message, qos=1)

    level  = payload.get("level", "SAFE")
    color  = level_color(level)
    module = payload.get("sensorType", "?")
    val    = payload.get("value", 0)
    z      = payload.get("zScore", 0.0)
    mad_s  = payload.get("madScore", 0.0)
    extra  = f"  ptiType={payload['ptiType']}" if payload.get("ptiType") else ""
    print(
        f"{C_GRAY}{time.strftime('%H:%M:%S')}{C_RESET}  "
        f"{C_BOLD}{module:4s}{C_RESET}  "
        f"{label:<22s}  "
        f"val={val:6.2f}  z={z:.2f}  mad={mad_s:.2f}  "
        f"{color}{level}{C_RESET}{extra}"
    )


# ---------------------------------------------------------------------------
# Module threads
# ---------------------------------------------------------------------------

def run_imu(client: mqtt.Client, device_id: str, interval: float,
            state: SimState, stop_event: threading.Event) -> None:
    """Accéléromètre — magnitude g. Profil PTI H1."""
    while not stop_event.is_set():
        val = random.gauss(1.0, 0.05)   # standing still ≈ 1 g

        # Inject anomaly if scheduled
        pti_type = None
        if state.anomaly_due:
            choice = state.pti_type_due or random.choice(["FALL", "SOS", "MOTIONLESS"])
            if choice == "FALL":
                val = random.uniform(3.5, 6.0)   # impact spike
            elif choice == "MOTIONLESS":
                val = random.gauss(1.0, 0.01)    # very still
            pti_type          = choice
            state.anomaly_due = False
            state.pti_type_due = None

        mad_score = state.mad.update(val)
        state.welford.update(val)
        z       = state.welford.zscore(val)
        anomaly = z > 3.0 or pti_type is not None

        level = "SAFE"
        if pti_type in ("FALL", "SOS"):
            level = "CRITICAL"
        elif pti_type == "MOTIONLESS":
            level = "WARN"

        payload: dict = {
            "value":      round(val, 4),
            "mean":       round(state.welford.mean, 4),
            "stddev":     round(state.welford.stddev, 4),
            "zScore":     round(z, 4),
            "madScore":   round(mad_score, 4),
            "anomaly":    anomaly,
            "sensorType": "IMU",
            "level":      level,
            # Canonical v2 — manifest fields for Vigie auto-scaling
            "model_id":   "demo-imu-accel",
            "unit":       "g",
            "value_min":  0.0,
            "value_max":  6.0,
        }
        if pti_type:
            payload["ptiType"] = pti_type

        label = f"accel={val:.3f}g"
        publish(client, device_id, payload, label)
        stop_event.wait(interval)


def run_hr(client: mqtt.Client, device_id: str, interval: float,
           state: SimState, stop_event: threading.Event) -> None:
    """Fréquence cardiaque BPM — profil Fatigue H2."""
    EMA_ALPHA   = 0.05
    WARMUP      = 25
    HR_OK       = 72.0
    HR_CRITICAL = 82.0

    while not stop_event.is_set():
        bpm = random.gauss(65.0, 3.0)

        if state.anomaly_due:
            bpm              = random.uniform(88.0, 105.0)
            state.anomaly_due = False

        mad_score    = state.mad.update(bpm)
        state.ema    = ema_update(state.ema, bpm, EMA_ALPHA)
        ema_bpm      = state.ema
        state.sample_count += 1
        state.welford.update(bpm)
        z = state.welford.zscore(bpm)

        level = "SAFE"
        if state.sample_count >= WARMUP:
            if ema_bpm > HR_CRITICAL:
                level = "CRITICAL"
            elif ema_bpm >= HR_OK:
                level = "WARN"

        payload = {
            "value":      round(bpm, 2),
            "mean":       round(state.welford.mean, 2),
            "stddev":     round(state.welford.stddev, 2),
            "zScore":     round(z, 4),
            "madScore":   round(mad_score, 4),
            "anomaly":    z > 3.0,
            "sensorType": "HR",
            "level":      level,
            # Canonical v2 — manifest fields for Vigie auto-scaling
            "model_id":   "demo-hr-bpm",
            "unit":       "bpm",
            "value_min":  40.0,
            "value_max":  120.0,
        }
        label = f"bpm={bpm:.1f} ema={ema_bpm:.1f}"
        publish(client, device_id, payload, label)
        stop_event.wait(interval)


def run_temp(client: mqtt.Client, device_id: str, interval: float,
             state: SimState, stop_event: threading.Event) -> None:
    """Température + humidité DHT22 — profil Thermique H3."""
    EMA_ALPHA    = 0.10
    WARMUP       = 10
    WBGT_WARN    = 25.0
    WBGT_DANGER  = 28.0
    COLD_ALERT   = 10.0

    celsius_base  = 22.0
    humidity_base = 55.0

    while not stop_event.is_set():
        celsius  = random.gauss(celsius_base, 0.5)
        humidity = max(20.0, min(95.0, random.gauss(humidity_base, 2.0)))

        if state.anomaly_due:
            celsius           = random.uniform(34.0, 37.0)
            humidity          = random.uniform(75.0, 90.0)
            state.anomaly_due = False

        mad_score          = state.mad.update(celsius)
        state.ema          = ema_update(state.ema, celsius, EMA_ALPHA)
        ema_c              = state.ema
        state.sample_count += 1
        state.welford.update(celsius)
        z    = state.welford.zscore(celsius)
        wbgt = compute_wbgt(ema_c, humidity)

        level = "SAFE"
        if state.sample_count >= WARMUP:
            if ema_c <= COLD_ALERT:
                level = "COLD"
            elif wbgt >= WBGT_DANGER:
                level = "DANGER"
            elif wbgt >= WBGT_WARN:
                level = "WARN"

        payload = {
            "value":      round(celsius, 2),
            "value2":     round(humidity, 1),
            "mean":       round(state.welford.mean, 2),
            "stddev":     round(state.welford.stddev, 2),
            "zScore":     round(z, 4),
            "madScore":   round(mad_score, 4),
            "anomaly":    z > 3.0,
            "sensorType": "TEMP",
            "level":      level,
            # Canonical v2 — manifest fields for Vigie auto-scaling
            "model_id":   "demo-temp-celsius",
            "unit":       "C",
            "value_min":  10.0,
            "value_max":  40.0,
        }
        label = f"t={celsius:.1f}°C h={humidity:.0f}% wbgt={wbgt:.1f}"
        publish(client, device_id, payload, label)
        stop_event.wait(interval)


# ---------------------------------------------------------------------------
# Anomaly scheduler — injects one anomaly per module every ~anomaly_period s
# ---------------------------------------------------------------------------

def anomaly_scheduler(states: dict[str, SimState], period: float,
                      stop_event: threading.Event) -> None:
    pti_types = ["FALL", "SOS", "MOTIONLESS"]
    cycle     = 0
    while not stop_event.is_set():
        stop_event.wait(period)
        if stop_event.is_set():
            break
        module = ["imu", "hr", "temp"][cycle % 3]
        cycle += 1
        st = states[module]
        st.anomaly_due = True
        if module == "imu":
            st.pti_type_due = random.choice(pti_types)
            print(f"\n{C_RED}[ANOMALY] Injection PTI {st.pti_type_due} dans 1 tick IMU{C_RESET}\n")
        elif module == "hr":
            print(f"\n{C_AMBER}[ANOMALY] Injection fatigue (BPM élevé) dans 1 tick HR{C_RESET}\n")
        else:
            print(f"\n{C_RED}[ANOMALY] Injection chaleur (WBGT danger) dans 1 tick TEMP{C_RESET}\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fovet Vigie — Demo MQTT Publisher")
    p.add_argument(
        "--broker", default=os.getenv("MQTT_BROKER_URL", "mqtt://localhost:1883"),
        help="URL broker MQTT (défaut: mqtt://localhost:1883)"
    )
    p.add_argument(
        "--device", default="demo-001",
        help="mqttClientId du dispositif démo (défaut: demo-001)"
    )
    p.add_argument(
        "--interval", type=float, default=2.0,
        help="Intervalle de base entre lectures en secondes (défaut: 2.0)"
    )
    p.add_argument(
        "--anomaly-period", type=float, default=30.0,
        help="Injecter une anomalie toutes les N secondes (défaut: 30)"
    )
    p.add_argument(
        "--no-anomalies", action="store_true",
        help="Désactiver l'injection d'anomalies"
    )
    return p.parse_args()


def broker_host_port(url: str) -> tuple[str, int]:
    """Parse mqtt://host:port → (host, port)."""
    url = url.removeprefix("mqtt://").removeprefix("mqtts://")
    if ":" in url:
        host, port_str = url.rsplit(":", 1)
        return host, int(port_str)
    return url, 1883


def main() -> None:
    args = parse_args()
    host, port = broker_host_port(args.broker)

    print(f"{C_BOLD}Fovet Vigie — Demo MQTT Publisher{C_RESET}")
    print(f"  Broker  : {args.broker} ({host}:{port})")
    print(f"  Device  : {args.device}")
    print(f"  Interval: {args.interval}s base (IMU ×1, HR ×2, TEMP ×3)")
    if args.no_anomalies:
        print(f"  Anomalies: désactivées")
    else:
        print(f"  Anomalies: toutes les {args.anomaly_period}s")
    print()

    # MQTT client
    client = mqtt.Client(client_id=f"fovet-demo-publisher-{os.getpid()}")
    username = os.getenv("MQTT_USERNAME", "")
    password = os.getenv("MQTT_PASSWORD", "")
    if username:
        client.username_pw_set(username, password)

    def on_connect(c, userdata, flags, rc):  # noqa: ARG001
        if rc == 0:
            print(f"{C_GREEN}[MQTT] Connecté{C_RESET}\n")
        else:
            print(f"{C_RED}[MQTT] Erreur connexion rc={rc}{C_RESET}")

    def on_disconnect(c, userdata, rc):  # noqa: ARG001
        if rc != 0:
            print(f"{C_AMBER}[MQTT] Déconnecté rc={rc}, reconnexion…{C_RESET}")

    client.on_connect    = on_connect
    client.on_disconnect = on_disconnect

    client.connect(host, port, keepalive=60)
    client.loop_start()

    # Per-module simulation state
    states: dict[str, SimState] = {
        "imu":  SimState(),
        "hr":   SimState(),
        "temp": SimState(),
    }

    stop_event = threading.Event()

    threads: list[threading.Thread] = [
        threading.Thread(target=run_imu,  args=(client, args.device, args.interval * 1, states["imu"],  stop_event), daemon=True, name="imu"),
        threading.Thread(target=run_hr,   args=(client, args.device, args.interval * 2, states["hr"],   stop_event), daemon=True, name="hr"),
        threading.Thread(target=run_temp, args=(client, args.device, args.interval * 3, states["temp"], stop_event), daemon=True, name="temp"),
    ]

    if not args.no_anomalies:
        threads.append(threading.Thread(
            target=anomaly_scheduler,
            args=(states, args.anomaly_period, stop_event),
            daemon=True, name="anomaly"
        ))

    for t in threads:
        t.start()

    print(f"{C_GRAY}Ctrl+C pour arrêter{C_RESET}\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"\n{C_GRAY}Arrêt…{C_RESET}")
    finally:
        stop_event.set()
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Fovet Vigie — Listener MQTT minimal pour test person_detection.

S'abonne à fovet/devices/+/readings et affiche chaque message en clair.
Utile pour vérifier que l'ESP32-CAM publie correctement sans avoir besoin
que le dashboard Vigie soit en cours d'exécution.

Usage :
    uv run --with paho-mqtt scripts/vigie_mqtt_listener.py
    ou (si paho-mqtt installé globalement) :
    python scripts/vigie_mqtt_listener.py

Options d'environnement :
    MQTT_BROKER   IP du broker Mosquitto  (défaut : localhost)
    MQTT_PORT     Port                    (défaut : 1883)
    MQTT_USER     Identifiant             (défaut : fovet-vigie)
    MQTT_PASSWORD Mot de passe            (défaut : vide)
    MQTT_TOPIC    Topic à écouter         (défaut : fovet/devices/+/readings)
"""

import json
import os
import sys
from datetime import datetime

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("paho-mqtt non installé. Lancer avec :")
    print("  uv run --with paho-mqtt scripts/vigie_mqtt_listener.py")
    sys.exit(1)

BROKER   = os.environ.get("MQTT_BROKER",   "localhost").strip()
PORT     = int(os.environ.get("MQTT_PORT", "1883").strip())
USER     = os.environ.get("MQTT_USER",     "fovet-vigie").strip()
PASSWORD = os.environ.get("MQTT_PASSWORD", "").strip()
TOPIC    = os.environ.get("MQTT_TOPIC",    "fovet/devices/+/readings").strip()

# Couleurs ANSI (désactivées si pas de terminal)
_tty = sys.stdout.isatty()
RED    = "\033[91m" if _tty else ""
YELLOW = "\033[93m" if _tty else ""
GREEN  = "\033[92m" if _tty else ""
CYAN   = "\033[96m" if _tty else ""
RESET  = "\033[0m"  if _tty else ""

LEVEL_COLORS = {
    "WARN":     YELLOW,
    "COLD":     CYAN,
    "DANGER":   RED,
    "CRITICAL": RED,
    "SAFE":     GREEN,
}


def on_connect(client, userdata, flags, rc, props=None):
    if rc != 0:
        print(f"{RED}[MQTT] Connexion refusée (rc={rc}){RESET}", file=sys.stderr)
        sys.exit(1)
    print(f"{GREEN}[MQTT] Connecté à {BROKER}:{PORT}{RESET}")
    client.subscribe(TOPIC)
    print(f"[MQTT] Abonné à : {TOPIC}\n")


def on_message(client, userdata, msg):
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    topic = msg.topic

    try:
        data = json.loads(msg.payload)
    except json.JSONDecodeError:
        print(f"[{ts}] {topic}  (payload non-JSON) : {msg.payload!r}")
        return

    anomaly  = data.get("anomaly", False)
    level    = (data.get("level") or "").upper()
    sensor   = data.get("sensorType", "?")
    value    = data.get("value", "?")
    z_score  = data.get("zScore", "?")

    level_color = LEVEL_COLORS.get(level, "")
    flag = f"  {RED}*** ANOMALIE ***{RESET}" if anomaly else ""

    print(f"[{ts}]  {CYAN}{topic}{RESET}{flag}")
    print(f"  sensor={sensor}  value={value}  zScore={z_score}  "
          f"level={level_color}{level or '—'}{RESET}  anomaly={anomaly}")

    # Détails complets si anomalie ou sensorType VIS (person_detection)
    if anomaly or sensor == "VIS":
        for key in ("mean", "stddev", "ts"):
            if key in data:
                print(f"  {key}={data[key]}")

    print()


def main() -> None:
    print("=== Fovet Vigie — MQTT Listener ===")
    print(f"Broker : {BROKER}:{PORT}  |  Topic : {TOPIC}")
    print("Ctrl+C pour quitter.\n")

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if USER:
        client.username_pw_set(USER, PASSWORD or None)
    client.on_connect = on_connect
    client.on_message = on_message

    try:
        client.connect(BROKER, PORT, keepalive=60)
        client.loop_forever()
    except KeyboardInterrupt:
        print("\n[MQTT] Arrêt.")
    except Exception as exc:
        print(f"{RED}[MQTT] Erreur : {exc}{RESET}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

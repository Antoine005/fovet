#!/usr/bin/env python3
"""
Fovet SDK — Sentinelle
Télécharge person_detect_model_data.cpp depuis le repo TFLite Micro Arduino Examples
et le place dans edge-core/examples/esp32/person_detection/src/model_data.cpp.

Usage :
    python scripts/get_person_model.py
    ou : uv run scripts/get_person_model.py

Le fichier généré (~300 KB) est gitignored.
"""

import urllib.request
import os
import sys

BASE_URL = (
    "https://raw.githubusercontent.com/tensorflow/"
    "tflite-micro-arduino-examples/main/examples/person_detection/"
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_DIR = os.path.join(
    SCRIPT_DIR, "..", "edge-core", "examples", "esp32", "person_detection", "src"
)
TARGET_FILE = os.path.join(TARGET_DIR, "model_data.cpp")


def download(url: str, dest: str) -> None:
    print(f"  ↓ {url}")
    try:
        urllib.request.urlretrieve(url, dest)
    except Exception as exc:
        print(f"  ✗ Échec du téléchargement : {exc}", file=sys.stderr)
        sys.exit(1)
    size_kb = os.path.getsize(dest) / 1024
    print(f"  ✓ {dest}  ({size_kb:.0f} KB)")


def patch_symbol_name(path: str) -> None:
    """Renomme les symboles pour correspondre à notre model_data.h.

    Le fichier source déclare :
        const unsigned char g_person_detect_model_data[] = { ... };
        const int g_person_detect_model_data_len = ...;

    Notre model_data.h expose exactement ces noms — aucun patch nécessaire.
    Cette fonction vérifie simplement que les symboles attendus sont présents.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    if "g_person_detect_model_data" not in content:
        print(
            "  ⚠ Symbole 'g_person_detect_model_data' non trouvé dans le fichier.",
            file=sys.stderr,
        )
        print("  Le repo TFLite Micro a peut-être changé de structure.", file=sys.stderr)
        print("  Vérifier manuellement et adapter model_data.h si nécessaire.", file=sys.stderr)
    else:
        print("  ✓ Symboles vérifiés : g_person_detect_model_data[_len]")


def main() -> None:
    os.makedirs(TARGET_DIR, exist_ok=True)

    print("=== Fovet — Récupération du modèle person_detect ===\n")

    # Le .cpp contient l'array C du modèle (~250 KB FlatBuffer en hex)
    download(BASE_URL + "person_detect_model_data.cpp", TARGET_FILE)
    patch_symbol_name(TARGET_FILE)

    print()
    print("Modèle prêt. Prochaine étape :")
    print("  1. Copier src/config.h.example → src/config.h et remplir les credentials")
    print("  2. pio run -e person_detection --target upload")
    print("  3. pio device monitor -e person_detection")


if __name__ == "__main__":
    main()

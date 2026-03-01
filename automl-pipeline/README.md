# Fovet Forge — AutoML Pipeline

Pipeline Python pour l'entraînement de modèles d'anomalie et leur export vers TFLite (pour déploiement sur Fovet Sentinelle).

## Stack
- Python 3.11+
- scikit-learn, TensorFlow/Keras
- Scaleway GPU (entraînement)
- TFLite Micro (inférence embarquée)

## Structure (à venir)

```
automl-pipeline/
├── data/           # Datasets capteurs (gitignored)
├── models/         # Modèles entraînés (.tflite)
├── notebooks/      # Exploration / prototypage
├── src/
│   ├── train.py    # Pipeline d'entraînement
│   ├── export.py   # Export TFLite + quantisation
│   └── evaluate.py # Métriques de détection
├── requirements.txt
└── README.md
```

## Roadmap (Phase 3)

- [ ] Collecte de données depuis ESP32-CAM via UART/WiFi
- [ ] Entraînement autoencoder LSTM sur Scaleway GPU
- [ ] Quantisation INT8 et export TFLite
- [ ] Intégration dans edge-core (TFLite Micro)

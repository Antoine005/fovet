# Fovet SDK

**SDK C/C++ embarqué souverain pour la détection d'anomalies en temps réel sur microcontrôleurs.**

Zéro cloud US. Cible : défense, industriel, aéronautique.

- Site : [fovet.eu](https://fovet.eu)
- Contact : contact@fovet.eu
- Auteur : Antoine Porte

---

## Produits

| Produit | Description |
|---|---|
| **Fovet Sentinelle** | SDK C/C++ embarqué (edge-core) — détection d'anomalies sur MCU |
| **Fovet Forge** | Pipeline AutoML Python — entraînement modèles + export TFLite |
| **Fovet Vigie** | Dashboard Next.js/Hono — supervision temps réel, flotte capteurs |

---

## Structure du monorepo

```
fovet/
├── edge-core/          # Fovet Sentinelle — SDK embarqué C99
├── automl-pipeline/    # Fovet Forge — pipeline Python AutoML
├── platform-dashboard/ # Fovet Vigie — dashboard Next.js
├── docs/               # Documentation
├── CLAUDE.md           # Contexte Claude Code
└── README.md
```

---

## Contraintes SDK

- C99 pur — aucune dépendance externe
- Zéro malloc dans les algorithmes
- < 4 KB RAM par détecteur
- < 1 ms de traitement par sample à 80 MHz
- Testable sur PC avant hardware (gcc natif)
- HAL obligatoire — les algos n'appellent jamais directement les registres

---

## Licence

Dual License :
- **LGPL v3** pour usage non commercial / open source
- **Licence commerciale** pour toute entreprise — contact@fovet.eu

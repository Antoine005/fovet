# Fovet — Convention de contribution

---

## Nouveau use case ?

Voir [`docs/new-use-case.md`](new-use-case.md) pour le guide pas à pas complet :
checklist, choix du détecteur, HAL/driver, config Forge, manifest, flash, Vigie, scale.

---

## Règle fondamentale : la doc suit le code

**Toute modification de code doit s'accompagner de la mise à jour de la documentation correspondante dans le même commit.**

Ce n'est pas optionnel. Un commit qui change un comportement sans mettre à jour la doc est incomplet.

---

## Quelle doc mettre à jour selon ce qu'on change ?

| Modification | Doc à mettre à jour |
|---|---|
| Nouvelle fonction publique C (`zscore.h`) | `edge-core/README.md` section "API publique" |
| Nouveau détecteur Forge | `automl-pipeline/README.md` tableau détecteurs + `docs/architecture.md` interfaces |
| Nouvelle route API Vigie | `platform-dashboard/README.md` tableau API REST |
| Nouvelle variable d'environnement | `platform-dashboard/.env.example` + README tableau variables |
| Changement d'interface Forge → ESP32 | `docs/architecture.md` section "Interfaces entre composants" |
| Nouvelle contrainte SDK | `edge-core/README.md` + `README.md` racine + `docs/architecture.md` |
| Nouvelle décision architecturale | `docs/architecture.md` section "Décisions architecturales" |
| Nouveau produit ou sous-module | `README.md` racine (tableau produits + structure) |

---

## Format des commits

Convention : [Conventional Commits](https://www.conventionalcommits.org/)

```
<type>(<scope>): <description courte>

[corps optionnel]
```

**Types :**
| Type | Usage |
|---|---|
| `feat` | Nouvelle fonctionnalité |
| `fix` | Correction de bug |
| `docs` | Documentation uniquement |
| `chore` | Maintenance (deps, config, CI) |
| `test` | Ajout ou correction de tests |
| `refactor` | Refactoring sans changement de comportement |

**Scopes :**
| Scope | Produit |
|---|---|
| `sentinelle` | edge-core SDK C |
| `forge` | automl-pipeline |
| `vigie` | platform-dashboard |
| `docs` | Documentation transverse |
| `ci` | GitHub Actions |

**Exemples :**
```
feat(forge): Forge-4 — AutoEncoder Dense + TFLite INT8 export
fix(sentinelle): handle flat signal (stddev=0) without division by zero
docs(vigie): update API table with POST /auth/logout route
chore(forge): add tensorflow>=2.17 to optional ml extras
```

---

## Hook pre-commit

Un hook bloque les commits en semaine entre 07h00 et 18h00 (`.git/hooks/pre-commit`).
Les weekends sont libres.

Pour désactiver exceptionnellement :
```bash
git commit --no-verify -m "..."
```

---

## Langue

| Quoi | Langue |
|---|---|
| Code source, commentaires, noms de variables | Anglais |
| Commits | Anglais |
| Documentation utilisateur (README, docs/) | Français |
| Messages d'erreur côté serveur | Anglais |
| UI Vigie | Français |

---

## Tests

- Tout nouveau code doit avoir des tests associés dans le même commit
- edge-core : tests natifs gcc dans `edge-core/tests/test_*.c`
- Forge : pytest dans `automl-pipeline/tests/test_*.py`
- Vigie : Vitest dans `platform-dashboard/src/__tests__/`

**Seuils :**
- Sentinelle : 16/16 tests natifs
- Forge : 113/113 tests pytest (dont tests TF skippés si `uv sync --extra ml` non fait)
- Vigie : 19/19 tests Vitest

---

## CI / GitHub Actions

Tout push ou PR sur `master` déclenche automatiquement :

| Job | Workflow | Ce qu'il fait |
|---|---|---|
| `edge-core` | `ci.yml` | `make -C tests` — compile + exécute les 16 tests C natifs (Ubuntu gcc) |
| `dashboard` | `ci.yml` | `pnpm test` — TypeScript check + 19 tests Vitest |
| `forge` | `ci.yml` | `uv run pytest` — 113 tests Python (TF skippés sans extra ml) |
| `deploy-landing` | `ci.yml` | Déploiement GitHub Pages (push master uniquement) |

**Scaleway GPU (manuel)** : `.github/workflows/forge-gpu.yml`
- Déclenché depuis l'UI GitHub Actions → "Run workflow"
- SSH sur l'instance GPU → `uv run forge run --config configs/<config>.yaml`
- Requiert les secrets `SCALEWAY_SSH_KEY`, `SCALEWAY_GPU_HOST`, `SCALEWAY_GPU_USER`

---

## Structure des branches

```
master    ← branche principale — toujours stable
  └── feat/...   ← branches de fonctionnalité (optionnel)
```

Actuellement en développement solo, les commits vont directement sur `master`.
Une branche de feature sera introduite si plusieurs personnes collaborent.

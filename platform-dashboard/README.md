# Fovet Vigie — Dashboard

Dashboard de supervision temps réel pour la flotte de capteurs Fovet Sentinelle.

## Stack
- Next.js 15 (App Router)
- Hono.js (API backend)
- PostgreSQL + Prisma ORM
- WebSocket (supervision temps réel)
- Déploiement : Scaleway (souverain, hébergement français)

## Structure (à venir)

```
platform-dashboard/
├── app/            # Next.js App Router
│   ├── page.tsx    # Dashboard principal
│   └── api/        # Route handlers
├── server/         # Hono API + WebSocket
├── prisma/
│   └── schema.prisma
├── components/     # UI composants
├── lib/            # Utilitaires
├── package.json
└── README.md
```

## Roadmap (Phase 4)

- [ ] Setup Next.js + Hono
- [ ] Schéma BDD : devices, readings, alerts
- [ ] Ingestion données ESP32 via WebSocket
- [ ] Dashboard temps réel (graphiques anomalies)
- [ ] Gestion flotte (ajout/suppression de capteurs)
- [ ] Alertes email/webhook

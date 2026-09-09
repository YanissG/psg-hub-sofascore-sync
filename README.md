# PSG Hub — robot SofaScore

Ce dépôt contient uniquement le robot de données PSG Hub, pas le site ni Vault.

- En temps normal, les données SofaScore sont collectées toutes les huit heures.
- Dès qu’un match commence dans moins de dix heures, la cadence passe à quinze minutes.
- À partir du coup d’envoi, le match est contrôlé toutes les cinq minutes jusqu’au résultat et à l’ouverture confirmée des votes.
- Une fois les votes ouverts, le robot revient automatiquement au rythme de huit heures.
- Les horaires sont calculés depuis l’heure exacte du match. Les matchs de nuit et les changements d’heure ne demandent aucune intervention.
- Pendant le direct, seuls le match, sa composition et ses incidents sont collectés. Les archives et le prochain adversaire ne bloquent pas le suivi.
- Les appels réseau ont des délais maximum. Une panne temporaire est réessayée sans effacer les dernières données valides.
- Chaque exécution transmet le relais à la suivante, même après une panne temporaire. Les réveils GitHub restent un secours.
- Un report ou une annulation arrête le suivi de l’ancien horaire.

Configuration : variable GitHub `PSG_HUB_SYNC_URL=https://psg-hub.fr` et secret `SYNC_SECRET_TOKEN`. Aucun secret ne doit être ajouté au dépôt.

Validation : `npm ci`, puis `npm test`. Les tests simulent les 24 heures de coup d’envoi, les matchs à 1 h et 3 h, les changements d’heure, une panne SofaScore, un report, la fin du match et le retour automatique à huit heures.

Limites : SofaScore peut rester indisponible ou publier des détails en retard. Le robot réessaie et n’invente jamais un score, des minutes jouées ou une composition.

Projet communautaire indépendant, sans affiliation officielle avec le Paris Saint-Germain ni SofaScore.

# PSG Hub — robot SofaScore

Ce dépôt contient uniquement le robot de données PSG Hub, pas le site ni Vault.

- Le réveil GitHub est demandé toutes les cinq minutes. Hors match, le contrôle de fraîcheur limite la collecte à environ quinze minutes.
- À partir de 90 minutes avant le coup d’envoi, le processus reste actif et commence un passage toutes les cinq minutes, jusqu’à l’ouverture confirmée des votes du match concerné.
- Pendant ce suivi, seuls le match, sa composition et ses incidents sont collectés. Les archives et le prochain adversaire ne bloquent plus le direct.
- Les appels réseau ont des délais maximum. Les pannes temporaires sont réessayées, même au premier passage. Une panne persistante termine le travail en échec visible.
- Un report ou une annulation met fin à la surveillance de l’ancien horaire. Le prochain passage récupère le calendrier actualisé.
- Les trois points d’entrée partagent le même collecteur et la même exclusion mutuelle. Le relais historique ne se relance plus à l’infini.
- Les votes et les données officielles sont contrôlés sur une réponse authentifiée sans cache.

Configuration : variable GitHub `PSG_HUB_SYNC_URL=https://psg-hub.fr` et secret `SYNC_SECRET_TOKEN`. Une redirection ou un refus d’authentification est une erreur explicite. Aucun secret ne doit être ajouté au dépôt.

Validation : `npm ci`, puis `npm test`. Ces tests simulent un match entier, une panne initiale, une coupure réseau, les détails retardés, un report et la cadence exacte. Ils n’écrivent rien en production.

Limites : GitHub ne garantit pas l’heure de lancement des tâches planifiées. La surveillance déjà démarrée a une durée maximale de 325 minutes ; au-delà, elle échoue explicitement et le prochain passage reprend. SofaScore peut rester indisponible ou publier des détails en retard. Aucun résultat de match ni aucune minute jouée n’est inventé.

Projet communautaire indépendant, sans affiliation officielle avec le Paris Saint-Germain ni SofaScore.

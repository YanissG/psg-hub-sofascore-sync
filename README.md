# PSG Hub — synchronisation SofaScore

Ce dépôt contient uniquement le robot de données de **PSG Hub**. Le site et le jeu Vault n’y sont pas publiés.

Le workflow :

- se lance automatiquement toutes les 15 minutes ;
- passe à une synchronisation toutes les 3 minutes pendant la fenêtre chaude d’un match ;
- récupère les rencontres, compositions, incidents et joueurs depuis SofaScore ;
- envoie le snapshot à l’API protégée de PSG Hub ;
- ne contient aucune clé secrète dans le code.

Variables GitHub nécessaires :

- variable `PSG_HUB_SYNC_URL` ;
- secret `SYNC_SECRET_TOKEN`.

Projet communautaire indépendant, sans affiliation officielle avec le Paris Saint-Germain ni SofaScore.

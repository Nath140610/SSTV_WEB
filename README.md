# Emmiter / Recever SSTV Web

Site web simple:
- `Emmiter`: choisir une image puis cliquer sur `Emmiter` pour l'envoyer en son.
- `Recever`: cliquer sur `Recever` pour ecouter le micro et reconstruire l'image en direct.

## Lancer

Le micro navigateur demande un contexte securise (`https` ou `localhost`).

Exemple local:

```powershell
python -m http.server 8080
```

Puis ouvrir:

```text
http://localhost:8080
```

## Test PC et telephone

1. Ouvrir le site sur les 2 appareils (meme URL).
2. Sur le recever: mode `Recever`, puis bouton `Recever` (accepter le micro).
3. Sur l'emmiter: mode `Emmiter`, choisir image, cliquer `Emmiter`.
4. Mettre le haut-parleur de l'emmeteur proche du micro du recever.
5. L'image apparait progressivement sur le canvas recever.

## Notes

- Ce projet utilise un protocole SSTV web acoustique (emit + decode dans le navigateur).
- Qualite `Rapide` est plus robuste en environnement bruyant.

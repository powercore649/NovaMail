# NovaMail 1.0.0

Client mail Windows de la suite Nova, avec version web et mobile responsive.

## Téléchargements

- **NovaMail-Setup.exe** — installateur universel (x64 + ARM64)
- **NovaMail-Setup-x64.exe** — installateur Intel/AMD
- **NovaMail-Setup-arm64.exe** — installateur Windows on ARM

## Nouveautés

### Messagerie

- Connexion **IMAP/SMTP** réelle, avec fournisseurs prédéfinis (Gmail, Outlook, Yahoo, iCloud, OVH, Free, Orange) ou serveurs personnalisés.
- **Dossiers** avec compteurs de non-lus, liste des 60 derniers messages, recherche locale.
- **Lecture** : texte ou HTML nettoyé (scripts et images distantes bloqués), pièces jointes listées, marquage lu automatique et retour « non lu ».
- **Composition** : nouveau message, réponse avec citation, Cc, signature par compte.
- **Hors ligne** : cache local par dossier, bandeau d'état et bouton « Réessayer ».

### Comptes et sécurité

- Multi-comptes, mots de passe chiffrés par **DPAPI** (Windows), jamais renvoyés à l'interface.
- Contexte isolé, sandbox, journal d'erreurs `mail.log` (sans secret).
- Messages d'aide ciblés pour Gmail/Outlook (mots de passe d'application).

### Web et mobile

- Interface web responsive servie par `npm run web`, utilisable depuis un téléphone sur le même réseau.
- Session en mémoire, cookie HttpOnly, expiration 2 h.

## Notes

- L'installateur n'est pas signé : SmartScreen peut demander une confirmation.
- Les comptes et réglages restent dans `%APPDATA%\nova-mail`.

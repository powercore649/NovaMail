# NovaMail

Client mail Windows de la suite Nova : IMAP/SMTP, multi-comptes, interface en trois colonnes, lecture hors ligne.

## Télécharger

Dernière version : **[v1.0.0](https://github.com/powercore649/NovaMail/releases/latest)**

- `NovaMail-Setup.exe` — installateur universel (x64 + ARM64)
- `NovaMail-Setup-x64.exe` / `NovaMail-Setup-arm64.exe` — installateurs par architecture

Installation par utilisateur : raccourcis dans le menu Démarrer et sur le Bureau, désinstallation propre.

## Fonctionnalités

- Comptes IMAP/SMTP (Gmail, Outlook, Yahoo, iCloud, OVH, Free, Orange, serveur personnalisé)
- Dossiers avec compteurs de non-lus, recherche, lecture HTML nettoyée
- Composition, réponse avec citation, signature par compte
- Cache local : les 60 derniers messages restent lisibles hors ligne
- Mots de passe chiffrés par Windows (DPAPI), rien n'est envoyé à un serveur tiers
- Version web/mobile responsive servie localement par `npm run web`

## Code source

```
main.js            processus principal Electron (IPC, IMAP/SMTP)
preload.js         pont sécurisé vers le renderer
store.js           comptes et cache local
web-server.js      serveur local du client web + proxy /api
renderer/          interface de l'application Windows
web/               client web/mobile autonome
build/             icônes de l'installateur
scripts/           outillage (icône, diagnostic)
server/            version hébergée (Worker Cloudflare, NovaMail @novacorpbumpify.dpdns.org)
```

```bash
npm install          # dépendances de l'application
npm start            # lance l'app Electron
npm run web          # client web local sur http://localhost:4173
npm run dist         # installateur NSIS dans dist/
```

Le dossier `server/` contient le Worker déployé (inbox D1, adresses NovaMail, dossier Envoyés) ; ses secrets se configurent côté hébergement, jamais dans le dépôt.

## Configuration

Windows 10 1809 ou plus récent. Gmail et Outlook exigent un mot de passe d'application.

Les données restent dans `%APPDATA%\nova-mail`. L'exécutable n'est pas signé : SmartScreen peut demander une confirmation.

'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

app.setPath('userData', path.join(app.getPath('appData'), 'nova-mail'));

app.whenReady().then(async () => {
  const accountFile = path.join(app.getPath('userData'), 'accounts.json');
  const data = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  const account = data.accounts[0];
  if (!account) {
    console.log('AUCUN_COMPTE');
    app.quit();
    return;
  }

  const password = String(account.secret || '').startsWith('enc:')
    ? safeStorage.decryptString(Buffer.from(account.secret.slice(4), 'base64'))
    : '';

  const key = crypto.randomBytes(32).toString('base64url');
  const module = await import(pathToFileURL(path.join(__dirname, '..', 'dist', 'worker.test.mjs')).href);
  const worker = module.default;
  const env = {
    NOVAMAIL_KEY: key,
    ASSETS: { fetch: async () => new Response('', { status: 404 }) },
  };

  const call = (route, init) => worker.fetch(new Request('https://novamail.test' + route, init), env);

  try {
    let response = await call('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password, imap: account.imap, smtp: account.smtp }),
    });
    console.log('LOGIN', response.status, response.status === 200 ? 'ok' : await response.text());
    if (response.status !== 200) {
      app.quit();
      return;
    }

    const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
    const headers = { cookie };

    response = await call('/api/session', { headers });
    console.log('SESSION', response.status, (await response.text()).slice(0, 80));

    response = await call('/api/folders', { headers });
    let payload = await response.json();
    console.log('FOLDERS', response.status, payload.folders ? payload.folders.length : payload.error);

    response = await call('/api/messages?box=INBOX', { headers });
    payload = await response.json();
    console.log('MESSAGES', response.status, payload.messages ? payload.messages.length + '/' + payload.total : payload.error);

    response = await call('/api/send', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
      body: JSON.stringify({ to: account.email, subject: 'Verification NovaMail', text: 'Test de connexion SMTP, aucun envoi.', dryRun: true }),
    });
    console.log('SMTP', response.status, (await response.text()).slice(0, 120));

    if (payload.messages && payload.messages[0]) {
      const uid = payload.messages[0].uid;
      response = await call('/api/message?box=INBOX&uid=' + uid, { headers });
      const message = await response.json();
      console.log(
        'MESSAGE',
        response.status,
        message.error
          ? message.error
          : JSON.stringify({ subject: String(message.subject).slice(0, 50), from: String(message.from).slice(0, 40), text: String(message.text || '').slice(0, 60), html: String(message.html || '').length }),
      );
    }
  } catch (error) {
    console.log('ERREUR', error && error.stack ? error.stack : error);
  }

  app.quit();
});

'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setPath('userData', path.join(app.getPath('appData'), 'nova-mail'));

const BASE = 'http://127.0.0.1:8787';

app.whenReady().then(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'accounts.json'), 'utf8'));
  const account = data.accounts[0];
  if (!account) {
    console.log('AUCUN_COMPTE');
    app.quit();
    return;
  }

  const password = String(account.secret || '').startsWith('enc:')
    ? safeStorage.decryptString(Buffer.from(account.secret.slice(4), 'base64'))
    : '';

  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: account.email,
      password,
      imap: account.imap,
      smtp: account.smtp,
    }),
  });

  console.log('LOGIN', login.status, login.status === 200 ? 'ok' : await login.text());
  if (login.status !== 200) {
    app.quit();
    return;
  }

  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const headers = { cookie };

  const folders = await (await fetch(BASE + '/api/folders', { headers })).json();
  console.log('FOLDERS', Array.isArray(folders.folders) ? folders.folders.length : folders.error);

  const inbox = await (await fetch(BASE + '/api/messages?box=INBOX', { headers })).json();
  console.log('MESSAGES', inbox.messages ? inbox.messages.length + '/' + inbox.total : inbox.error);

  if (inbox.messages && inbox.messages[0]) {
    const uid = inbox.messages[0].uid;
    const message = await (await fetch(BASE + '/api/message?box=INBOX&uid=' + uid, { headers })).json();
    console.log('MESSAGE', message.subject ? 'sujet=' + message.subject.length + 'c' : message.error, 'corps=' + String(message.html || message.text || '').length + 'c');
  }

  const logout = await fetch(BASE + '/api/logout', { method: 'POST', headers });
  console.log('LOGOUT', logout.status);

  app.quit();
});

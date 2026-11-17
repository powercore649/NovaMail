'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '');
}

app.setPath('userData', path.join(app.getPath('appData'), 'nova-mail'));

app.whenReady().then(async () => {
  const file = path.join(app.getPath('userData'), 'accounts.json');
  let data = { accounts: [] };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.log('ACCOUNTS_READ_ERROR', error.message, file);
    app.quit();
    return;
  }

  console.log('ACCOUNTS', data.accounts.length);

  for (const account of data.accounts) {
    let password = '';
    try {
      if (String(account.secret || '').startsWith('enc:')) {
        password = safeStorage.decryptString(Buffer.from(account.secret.slice(4), 'base64'));
      } else if (String(account.secret || '').startsWith('plain:')) {
        password = Buffer.from(account.secret.slice(6), 'base64').toString('utf8');
      }
    } catch (error) {
      console.log('DECRYPT_ERROR', error.message);
    }

    const pass = clean(password);
    console.log('---');
    console.log('EMAIL', account.email);
    console.log('IMAP', account.imap.host + ':' + account.imap.port, 'secure=' + account.imap.secure);
    console.log('SMTP', account.smtp.host + ':' + account.smtp.port, 'secure=' + account.smtp.secure);
    console.log('PASSWORD length=' + password.length, 'sansEspaces=' + pass.length, 'contientEspaces=' + (password !== pass));

    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.email, pass },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 12000,
      socketTimeout: 30000,
    });

    try {
      await client.connect();
      console.log('IMAP_OK');
      try {
        const boxes = await client.list();
        console.log('MAILBOXES', boxes.length, boxes.slice(0, 5).map((box) => box.path).join(', '));
        const lock = await client.getMailboxLock('INBOX');
        try {
          const total = client.mailbox.exists;
          console.log('INBOX_EXISTS', total);
          const start = Math.max(1, total - 59);
          let count = 0;
          let lastSubjectLength = 0;
          for await (const message of client.fetch(`${start}:*`, {
            envelope: true,
            flags: true,
            uid: true,
            internalDate: true,
            size: true,
          })) {
            count += 1;
            lastSubjectLength = String((message.envelope && message.envelope.subject) || '').length;
          }
          console.log('FETCH_OK', count, 'dernierSujetLongueur=' + lastSubjectLength);
        } finally {
          lock.release();
        }
      } catch (error) {
        console.log('IMAP_OP_ERROR', error.message);
      }
    } catch (error) {
      console.log('IMAP_ERROR', JSON.stringify({
        code: error.code || null,
        auth: error.authenticationFailed === true,
        server: error.serverResponseCode || null,
        response: error.responseText || null,
        message: error.message,
      }));
    } finally {
      try {
        await client.logout();
      } catch {
        /* fermé */
      }
    }

    const transport = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.email, pass },
      connectionTimeout: 15000,
    });

    try {
      await transport.verify();
      console.log('SMTP_OK');
    } catch (error) {
      console.log('SMTP_ERROR', error.code || '', String(error.response || error.message).slice(0, 200));
    } finally {
      transport.close();
    }
  }

  app.quit();
});

'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const store = require('./store');

const E2E = process.env.NOVAMAIL_E2E || '';

let mainWindow = null;

app.setAppUserModelId('com.novamail.app');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#080b10',
    title: 'NovaMail',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const target = path.join(__dirname, 'renderer', 'index.html');
  mainWindow.loadFile(target, E2E ? { query: { e2e: E2E } } : undefined);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function friendlyError(error, account) {
  const message = String((error && error.message) || error || 'Erreur inconnue.');
  const hints = [
    message,
    error && error.code,
    error && error.responseText,
    error && error.serverResponseCode,
    error && error.response && error.response.text,
  ]
    .filter(Boolean)
    .join(' | ');

  const host = String((account && account.imap && account.imap.host) || '');
  const email = String((account && account.email) || '');
  const isGmail = /gmail|googlemail/i.test(host) || /@gmail\./i.test(email);
  const isOutlook = /office365|outlook|live\.com|hotmail/i.test(host) || /@(outlook|hotmail|live)\./i.test(email);

  if (/IMAP access is disabled|IMAP.*(disabled|not enabled)|IMAP is not enabled/i.test(hints)) {
    return 'IMAP est désactivé sur ce compte. Pour Gmail : Paramètres → Transfert et POP/IMAP → Activer IMAP, puis réessaie.';
  }
  if (/(application-specific password|app password|web browser)/i.test(hints)) {
    return 'Ce serveur exige un mot de passe d\'application (pas ton mot de passe habituel). Gmail : active la validation en 2 étapes puis crée un mot de passe d\'application sur myaccount.google.com/apppasswords.';
  }
  if ((error && error.authenticationFailed) || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|login failed|EAUTH|AUTH\s/i.test(hints)) {
    if (isGmail) {
      return 'Gmail a refusé la connexion. Le mot de passe du compte ne suffit pas : utilise un mot de passe d\'application (active la validation en 2 étapes, puis crée-le sur myaccount.google.com/apppasswords). Les espaces du mot de passe sont ignorés.';
    }
    if (isOutlook) {
      return 'Outlook/Microsoft 365 a refusé la connexion. Active la validation en 2 étapes puis crée un mot de passe d\'application, ou vérifie que IMAP est autorisé sur la boîte.';
    }
    return 'Connexion refusée : vérifie l\'adresse et le mot de passe (ou le mot de passe d\'application).';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(hints)) {
    return 'Serveur introuvable : vérifie le nom du serveur IMAP/SMTP.';
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(hints)) {
    return 'Délai dépassé : le serveur ne répond pas (port ou pare-feu à vérifier).';
  }
  if (/ECONNREFUSED/i.test(hints)) {
    return 'Connexion refusée par le serveur : vérifie le port et le chiffrement (SSL/TLS).';
  }
  if (/certificate|self signed|SSL|TLS/i.test(hints)) {
    return 'Certificat SSL refusé : vérifie le serveur ou décoche SSL si le port ne l\'utilise pas.';
  }
  if (!message || message === 'Command failed') {
    return 'La connexion au serveur a échoué. Vérifie le nom du serveur, le port et le chiffrement.';
  }
  return message;
}

function logError(context, error, account) {
  try {
    const file = path.join(store.dataDir(), 'mail.log');
    const line = JSON.stringify({
      at: new Date().toISOString(),
      context,
      email: (account && account.email) || '',
      message: friendlyError(error, account),
      raw: String((error && error.message) || error || ''),
      code: (error && error.code) || '',
      server: (error && error.serverResponseCode) || '',
      response: (error && error.responseText) || '',
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* journal indisponible */
  }
}

function specialUse(box) {
  const value = String(box.specialUse || '').toLowerCase();
  const pathName = String(box.path || '').toLowerCase();
  if (value === '\\inbox' || pathName === 'inbox') return 'inbox';
  if (value === '\\sent') return 'sent';
  if (value === '\\drafts') return 'drafts';
  if (value === '\\trash') return 'trash';
  if (value === '\\junk') return 'junk';
  if (value === '\\archive') return 'archive';
  return '';
}

function authPassword(host, password) {
  const value = String(password || '');
  // Les mots de passe d'application Google/Microsoft sont affichés par blocs :
  // les espaces ne font pas partie du secret.
  return /gmail|googlemail|outlook|office365/i.test(String(host || '')) ? value.replace(/\s+/g, '') : value;
}

function imapConfig(account, password) {
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.email, pass: authPassword(account.imap.host, password) },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 12000,
    socketTimeout: 60000,
  };
}

async function withImap(accountId, task) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('Compte introuvable.');
  const password = store.getPassword(accountId);
  if (!password) throw new Error('Aucun mot de passe enregistré pour ce compte.');

  const client = new ImapFlow(imapConfig(account, password));
  try {
    await client.connect();
    try {
      return await task(client, account);
    } finally {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          /* socket déjà fermée */
        }
      }
    }
  } catch (error) {
    logError('imap', error, account);
    throw new Error(friendlyError(error, account));
  }
}

function summarize(message) {
  const from = (message.envelope && message.envelope.from && message.envelope.from[0]) || {};
  const subject = (message.envelope && message.envelope.subject) || '(sans objet)';
  const date = (message.envelope && message.envelope.date) || message.internalDate || new Date();
  const flags = message.flags instanceof Set ? [...message.flags] : [];

  return {
    uid: message.uid,
    subject,
    fromName: from.name || '',
    fromAddress: from.address || '',
    date: new Date(date).toISOString(),
    unread: !flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    size: message.size || 0,
  };
}

function smtpTransport(account, password) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: authPassword(account.smtp.host, password) },
    connectionTimeout: 15000,
    greetingTimeout: 12000,
    socketTimeout: 40000,
  });
}

function serverFromInput(input, fallbackSecure) {
  const source = input || {};
  return {
    host: String(source.host || '').trim(),
    port: Number(source.port) || (fallbackSecure ? 993 : 143),
    secure: typeof source.secure === 'boolean' ? source.secure : fallbackSecure,
  };
}

/* ------------------------------------------------------------------ */
/* Comptes                                                             */
/* ------------------------------------------------------------------ */

ipcMain.handle('accounts:list', () => store.listAccounts());

ipcMain.handle('accounts:save', (_event, input) => store.saveAccount(input || {}));

ipcMain.handle('accounts:remove', (_event, id) => store.removeAccount(String(id)));

ipcMain.handle('accounts:activate', (_event, id) => store.setActive(String(id)));

ipcMain.handle('accounts:test', async (_event, input) => {
  const source = input || {};
  const email = String(source.email || '').trim();
  let password = typeof source.password === 'string' ? source.password : '';
  if (!password && source.id) password = store.getPassword(String(source.id));

  if (!email || !password) throw new Error('Adresse et mot de passe requis pour tester.');

  const imap = serverFromInput(source.imap, true);
  const smtp = serverFromInput(source.smtp, false);

  if (!imap.host || !smtp.host) throw new Error('Serveurs IMAP et SMTP requis.');

  const result = { imap: false, smtp: false, errors: [] };

  const client = new ImapFlow({
    ...imapConfig({ email, imap }, password),
  });
  try {
    await client.connect();
    result.imap = true;
  } catch (error) {
    logError('test-imap', error, { email, imap });
    result.errors.push('IMAP : ' + friendlyError(error, { email, imap }));
  } finally {
    try {
      await client.logout();
    } catch {
      /* déjà fermé */
    }
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: email, pass: authPassword(smtp.host, password) },
    connectionTimeout: 15000,
  });
  try {
    await transport.verify();
    result.smtp = true;
  } catch (error) {
    logError('test-smtp', error, { email, smtp });
    result.errors.push('SMTP : ' + friendlyError(error, { email, smtp }));
  } finally {
    transport.close();
  }

  return result;
});

/* ------------------------------------------------------------------ */
/* Messagerie                                                          */
/* ------------------------------------------------------------------ */

ipcMain.handle('mail:folders', async (_event, accountId) => {
  return withImap(String(accountId), async (client) => {
    const list = await client.list();
    const folders = [];

    for (const box of list) {
      let total = 0;
      let unseen = 0;
      try {
        const status = await client.status(box.path, { messages: true, unseen: true });
        total = status.messages || 0;
        unseen = status.unseen || 0;
      } catch {
        /* statut indisponible pour ce dossier */
      }
      folders.push({
        path: box.path,
        name: box.name,
        special: specialUse(box),
        total,
        unseen,
      });
    }

    const order = ['inbox', 'sent', 'drafts', 'junk', 'trash', 'archive'];
    folders.sort((a, b) => {
      const ia = order.indexOf(a.special);
      const ib = order.indexOf(b.special);
      if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.name.localeCompare(b.name, 'fr');
    });

    return { folders, syncedAt: new Date().toISOString() };
  });
});

ipcMain.handle('mail:cache', (_event, accountId, mailbox) => {
  try {
    return store.loadCache(String(accountId), String(mailbox || 'INBOX')) || null;
  } catch {
    return null;
  }
});

ipcMain.handle('mail:delete', async (_event, accountId, mailbox, uid) => {
  return withImap(String(accountId), async (client) => {
    const box = String(mailbox || 'INBOX');
    const lock = await client.getMailboxLock(box);
    try {
      const boxes = await client.list();
      const trash = boxes.find(
        (item) =>
          String(item.specialUse || '').toLowerCase() === '\trash' ||
          /^(trash|corbeille|deleted items|éléments supprimés)$/i.test(item.path),
      );
      if (trash && trash.path !== box) {
        try {
          await client.messageMove(String(uid), trash.path, { uid: true });
        } catch {
          await client.messageCopy(String(uid), trash.path, { uid: true });
          await client.messageDelete(String(uid), { uid: true });
        }
        return { ok: true, moved: true };
      }
      await client.messageDelete(String(uid), { uid: true });
      return { ok: true, moved: false };
    } finally {
      lock.release();
    }
  });
});

ipcMain.handle('mail:markAllRead', async (_event, accountId, mailbox) => {
  return withImap(String(accountId), async (client) => {
    const lock = await client.getMailboxLock(String(mailbox || 'INBOX'));
    try {
      const count = client.mailbox.exists || 0;
      if (!count) return { ok: true, count: 0 };
      await client.messageFlagsAdd('1:*', ['\Seen'], { uid: true });
      return { ok: true, count };
    } finally {
      lock.release();
    }
  });
});

ipcMain.handle('mail:list', async (_event, accountId, mailbox, limit) => {
  const id = String(accountId);
  const box = String(mailbox || 'INBOX');
  const count = Math.min(Math.max(Number(limit) || 60, 10), 200);

  try {
    const result = await withImap(id, async (client) => {
      const lock = await client.getMailboxLock(box);
      try {
        const total = client.mailbox.exists || 0;
        const messages = [];

        if (total > 0) {
          const start = Math.max(1, total - count + 1);
          for await (const message of client.fetch(`${start}:*`, {
            envelope: true,
            flags: true,
            uid: true,
            internalDate: true,
            size: true,
          })) {
            messages.push(summarize(message));
          }
        }

        messages.reverse();
        return { mailbox: box, total, messages, syncedAt: new Date().toISOString() };
      } finally {
        lock.release();
      }
    });

    store.saveCache(id, box, result);
    return { ...result, cached: false };
  } catch (error) {
    const cached = store.loadCache(id, box);
    const message = friendlyError(error, store.getAccount(id));
    if (cached) return { ...cached, cached: true, offline: true, error: message };
    throw new Error(message);
  }
});

ipcMain.handle('mail:get', async (_event, accountId, mailbox, uid) => {
  return withImap(String(accountId), async (client) => {
    const lock = await client.getMailboxLock(String(mailbox || 'INBOX'));
    try {
      const message = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      if (!message || !message.source) throw new Error('Message introuvable.');

      const parsed = await simpleParser(message.source);
      return {
        uid,
        subject: parsed.subject || '(sans objet)',
        from: parsed.from ? parsed.from.text : '',
        to: parsed.to ? parsed.to.text : '',
        cc: parsed.cc ? parsed.cc.text : '',
        date: (parsed.date || new Date()).toISOString(),
        text: parsed.text || '',
        html: parsed.html || '',
        messageId: parsed.messageId || '',
        references: parsed.references || '',
        attachments: (parsed.attachments || []).map((file) => ({
          filename: file.filename || 'pièce jointe',
          size: file.size || 0,
          contentType: file.contentType || '',
        })),
      };
    } finally {
      lock.release();
    }
  });
});

ipcMain.handle('mail:attachment', async (_event, accountId, mailbox, uid, index) => {
  return withImap(String(accountId), async (client) => {
    const lock = await client.getMailboxLock(String(mailbox || 'INBOX'));
    try {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || !message.source) throw new Error('Message introuvable.');
      const parsed = await simpleParser(message.source);
      const file = (parsed.attachments || [])[Number(index)];
      if (!file || !file.content) throw new Error('Pièce jointe introuvable.');

      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: file.filename || 'piece-jointe',
      });
      if (result.canceled || !result.filePath) return { saved: false };
      fs.writeFileSync(result.filePath, file.content);
      return { saved: true, path: result.filePath };
    } finally {
      lock.release();
    }
  });
});

ipcMain.handle('mail:flag', async (_event, accountId, mailbox, uid, flagged) => {
  return withImap(String(accountId), async (client) => {
    const lock = await client.getMailboxLock(String(mailbox || 'INBOX'));
    try {
      if (flagged) await client.messageFlagsAdd(String(uid), ['\Flagged'], { uid: true });
      else await client.messageFlagsRemove(String(uid), ['\Flagged'], { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
});

ipcMain.handle('mail:flags', async (_event, accountId, mailbox, uid, seen) => {
  return withImap(String(accountId), async (client) => {
    const lock = await client.getMailboxLock(String(mailbox || 'INBOX'));
    try {
      if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
});

ipcMain.handle('mail:send', async (_event, payload) => {
  const input = payload || {};
  const account = store.getAccount(String(input.accountId || ''));
  if (!account) throw new Error('Compte introuvable.');
  const password = store.getPassword(account.id);
  if (!password) throw new Error('Aucun mot de passe enregistré pour ce compte.');

  const to = String(input.to || '').trim();
  if (!to) throw new Error('Destinataire requis.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Adresse du destinataire invalide.');

  const text = String(input.text || '');

  const transport = smtpTransport(account, password);
  try {
    const info = await transport.sendMail({
      from: { name: account.name, address: account.email },
      to,
      cc: String(input.cc || '').trim() || undefined,
      subject: String(input.subject || '').trim() || '(sans objet)',
      text,
      html: String(input.html || '') || undefined,
      inReplyTo: input.inReplyTo || undefined,
      references: input.references || undefined,
    });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    logError('smtp', error, account);
    throw new Error(friendlyError(error, account));
  } finally {
    transport.close();
  }
});

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

ipcMain.handle('app:clearCache', (_event, accountId) => {
  store.clearCache(String(accountId));
  return { ok: true };
});

ipcMain.handle('app:openNovaMail', () => {
  shell.openExternal('https://novamail.freebuff.page');
  return { ok: true };
});

ipcMain.handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  dataDir: store.dataDir(),
  platform: process.platform,
}));

ipcMain.handle('e2e:report', (_event, report) => {
  const file = path.join(os.tmpdir(), 'novamail-e2e.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  setTimeout(() => app.quit(), 250);
  return file;
});

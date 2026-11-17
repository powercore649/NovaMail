'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COLORS = ['#ff8c42', '#5aa0ff', '#7ee787', '#d2a8ff', '#ffd166', '#ff6b81'];

function dataDir() {
  return app.getPath('userData');
}

function accountsFile() {
  return path.join(dataDir(), 'accounts.json');
}

function cacheDir(accountId) {
  return path.join(dataDir(), 'cache', accountId);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function encrypt(text) {
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(text).toString('base64');
  }
  return 'plain:' + Buffer.from(text, 'utf8').toString('base64');
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    if (payload.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(payload.slice(4), 'base64'));
    }
    if (payload.startsWith('plain:')) {
      return Buffer.from(payload.slice(6), 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

function readAll() {
  return readJson(accountsFile(), { accounts: [], activeId: null });
}

function writeAll(data) {
  writeJson(accountsFile(), data);
}

function clean(value, max = 120) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validatePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port ' + label + ' invalide (1-65535).');
  }
  return port;
}

function normalizeServer(input, label) {
  const host = clean(input && input.host, 255).replace(/^https?:\/\//i, '');
  if (!host || /\s/.test(host)) throw new Error('Serveur ' + label + ' requis.');
  return {
    host,
    port: validatePort(input.port, label),
    secure: Boolean(input.secure),
  };
}

function validateAccount(input) {
  const email = clean(input.email, 160).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('Adresse e-mail invalide.');
  const name = clean(input.name, 60) || email.split('@')[0];
  const imap = normalizeServer(input.imap, 'IMAP');
  const smtp = normalizeServer(input.smtp, 'SMTP');
  return {
    email,
    name,
    imap,
    smtp,
    signature: clean(input.signature, 400),
    color: COLORS.includes(input.color) ? input.color : COLORS[0],
  };
}

function publicAccount(account) {
  const { secret, ...rest } = account;
  return { ...rest, hasPassword: Boolean(secret) };
}

function listAccounts() {
  const data = readAll();
  return {
    accounts: data.accounts.map(publicAccount),
    activeId: data.activeId,
  };
}

function getAccount(id) {
  return readAll().accounts.find((account) => account.id === id) || null;
}

function saveAccount(input) {
  const data = readAll();
  const values = validateAccount(input);
  const existing = input.id ? data.accounts.find((account) => account.id === input.id) : null;

  const account = {
    id: existing ? existing.id : crypto.randomUUID(),
    ...values,
    secret: existing ? existing.secret : '',
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (typeof input.password === 'string' && input.password.length > 0) {
    account.secret = encrypt(input.password);
  }

  if (existing) {
    data.accounts = data.accounts.map((item) => (item.id === account.id ? account : item));
  } else {
    data.accounts.push(account);
  }

  if (!data.activeId || data.activeId === account.id) data.activeId = account.id;
  writeAll(data);

  return { account: publicAccount(account), activeId: data.activeId };
}

function removeAccount(id) {
  const data = readAll();
  data.accounts = data.accounts.filter((account) => account.id !== id);
  if (data.activeId === id) data.activeId = data.accounts[0] ? data.accounts[0].id : null;
  writeAll(data);
  try {
    fs.rmSync(cacheDir(id), { recursive: true, force: true });
  } catch {
    /* cache déjà supprimé */
  }
  return { accounts: data.accounts.map(publicAccount), activeId: data.activeId };
}

function setActive(id) {
  const data = readAll();
  if (data.accounts.some((account) => account.id === id)) {
    data.activeId = id;
    writeAll(data);
  }
  return { activeId: data.activeId };
}

function getPassword(id) {
  const account = getAccount(id);
  return account ? decrypt(account.secret) : '';
}

function cachePath(accountId, mailbox) {
  const safe = Buffer.from(String(mailbox), 'utf8').toString('hex').slice(0, 96);
  return path.join(cacheDir(accountId), safe + '.json');
}

function clearCache(accountId) {
  try {
    fs.rmSync(cacheDir(accountId), { recursive: true, force: true });
  } catch {
    /* cache déjà absent */
  }
}

function loadCache(accountId, mailbox) {
  return readJson(cachePath(accountId, mailbox), null);
}

function saveCache(accountId, mailbox, payload) {
  writeJson(cachePath(accountId, mailbox), payload);
}

module.exports = {
  listAccounts,
  saveAccount,
  removeAccount,
  setActive,
  getAccount,
  getPassword,
  clearCache,
  loadCache,
  saveCache,
  dataDir,
  COLORS,
};

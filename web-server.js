'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const REQUESTED_PORT = Number(process.env.PORT);
const PORT = Number.isInteger(REQUESTED_PORT) && REQUESTED_PORT > 0 ? REQUESTED_PORT : 8787;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'web');
const SESSION_TTL = 2 * 60 * 60 * 1000;

const sessions = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

function authPassword(host, password) {
  const value = String(password || '');
  return /gmail|googlemail|outlook|office365/i.test(String(host || '')) ? value.replace(/\s+/g, '') : value;
}

function friendlyError(error, config) {
  const message = String((error && error.message) || error || 'Erreur inconnue.');
  const hints = [message, error && error.code, error && error.responseText, error && error.serverResponseCode]
    .filter(Boolean)
    .join(' | ');
  const email = String((config && config.email) || '');
  const host = String((config && config.imap && config.imap.host) || '');
  const isGmail = /gmail|googlemail/i.test(host) || /@gmail\./i.test(email);
  const isOutlook = /office365|outlook|live\.com|hotmail/i.test(host) || /@(outlook|hotmail|live)\./i.test(email);

  if (/IMAP access is disabled|IMAP.*(disabled|not enabled)/i.test(hints)) {
    return 'IMAP est désactivé sur ce compte. Gmail : Paramètres → Transfert et POP/IMAP → Activer IMAP.';
  }
  if ((error && error.authenticationFailed) || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|login failed/i.test(hints)) {
    if (isGmail) return 'Gmail a refusé la connexion : utilise un mot de passe d\'application (myaccount.google.com/apppasswords).';
    if (isOutlook) return 'Outlook a refusé la connexion : utilise un mot de passe d\'application.';
    return 'Connexion refusée : vérifie l\'adresse et le mot de passe.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(hints)) return 'Serveur introuvable : vérifie le nom du serveur.';
  if (/ETIMEDOUT|timeout|timed out/i.test(hints)) return 'Délai dépassé : le serveur ne répond pas.';
  if (/ECONNREFUSED/i.test(hints)) return 'Connexion refusée par le serveur : vérifie le port et SSL/TLS.';
  if (/certificate|self signed|SSL|TLS/i.test(hints)) return 'Certificat SSL refusé : vérifie le serveur ou le chiffrement.';
  if (!message || message === 'Command failed') return 'La connexion au serveur a échoué.';
  return message;
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

function summarize(message) {
  const from = (message.envelope && message.envelope.from && message.envelope.from[0]) || {};
  const flags = message.flags instanceof Set ? [...message.flags] : [];
  return {
    uid: message.uid,
    subject: (message.envelope && message.envelope.subject) || '(sans objet)',
    fromName: from.name || '',
    fromAddress: from.address || '',
    date: new Date((message.envelope && message.envelope.date) || message.internalDate || Date.now()).toISOString(),
    unread: !flags.includes('\\Seen'),
    size: message.size || 0,
  };
}

async function withImap(config, password, task) {
  const client = new ImapFlow({
    host: config.imap.host,
    port: Number(config.imap.port),
    secure: Boolean(config.imap.secure),
    auth: { user: config.email, pass: authPassword(config.imap.host, password) },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 12000,
    socketTimeout: 60000,
  });

  try {
    await client.connect();
    try {
      return await task(client);
    } finally {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          /* fermé */
        }
      }
    }
  } catch (error) {
    throw new Error(friendlyError(error, config));
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Requête trop volumineuse.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

function getSession(req) {
  const token = parseCookies(req).novamail;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.at > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  session.at = Date.now();
  return session;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: 'Session expirée, reconnecte-toi.' });
    return null;
  }
  return session;
}

function presetConfig(input) {
  const source = input || {};
  const imap = source.imap || {};
  const smtp = source.smtp || {};
  return {
    name: String(source.name || '').slice(0, 60),
    email: String(source.email || '').trim().toLowerCase(),
    imap: { host: String(imap.host || '').trim(), port: Number(imap.port) || 993, secure: imap.secure !== false },
    smtp: { host: String(smtp.host || '').trim(), port: Number(smtp.port) || 465, secure: smtp.secure !== false },
  };
}

async function api(req, res, url) {
  const route = url.pathname;
  const method = req.method || 'GET';

  if (route === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const config = presetConfig(body);
    const password = String(body.password || '');

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.email)) return json(res, 400, { error: 'Adresse e-mail invalide.' });
    if (!password) return json(res, 400, { error: 'Mot de passe requis.' });
    if (!config.imap.host || !config.smtp.host) return json(res, 400, { error: 'Serveurs IMAP et SMTP requis.' });

    try {
      await withImap(config, password, async (client) => {
        await client.list();
      });
    } catch (error) {
      return json(res, 401, { error: error.message });
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { config, password, at: Date.now() });

    res.setHeader('set-cookie', 'novamail=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200');
    return json(res, 200, { email: config.email, name: config.name || config.email.split('@')[0] });
  }

  if (route === '/api/session' && method === 'GET') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: 'Non connecté.' });
    return json(res, 200, { email: session.config.email, name: session.config.name });
  }

  if (route === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).novamail;
    if (token) sessions.delete(token);
    res.setHeader('set-cookie', 'novamail=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  const session = requireSession(req, res);
  if (!session) return;

  try {
    if (route === '/api/folders' && method === 'GET') {
      const folders = await withImap(session.config, session.password, async (client) => {
        const list = await client.list();
        const items = [];
        for (const box of list) {
          let total = 0;
          let unseen = 0;
          try {
            const status = await client.status(box.path, { messages: true, unseen: true });
            total = status.messages || 0;
            unseen = status.unseen || 0;
          } catch {
            /* statut indisponible */
          }
          items.push({ path: box.path, name: box.name, special: specialUse(box), total, unseen });
        }
        return items;
      });
      return json(res, 200, { folders });
    }

    if (route === '/api/messages' && method === 'GET') {
      const box = url.searchParams.get('box') || 'INBOX';
      const result = await withImap(session.config, session.password, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const total = client.mailbox.exists || 0;
          const messages = [];
          if (total > 0) {
            const start = Math.max(1, total - 59);
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
          return { box, total, messages };
        } finally {
          lock.release();
        }
      });
      return json(res, 200, result);
    }

    if (route === '/api/message' && method === 'GET') {
      const box = url.searchParams.get('box') || 'INBOX';
      const uid = url.searchParams.get('uid') || '';
      const message = await withImap(session.config, session.password, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!fetched || !fetched.source) throw new Error('Message introuvable.');
          const parsed = await simpleParser(fetched.source);
          return {
            uid,
            subject: parsed.subject || '(sans objet)',
            from: parsed.from ? parsed.from.text : '',
            to: parsed.to ? parsed.to.text : '',
            date: (parsed.date || new Date()).toISOString(),
            text: parsed.text || '',
            html: parsed.html || '',
            messageId: parsed.messageId || '',
            references: parsed.references || '',
            attachments: (parsed.attachments || []).map((file) => ({ filename: file.filename || 'pièce jointe', size: file.size || 0 })),
          };
        } finally {
          lock.release();
        }
      });
      return json(res, 200, message);
    }

    if (route === '/api/flags' && method === 'POST') {
      const body = await readBody(req);
      const box = String(body.box || 'INBOX');
      const uid = String(body.uid || '');
      await withImap(session.config, session.password, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          if (body.seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
        } finally {
          lock.release();
        }
      });
      return json(res, 200, { ok: true });
    }

    if (route === '/api/send' && method === 'POST') {
      const body = await readBody(req);
      const to = String(body.to || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(res, 400, { error: 'Destinataire invalide.' });

      const transport = nodemailer.createTransport({
        host: session.config.smtp.host,
        port: session.config.smtp.port,
        secure: session.config.smtp.secure,
        auth: { user: session.config.email, pass: authPassword(session.config.smtp.host, session.password) },
        connectionTimeout: 15000,
      });

      try {
        await transport.sendMail({
          from: { name: session.config.name || session.config.email, address: session.config.email },
          to,
          cc: String(body.cc || '').trim() || undefined,
          subject: String(body.subject || '').trim() || '(sans objet)',
          text: String(body.text || ''),
          inReplyTo: body.inReplyTo || undefined,
          references: body.references || undefined,
        });
        return json(res, 200, { ok: true });
      } finally {
        transport.close();
      }
    }

    return json(res, 404, { error: 'Route inconnue.' });
  } catch (error) {
    return json(res, 502, { error: error.message });
  }
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Interdit');
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    res.end(content);
  });
}

const https = require('https');

function proxyToSite(req, res, url) {
  const headers = { ...req.headers, host: 'novamail.freebuff.page' };
  delete headers['accept-encoding'];
  const proxyReq = https.request(
    {
      hostname: 'novamail.freebuff.page',
      port: 443,
      path: url.pathname + url.search,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(error && error.message ? error.message : error));
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    proxyToSite(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  const nets = require('node:os').networkInterfaces();
  const addresses = [];
  for (const list of Object.values(nets)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  const actual = server.address().port;
  console.log('NovaMail Web sur http://localhost:' + actual);
  for (const address of addresses) console.log('  mobile (même Wi-Fi) : http://' + address + ':' + actual);
});

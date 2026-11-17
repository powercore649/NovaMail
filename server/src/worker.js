import PostalMime from 'postal-mime';
import { ImapClient } from './imap.js';
import { sendMail } from './smtp.js';
import { seal, open, setCookie, clearCookie, parseCookies } from './session.js';
import {
  NOVAMAIL_DOMAIN,
  registerAddress,
  authenticate,
  listMailbox,
  listFolders,
  readMailboxMessage,
  deleteMailboxMessage,
  setMessageSeen,
  markAllMessagesSeen,
  handleInbound,
  storeParsedMessage,
  sendFromAddress,
  storeSentMessage,
  verifyWebhook,
} from './novamail-mail.js';

const SESSION_MAX_AGE = 315360000;

const DOWNLOAD_TARGET =
  'https://github.com/powercore649/NovaMail/releases/download/v1.0.0/NovaMail-Setup-arm64.exe';
const DOWNLOAD_PATHS = new Set(['/novamail.download', '/novamail.download.exe', '/telecharger']);

function authPassword(host, password) {
  const value = String(password || '');
  return /gmail|googlemail|outlook|office365/i.test(String(host || '')) ? value.replace(/\s+/g, '') : value;
}

function friendlyError(error, config) {
  const message = String((error && error.message) || error || 'Erreur inconnue.');
  const hints = [message, error && error.serverResponse, error && error.code].filter(Boolean).join(' | ');
  const email = String((config && config.email) || '');
  const host = String((config && config.imap && config.imap.host) || '');
  const isGmail = /gmail|googlemail/i.test(host) || /@gmail\./i.test(email);
  const isOutlook = /office365|outlook|live\.com|hotmail/i.test(host) || /@(outlook|hotmail|live)\./i.test(email);

  if (/IMAP access is disabled|IMAP.*(disabled|not enabled)/i.test(hints)) {
    return 'IMAP est désactivé sur ce compte. Gmail : Paramètres → Transfert et POP/IMAP → Activer IMAP.';
  }
  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed|LOGIN.*NO/i.test(hints)) {
    if (isGmail) return 'Gmail a refusé la connexion : utilise un mot de passe d\'application (myaccount.google.com/apppasswords).';
    if (isOutlook) return 'Outlook a refusé la connexion : utilise un mot de passe d\'application.';
    return 'Connexion refusée : vérifie l\'adresse et le mot de passe.';
  }
  if (/ENOTFOUND|getaddrinfo|DNS/i.test(hints)) return 'Serveur introuvable : vérifie le nom du serveur.';
  if (/ETIMEDOUT|timeout|timed out/i.test(hints)) return 'Délai dépassé : le serveur ne répond pas.';
  if (/ECONNREFUSED/i.test(hints)) return 'Connexion refusée par le serveur : vérifie le port et SSL/TLS.';
  if (/certificate|self signed|SSL|TLS/i.test(hints)) return 'Certificat SSL refusé : vérifie le serveur ou le chiffrement.';
  return message;
}

function specialUse(path, flags) {
  const value = String(flags || '').toLowerCase();
  if (String(path || '').toUpperCase() === 'INBOX' || value.includes('\\inbox')) return 'inbox';
  if (value.includes('\\sent')) return 'sent';
  if (value.includes('\\drafts')) return 'drafts';
  if (value.includes('\\trash')) return 'trash';
  if (value.includes('\\junk')) return 'junk';
  if (value.includes('\\archive')) return 'archive';
  return '';
}

function json(status, payload, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign(
      {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
      headers || {},
    ),
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function parseRaw(raw) {
  try {
    return await PostalMime.parse(raw);
  } catch {
    return await new PostalMime().parse(raw);
  }
}

async function withImap(config, password, task) {
  const client = await ImapClient.connect(config.imap);
  try {
    await client.login(config.email, authPassword(config.imap.host, password));
    return await task(client);
  } catch (error) {
    throw new Error(friendlyError(error, config));
  } finally {
    await client.logout();
  }
}

async function getSession(request, env) {
  if (!env.NOVAMAIL_KEY) return null;
  const token = parseCookies(request).novamail;
  if (!token) return null;
  try {
    const payload = await open(token, env.NOVAMAIL_KEY);
    if (!payload) return null;
    return payload;
  } catch {
    return null;
  }
}

function cleanEmailHtml(value) {
  let html = String(value || '');
  if (!html.trim()) return '';
  html = html.replace(/<(script|style|iframe|object|embed|form|input|button|meta|link)[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<(script|style|iframe|object|embed|form|input|button|meta|link)\b[^>]*\/?>/gi, '');
  html = html.replace(/<img\b[^>]*>/gi, '');
  html = html.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/javascript:/gi, '');
  return html.slice(0, 500000);
}

function cleanConfig(input) {
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

async function handleApi(request, env, url) {
  const route = url.pathname;
  const method = request.method || 'GET';

  if (!env.NOVAMAIL_KEY) {
    return json(500, { error: 'Service mail non configuré (clé de session manquante).' });
  }

  if (route === '/api/novamail/info' && method === 'GET') {
    return json(200, { domain: NOVAMAIL_DOMAIN });
  }

  if (route === '/api/novamail/create' && method === 'POST') {
    const body = await readJson(request);
    try {
      return json(201, await registerAddress(env, body));
    } catch (error) {
      return json(error.status || 400, { error: error.message });
    }
  }

  if (route === '/api/login' && method === 'POST') {
    const body = await readJson(request);

    if (String(body.provider || '') === 'novamail') {
      const address = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return json(400, { error: 'Adresse e-mail invalide.' });
      if (!password) return json(400, { error: 'Mot de passe requis.' });

      let profile;
      try {
        profile = await authenticate(env, address, password);
      } catch (error) {
        return json(401, { error: error.message });
      }

      const token = await seal(
        { kind: 'novamail', provider: 'novamail', email: profile.address, name: profile.name },
        env.NOVAMAIL_KEY,
      );
      return json(
        200,
        { email: profile.address, name: profile.name, provider: 'novamail', imap: null, smtp: null },
        { 'set-cookie': setCookie(token, SESSION_MAX_AGE) },
      );
    }

    const config = cleanConfig(body);
    const password = String(body.password || '');

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.email)) return json(400, { error: 'Adresse e-mail invalide.' });
    if (!password) return json(400, { error: 'Mot de passe requis.' });
    if (!config.imap.host || !config.smtp.host) return json(400, { error: 'Serveurs IMAP et SMTP requis.' });

    try {
      await withImap(config, password, async (client) => {
        await client.list();
      });
    } catch (error) {
      return json(401, { error: error.message });
    }

    const token = await seal({ ...config, pass: password }, env.NOVAMAIL_KEY);
    return json(
      200,
      { email: config.email, name: config.name || config.email.split('@')[0], imap: config.imap, smtp: config.smtp },
      { 'set-cookie': setCookie(token, SESSION_MAX_AGE) },
    );
  }

  if (route === '/api/session' && method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return json(401, { error: 'Non connecté.' });
    return json(200, {
      email: session.email,
      name: session.name || session.email.split('@')[0],
      provider: session.kind === 'novamail' ? 'novamail' : '',
      imap: session.imap || null,
      smtp: session.smtp || null,
    });
  }

  if (route === '/api/logout' && method === 'POST') {
    return json(200, { ok: true }, { 'set-cookie': clearCookie() });
  }

  const session = await getSession(request, env);
  if (!session) return json(401, { error: 'Session expirée, reconnecte-toi.' });

  if (session.kind === 'novamail') return handleNovamail(request, env, session, url, route, method);

  try {
    if (route === '/api/folders' && method === 'GET') {
      const folders = await withImap(session, session.pass, async (client) => {
        const list = await client.list();
        const items = [];
        for (const box of list.slice(0, 40)) {
          let counts = { messages: 0, unseen: 0 };
          try {
            counts = await client.status(box.path);
          } catch {
            /* statut indisponible */
          }
          items.push({
            path: box.path,
            name: box.path.split('/').pop().split('.').pop() || box.path,
            special: specialUse(box.path, box.flags),
            total: counts.messages,
            unseen: counts.unseen,
          });
        }
        const order = ['inbox', 'sent', 'drafts', 'junk', 'trash', 'archive'];
        items.sort((a, b) => {
          const ia = order.indexOf(a.special);
          const ib = order.indexOf(b.special);
          if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          return a.path.localeCompare(b.path);
        });
        return items;
      });
      return json(200, { folders });
    }

    if (route === '/api/messages' && method === 'GET') {
      const box = url.searchParams.get('box') || 'INBOX';
      const result = await withImap(session, session.pass, (client) => client.fetchHeaders(box, 60));
      return json(200, { box, total: result.total, messages: result.messages });
    }

    if (route === '/api/message' && method === 'GET') {
      const box = url.searchParams.get('box') || 'INBOX';
      const uid = url.searchParams.get('uid') || '';
      const raw = await withImap(session, session.pass, (client) => client.fetchMessage(box, uid));

      const parsed = await parseRaw(raw);

      return json(200, {
        uid,
        subject: parsed.subject || '(sans objet)',
        from: parsed.from ? (parsed.from.name ? parsed.from.name + ' <' + parsed.from.address + '>' : parsed.from.address) : '',
        to: (parsed.to || []).map((item) => item.address).join(', '),
        cc: (parsed.cc || []).map((item) => item.address).join(', '),
        date: parsed.date || new Date().toISOString(),
        text: parsed.text || '',
        html: parsed.html || '',
        messageId: parsed.messageId || '',
        references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '',
        attachments: (parsed.attachments || []).map((file) => ({
          filename: file.filename || 'pièce jointe',
          size: file.content && file.content.byteLength ? file.content.byteLength : 0,
        })),
      });
    }

    if (route === '/api/attachment' && method === 'GET') {
      const box = url.searchParams.get('box') || 'INBOX';
      const uid = url.searchParams.get('uid') || '';
      const index = Number(url.searchParams.get('index'));
      const raw = await withImap(session, session.pass, (client) => client.fetchMessage(box, uid));
      const parsed = await parseRaw(raw);
      const file = (parsed.attachments || [])[index];
      if (!file || !file.content) return json(404, { error: 'Pièce jointe introuvable.' });

      const name = String(file.filename || 'piece-jointe').replace(/[\r\n"]/g, '').slice(0, 180) || 'piece-jointe';
      const ascii = name.replace(/[^\x20-\x7E]/g, '_');
      const bytes = file.content instanceof ArrayBuffer ? new Uint8Array(file.content) : file.content;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': file.mimeType || 'application/octet-stream',
          'content-disposition': "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name),
          'content-length': String(bytes.byteLength || 0),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    if (route === '/api/flags' && method === 'POST') {
      const body = await readJson(request);
      await withImap(session, session.pass, (client) => client.setSeen(String(body.box || 'INBOX'), String(body.uid || ''), Boolean(body.seen)));
      return json(200, { ok: true });
    }

    if (route === '/api/flag' && method === 'POST') {
      const body = await readJson(request);
      await withImap(session, session.pass, (client) =>
        client.setFlagged(String(body.box || 'INBOX'), String(body.uid || ''), Boolean(body.flagged)),
      );
      return json(200, { ok: true });
    }

    if (route === '/api/delete' && method === 'POST') {
      const body = await readJson(request);
      await withImap(session, session.pass, (client) =>
        client.deleteMessage(String(body.box || 'INBOX'), String(body.uid || '')),
      );
      return json(200, { ok: true });
    }

    if (route === '/api/read-all' && method === 'POST') {
      const body = await readJson(request);
      const count = await withImap(session, session.pass, (client) => client.markAllSeen(String(body.box || 'INBOX')));
      return json(200, { ok: true, count });
    }

    if (route === '/api/send' && method === 'POST') {
      const body = await readJson(request);
      const to = String(body.to || '').trim();
      const cc = String(body.cc || '').trim();
      const valid = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
      if (!valid(to)) return json(400, { error: 'Destinataire invalide.' });
      if (cc && !cc.split(',').every((item) => valid(item.trim()))) return json(400, { error: 'Copie (Cc) invalide.' });

      const recipients = [to].concat(cc ? cc.split(',').map((item) => item.trim()) : []);

      try {
        await sendMail(
          session.smtp,
          authPassword(session.smtp.host, session.pass),
          {
            user: session.email,
            from: session.email,
            fromName: session.name || session.email.split('@')[0],
            recipients,
            to,
            cc,
            subject: String(body.subject || '').trim(),
            text: String(body.text || ''),
            html: cleanEmailHtml(body.html),
            dryRun: Boolean(body.dryRun),
          },
        );
      } catch (error) {
        throw new Error(friendlyError(error, session));
      }

      return json(200, { ok: true });
    }

    return json(404, { error: 'Route inconnue.' });
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handleNovamail(request, env, session, url, route, method) {
  const address = session.email;

  try {
    if (route === '/api/folders' && method === 'GET') {
      return json(200, { folders: await listFolders(env, address) });
    }

    if (route === '/api/messages' && method === 'GET') {
      const box = url.searchParams.get('box') || 'INBOX';
      const folder = box === 'SENT' ? 'sent' : 'inbox';
      const data = await listMailbox(env, address, folder);
      return json(200, { box, total: data.total, messages: data.messages });
    }

    if (route === '/api/message' && method === 'GET') {
      return json(200, await readMailboxMessage(env, address, String(url.searchParams.get('uid') || '')));
    }


    if (route === '/api/flags' && method === 'POST') {
      const body = await readJson(request);
      await setMessageSeen(env, address, String(body.uid || ''), Boolean(body.seen));
      return json(200, { ok: true });
    }

    if (route === '/api/read-all' && method === 'POST') {
      const body = await readJson(request);
      const folder = String(body.box || 'INBOX') === 'SENT' ? 'sent' : 'inbox';
      return json(200, { ok: true, count: await markAllMessagesSeen(env, address, folder) });
    }

    if (route === '/api/delete' && method === 'POST') {
      const body = await readJson(request);
      await deleteMailboxMessage(env, address, String(body.uid || ''));
      return json(200, { ok: true });
    }

    if (route === '/api/flag') {
      return json(501, { error: 'L\'étoile « Important » n\'est pas disponible sur une adresse NovaMail.' });
    }

    if (route === '/api/send' && method === 'POST') {
      const body = await readJson(request);
      const to = String(body.to || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(400, { error: 'Destinataire invalide.' });
      const subject = String(body.subject || '').trim() || '(sans objet)';
      const text = String(body.text || '');
      const html = cleanEmailHtml(body.html);
      await sendFromAddress(env, address, { to, subject, text, html });
      try {
        await storeSentMessage(env, address, { to, subject, text, html });
      } catch (error) {
        console.error('Copie envoyée non enregistrée :', error && error.message);
      }
      return json(200, { ok: true });
    }

    return json(404, { error: 'Route inconnue.' });
  } catch (error) {
    return json(error.status || 502, { error: error.message });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();

    if (DOWNLOAD_PATHS.has(path)) {
      return new Response(null, {
        status: 302,
        headers: {
          location: DOWNLOAD_TARGET,
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    if (url.pathname === '/api/inbound-raw') {
      if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
      const secret = String(env.NOVAMAIL_INBOUND_SECRET || '');
      if (!secret || String(request.headers.get('x-novamail-secret') || '') !== secret) {
        return json(401, { error: 'Secret de réception invalide.' });
      }

      const raw = await request.text();
      if (!raw) return json(400, { error: 'Message vide.' });
      if (raw.length > 2000000) return json(413, { error: 'Message trop lourd (2 Mo maximum).' });

      try {
        const parsed = await parseRaw(raw);
        const result = await storeParsedMessage(env, {
          to: (parsed.to || []).map((item) => item.address),
          fromName: parsed.from && parsed.from.name ? parsed.from.name : '',
          fromAddress: parsed.from ? parsed.from.address || '' : '',
          subject: parsed.subject || '(sans objet)',
          text: parsed.text || '',
          html: parsed.html || '',
          date: parsed.date || new Date().toISOString(),
        });
        return json(200, result);
      } catch (error) {
        return json(500, { error: String(error && error.message ? error.message : error) });
      }
    }

    if (url.pathname === '/api/inbound') {
      if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
      const raw = await request.text();
      let valid = false;
      try {
        valid = await verifyWebhook(env.RESEND_WEBHOOK_SECRET, request.headers, raw);
      } catch {
        valid = false;
      }
      if (!valid) return json(401, { error: 'Signature du webhook invalide.' });
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        return json(400, { error: 'JSON invalide.' });
      }
      try {
        return json(200, await handleInbound(env, payload));
      } catch (error) {
        return json(500, { error: error.message });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        return json(500, { error: String(error && error.message ? error.message : error) });
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    const notFound = await env.ASSETS.fetch(new URL('/index.html', url));
    if (!notFound.ok) return response;
    return new Response(notFound.body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};

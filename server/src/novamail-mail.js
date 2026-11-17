/* ------------------------------------------------------------------ */
/* Adresses NovaMail hébergées                                         */
/*                                                                     */
/* Les messages arrivent par le webhook Resend (/api/inbound) et sont  */
/* stockés dans la base D1 du site. Chaque adresse est un identifiant  */
/* NovaMail (nom + mot de passe) : elle reçoit tout le courrier envoyé */
/* à <nom>@novacorpbumpify.dpdns.org, sans configuration côté client.  */
/* ------------------------------------------------------------------ */

export const NOVAMAIL_DOMAIN = 'novacorpbumpify.dpdns.org';

const RESEND_API = 'https://api.resend.com';
const encoder = new TextEncoder();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nm_addresses (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    local_part TEXT NOT NULL,
    display_name TEXT,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nm_messages (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    from_name TEXT,
    from_address TEXT,
    to_address TEXT,
    subject TEXT,
    text TEXT,
    html TEXT,
    received_at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    folder TEXT NOT NULL DEFAULT 'inbox',
    to_address TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS nm_messages_address ON nm_messages (address, received_at DESC)`,
];

let schemaReady = false;

export async function ensureSchema(env) {
  if (schemaReady) return;
  for (const statement of SCHEMA) {
    await env.DB.prepare(statement).run();
  }
  for (const statement of [
    "ALTER TABLE nm_messages ADD COLUMN to_address TEXT",
    "ALTER TABLE nm_messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox'",
  ]) {
    try {
      await env.DB.prepare(statement).run();
    } catch {
      /* colonne déjà présente */
    }
  }
  try {
    await env.DB.prepare("UPDATE nm_messages SET folder = 'inbox' WHERE folder IS NULL").run();
  } catch {
    /* migration best-effort */
  }
  schemaReady = true;
}

function jsonError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function normalizeLocal(value) {
  const clean = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 30);
  if (clean.length < 3) throw jsonError('Choisis un nom d\'au moins 3 caractères (lettres, chiffres, point, tiret).');
  return clean;
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function publicAddress(row) {
  return {
    id: row.id,
    address: row.address,
    name: row.display_name || row.local_part,
    provider: 'novamail',
  };
}

export async function registerAddress(env, input) {
  await ensureSchema(env);
  const values = input || {};
  const local = normalizeLocal(values.local);
  const password = String(values.password || '');
  if (password.length < 8) throw jsonError('Choisis un mot de passe d\'au moins 8 caractères.');
  if (password.length > 200) throw jsonError('Mot de passe trop long (200 caractères maximum).');

  const address = local + '@' + NOVAMAIL_DOMAIN;
  const existing = await env.DB.prepare('SELECT address FROM nm_addresses WHERE address = ?').bind(address).first();
  if (existing) throw jsonError('Cette adresse est déjà prise, choisis un autre nom.');

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.DB.prepare(
    'INSERT INTO nm_addresses (id, address, local_part, display_name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(randomHex(12), address, local, String(values.name || local).slice(0, 60), salt, hash, new Date().toISOString())
    .run();

  return { address, domain: NOVAMAIL_DOMAIN, provider: 'novamail' };
}

export async function authenticate(env, address, password) {
  await ensureSchema(env);
  const normalized = String(address || '').trim().toLowerCase();
  const row = await env.DB.prepare('SELECT * FROM nm_addresses WHERE address = ?').bind(normalized).first();
  if (!row) throw new Error('Adresse NovaMail inconnue. Crée-la d\'abord.');
  const hash = await hashPassword(String(password || ''), row.salt);
  if (hash !== row.hash) throw new Error('Mot de passe incorrect.');
  return publicAddress(row);
}

export async function listMailbox(env, address, folder) {
  await ensureSchema(env);
  const normalizedFolder = folder === 'sent' ? 'sent' : 'inbox';
  const rows = await env.DB.prepare(
    'SELECT id, from_name, from_address, to_address, subject, received_at, seen, size, folder FROM nm_messages WHERE address = ? AND folder = ? ORDER BY received_at DESC LIMIT 200',
  )
    .bind(address, normalizedFolder)
    .all();

  const messages = (rows.results || []).map((row) => ({
    uid: row.id,
    subject: row.subject || '(sans objet)',
    fromName: row.from_name || '',
    fromAddress: row.from_address || '',
    toAddress: row.to_address || '',
    folder: row.folder || normalizedFolder,
    date: row.received_at,
    unread: !row.seen,
    flagged: false,
    size: row.size || 0,
  }));

  return {
    total: messages.length,
    unseen: messages.filter((message) => message.unread).length,
    messages,
  };
}

export async function readMailboxMessage(env, address, id) {
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT * FROM nm_messages WHERE address = ? AND id = ?').bind(address, String(id)).first();
  if (!row) throw new Error('Message introuvable.');
  await env.DB.prepare('UPDATE nm_messages SET seen = 1 WHERE id = ?').bind(row.id).run();

  return {
    uid: row.id,
    subject: row.subject || '(sans objet)',
    from: row.from_name ? row.from_name + ' <' + row.from_address + '>' : row.from_address || '',
    to: row.to_address || address,
    cc: '',
    folder: row.folder || 'inbox',
    date: row.received_at,
    text: row.text || '',
    html: row.html || '',
    messageId: '',
    references: '',
    attachments: [],
  };
}

export async function deleteMailboxMessage(env, address, id) {
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM nm_messages WHERE address = ? AND id = ?').bind(address, String(id)).run();
  return { ok: true };
}

export async function setMessageSeen(env, address, id, seen) {
  await ensureSchema(env);
  await env.DB.prepare('UPDATE nm_messages SET seen = ? WHERE address = ? AND id = ?')
    .bind(seen ? 1 : 0, address, String(id))
    .run();
  return { ok: true };
}

export async function markAllMessagesSeen(env, address, folder) {
  await ensureSchema(env);
  const normalizedFolder = folder === 'sent' ? 'sent' : 'inbox';
  const result = await env.DB.prepare('UPDATE nm_messages SET seen = 1 WHERE address = ? AND folder = ? AND seen = 0').bind(address, normalizedFolder).run();
  return result.meta && typeof result.meta.changes === 'number' ? result.meta.changes : 0;
}

export async function storeSentMessage(env, address, input) {
  await ensureSchema(env);
  const values = input || {};
  const to = String(values.to || '').trim().toLowerCase();
  const subject = String(values.subject || '').trim() || '(sans objet)';
  const text = String(values.text || '');
  const html = String(values.html || '');

  const sender = await env.DB.prepare('SELECT display_name, local_part FROM nm_addresses WHERE address = ?').bind(address).first();
  const fromName = (sender && (sender.display_name || sender.local_part)) || address;

  await env.DB.prepare(
    'INSERT INTO nm_messages (id, address, from_name, from_address, to_address, subject, text, html, received_at, seen, size, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  )
    .bind(
      randomHex(12),
      address,
      fromName,
      address,
      to,
      subject,
      text,
      html,
      new Date().toISOString(),
      text.length + html.length,
      'sent',
    )
    .run();

  return { ok: true };
}

export async function listFolders(env, address) {
  await ensureSchema(env);
  const inbox = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen FROM nm_messages WHERE address = ? AND folder = 'inbox'",
  )
    .bind(address)
    .first();
  const sent = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM nm_messages WHERE address = ? AND folder = 'sent'",
  )
    .bind(address)
    .first();

  return [
    { path: 'INBOX', name: 'Boîte de réception', special: 'inbox', total: Number(inbox && inbox.total) || 0, unseen: Number(inbox && inbox.unseen) || 0 },
    { path: 'SENT', name: 'Envoyés', special: 'sent', total: Number(sent && sent.total) || 0, unseen: 0 },
  ];
}

/* ------------------------------------------------------------------ */
/* Envoi                                                              */
/*                                                                     */
/* 1. Vers une autre adresse NovaMail : livraison interne, direct dans  */
/*    la boîte D1 du destinataire. Aucun service extérieur, gratuit.    */
/* 2. Vers l'extérieur : Cloudflare Email Sending, Mailjet, SMTP2GO ou  */
/*    Resend, selon les secrets configurés.                             */
/* ------------------------------------------------------------------ */

async function deliverInternal(env, fromAddress, input) {
  const to = String(input.to || '').trim().toLowerCase();
  if (!to.endsWith('@' + NOVAMAIL_DOMAIN)) return false;

  await ensureSchema(env);
  const recipient = await env.DB.prepare('SELECT address FROM nm_addresses WHERE address = ?').bind(to).first();
  if (!recipient) {
    const error = new Error('Cette adresse NovaMail nexiste pas : ' + to + '. Utilise une adresse existante ou une adresse externe.');
    error.status = 404;
    throw error;
  }

  const sender = await env.DB.prepare('SELECT display_name, local_part FROM nm_addresses WHERE address = ?').bind(fromAddress).first();
  const fromName = (sender && (sender.display_name || sender.local_part)) || fromAddress;

  await env.DB.prepare(
    'INSERT INTO nm_messages (id, address, from_name, from_address, subject, text, html, received_at, seen, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(
      randomHex(12),
      to,
      fromName,
      fromAddress,
      input.subject,
      input.text,
      input.html || '',
      new Date().toISOString(),
      String(input.text || input.html || '').length,
    )
    .run();

  return true;
}

export async function sendFromAddress(env, address, input) {
  const values = input || {};
  const to = String(values.to || '').trim();
  const subject = String(values.subject || '').trim() || '(sans objet)';
  const text = String(values.text || '');
  const html = String(values.html || '');

  if (await deliverInternal(env, address, { to, subject, text, html })) {
    return { ok: true, provider: 'interne' };
  }

  if (env.CF_EMAIL_TOKEN && env.CF_ACCOUNT_ID) {
    const response = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(env.CF_ACCOUNT_ID) + '/email/sending/send',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.CF_EMAIL_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ to, from: address, subject, text, html: html || undefined }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const detail = JSON.stringify((payload.errors || [])[0] || payload.message || payload).slice(0, 200);
      throw new Error('Cloudflare a refusé l\'envoi (' + response.status + '). ' + detail);
    }
    return { ok: true, provider: 'cloudflare' };
  }

  if (env.MAILJET_API_KEY && env.MAILJET_SECRET_KEY) {
    const auth = btoa(String(env.MAILJET_API_KEY) + ':' + String(env.MAILJET_SECRET_KEY));
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + auth,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        Messages: [
          {
            From: {
              Email: address,
              Name: String(values.fromName || '').trim() || address.split('@')[0],
            },
            To: [{ Email: to }],
            ReplyTo: { Email: address },
            Subject: subject,
            TextPart: text || undefined,
            HTMLPart: html || undefined,
          },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const first = (payload.Messages || [])[0] || {};
    if (!response.ok || first.Status === 'error') {
      const detail = JSON.stringify(first.Errors || payload).slice(0, 200);
      throw new Error('Mailjet a refusé l\'envoi (' + response.status + '). ' + detail);
    }
    return { ok: true, provider: 'mailjet' };
  }

  if (env.SMTP2GO_API_KEY) {
    const response = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        api_key: env.SMTP2GO_API_KEY,
        sender: address,
        to: [to],
        subject,
        text_body: text || undefined,
        html_body: html || undefined,
        custom_headers: [{ header: 'Reply-To', value: address }],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const data = payload.data || {};
    if (!response.ok || payload.error || (data.succeeded || 0) === 0) {
      const detail = JSON.stringify(payload.error || data.failures || data || payload).slice(0, 200);
      throw new Error('SMTP2GO a refusé l\'envoi (' + response.status + '). ' + detail);
    }
    return { ok: true, provider: 'smtp2go' };
  }

  if (!env.RESEND_API_KEY) {
    throw new Error(
      'Envoi vers l\'extérieur non configuré : ajoute MAILJET_API_KEY + MAILJET_SECRET_KEY (gratuit, 6000 mails/mois) ou SMTP2GO_API_KEY (gratuit, 1000 mails/mois) dans Sites → Secrets. Les envois internes (vers @' +
        NOVAMAIL_DOMAIN +
        ') fonctionnent déjà, sans rien configurer.',
    );
  }

  const response = await fetch(RESEND_API + '/emails', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.RESEND_API_KEY,
      'content-type': 'application/json',
      'user-agent': 'NovaMail',
    },
    body: JSON.stringify({ from: address, to: [to], subject, text, html: html || undefined, reply_to: address }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Resend a refusé l\'envoi (' + response.status + '). ' + detail.slice(0, 180));
  }
  return { ok: true, provider: 'resend' };
}

/* ------------------------------------------------------------------ */
/* Réception (webhook Resend)                                          */
/* ------------------------------------------------------------------ */

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function verifyWebhook(secret, headers, rawBody) {
  const key = String(secret || '').trim();
  if (!key) return false;
  const id = headers.get('svix-id') || headers.get('webhook-id') || '';
  const timestamp = headers.get('svix-timestamp') || headers.get('webhook-timestamp') || '';
  const signature = headers.get('svix-signature') || headers.get('webhook-signature') || '';
  if (!id || !timestamp || !signature) return false;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(key.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(id + '.' + timestamp + '.' + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));

  return signature
    .split(' ')
    .map((part) => (part.includes(',') ? part.split(',')[1] : part))
    .some((value) => value === expected);
}

async function fetchReceivedEmail(env, emailId) {
  if (!env.RESEND_API_KEY || !emailId) return null;
  try {
    const response = await fetch(RESEND_API + '/emails/receiving/' + encodeURIComponent(emailId), {
      headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'user-agent': 'NovaMail' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function storeParsedMessage(env, message) {
  await ensureSchema(env);
  const values = message || {};
  const recipients = [...new Set((values.to || []).map((value) => String(value || '').trim().toLowerCase()))].filter(
    (value) => value.endsWith('@' + NOVAMAIL_DOMAIN),
  );
  if (!recipients.length) return { stored: 0, ignored: 'recipient' };

  const subject = String(values.subject || '(sans objet)').slice(0, 300);
  const html = String(values.html || '');
  const text = String(values.text || '');
  const fromName = String(values.fromName || '').slice(0, 120);
  const fromAddress = String(values.fromAddress || '').slice(0, 200);
  const receivedAt = values.date ? new Date(values.date).toISOString() : new Date().toISOString();

  let stored = 0;
  for (const recipient of recipients) {
    const known = await env.DB.prepare('SELECT address FROM nm_addresses WHERE address = ?').bind(recipient).first();
    if (!known) continue;
    await env.DB.prepare(
      'INSERT INTO nm_messages (id, address, from_name, from_address, subject, text, html, received_at, seen, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
    )
      .bind(randomHex(12), recipient, fromName, fromAddress, subject, text, html, receivedAt, html.length + text.length)
      .run();
    stored += 1;
  }

  return { stored };
}

export async function handleInbound(env, payload) {
  await ensureSchema(env);
  const event = payload || {};
  if (event.type && event.type !== 'email.received') return { stored: 0, ignored: 'event' };

  const data = event.data || {};
  const recipients = [...(data.to || []), ...(data.received_for || [])]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => value.endsWith('@' + NOVAMAIL_DOMAIN));
  if (!recipients.length) return { stored: 0, ignored: 'recipient' };

  const body = await fetchReceivedEmail(env, data.email_id || data.id);
  const html = body && body.html ? String(body.html) : '';
  const text = body && body.text ? String(body.text) : '';
  const from = String((body && body.from) || data.from || '');
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  const fromName = match ? match[1].replace(/^"|"$/g, '') : '';
  const fromAddress = match ? match[2].trim() : from.trim();
  const subject = String((body && body.subject) || data.subject || '(sans objet)').slice(0, 300);
  const receivedAt = String((body && (body.created_at || body.createdAt)) || data.created_at || new Date().toISOString());
  const size = (html.length + text.length) || 0;

  let stored = 0;
  for (const recipient of [...new Set(recipients)]) {
    const known = await env.DB.prepare('SELECT address FROM nm_addresses WHERE address = ?').bind(recipient).first();
    if (!known) continue;
    await env.DB.prepare(
      'INSERT INTO nm_messages (id, address, from_name, from_address, subject, text, html, received_at, seen, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
    )
      .bind(randomHex(12), recipient, fromName.slice(0, 120), fromAddress.slice(0, 200), subject, text, html, receivedAt, size)
      .run();
    stored += 1;
  }

  return { stored };
}

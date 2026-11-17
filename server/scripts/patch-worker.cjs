'use strict';

/* Patch ponctuel du worker : bascule de la branche NovaMail sur D1 + Resend. */

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'src', 'worker.js');
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const before = source.length;

function cut(anchor, endAnchor, label) {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error('ancre introuvable : ' + label);
  const end = source.indexOf(endAnchor, start);
  if (end < 0) throw new Error('fin introuvable : ' + label);
  source = source.slice(0, start) + source.slice(end + 1);
}

function swap(anchor, replacement, label) {
  if (!source.includes(anchor)) throw new Error('bloc introuvable : ' + label);
  source = source.replace(anchor, replacement);
}

/* 1. Supprimer l'ancien bloc pièces jointes (mail.tm), désormais inutile. */
cut(
  "    if (route === '/api/attachment' && method === 'GET') {\n      const file = await fetchNovamailAttachment(",
  "\n\n    if (route === '/api/flags'",
  'attachment',
);

/* 2. Étoile */
swap(
  "    if (route === '/api/flag') {\n      return json(501, { error: 'L\\'étoile « Important » n\\'est pas disponible pour une adresse NovaMail gratuite.' });\n    }",
  "    if (route === '/api/flag') {\n      return json(501, { error: 'L\\'étoile « Important » n\\'est pas disponible sur une adresse NovaMail.' });\n    }",
  'flag',
);

/* 3. Envoi réel via Resend */
swap(
  "    if (route === '/api/send') {\n      return json(501, {\n        error: 'Une adresse NovaMail gratuite reçoit les messages mais ne peut pas en envoyer. Ajoute ton compte habituel (Gmail, Outlook…) pour répondre.',\n      });\n    }",
  "    if (route === '/api/send' && method === 'POST') {\n      const body = await readJson(request);\n      const to = String(body.to || '').trim();\n      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(to)) return json(400, { error: 'Destinataire invalide.' });\n      await sendFromAddress(env, address, {\n        to,\n        subject: body.subject,\n        text: body.text,\n        html: cleanEmailHtml(body.html),\n      });\n      return json(200, { ok: true });\n    }",
  'send',
);

/* 4. Webhook de réception, public (pas de session) */
swap(
  "    if (url.pathname.startsWith('/api/')) {",
  [
    "    if (url.pathname === '/api/inbound') {",
    "      if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });",
    '      const raw = await request.text();',
    '      let valid = false;',
    '      try {',
    '        valid = await verifyWebhook(env.RESEND_WEBHOOK_SECRET, request.headers, raw);',
    '      } catch {',
    '        valid = false;',
    '      }',
    "      if (!valid) return json(401, { error: 'Signature du webhook invalide.' });",
    '      let payload = {};',
    '      try {',
    '        payload = JSON.parse(raw);',
    '      } catch {',
    "        return json(400, { error: 'JSON invalide.' });",
    '      }',
    '      try {',
    '        return json(200, await handleInbound(env, payload));',
    '      } catch (error) {',
    '        return json(500, { error: error.message });',
    '      }',
    '    }',
    '',
    "    if (url.pathname.startsWith('/api/')) {",
  ].join('\n'),
  'inbound',
);

fs.writeFileSync(file, source, 'utf8');
console.log('worker patché :', before, '->', source.length, 'caractères');

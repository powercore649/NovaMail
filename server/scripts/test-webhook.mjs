import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = path.join(process.cwd(), 'src', 'novamail-mail.js');
const mod = await import(pathToFileURL(modulePath).href);

const raw = crypto.randomBytes(24);
const secret = 'whsec_' + raw.toString('base64');
const id = 'msg_2abc';
const ts = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({ type: 'email.received', data: { to: ['moi@novacorpbumpify.dpdns.org'] } });
const signature = crypto.createHmac('sha256', raw).update(id + '.' + ts + '.' + body).digest('base64');
const headers = new Headers({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + signature });

console.log('signature valide :', await mod.verifyWebhook(secret, headers, body));
console.log('mauvais corps    :', await mod.verifyWebhook(secret, headers, body + ' '));
console.log('mauvais secret   :', await mod.verifyWebhook('whsec_' + crypto.randomBytes(24).toString('base64'), headers, body));
console.log('sans secret      :', await mod.verifyWebhook('', headers, body));
console.log('domaine          :', mod.NOVAMAIL_DOMAIN);

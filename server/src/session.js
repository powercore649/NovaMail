const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret) {
  // La clé AES est dérivée de la valeur fournie : n'importe quel secret
  // non vide fonctionne (même court), sans jamais bloquer la connexion.
  const value = String(secret || '');
  if (!value) throw new Error('Clé de session manquante.');
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(payload, secretB64) {
  const key = await importKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload))));
  const joined = new Uint8Array(iv.length + cipher.length);
  joined.set(iv, 0);
  joined.set(cipher, iv.length);
  return base64UrlEncode(joined);
}

export async function open(value, secretB64) {
  const key = await importKey(secretB64);
  const bytes = base64UrlDecode(String(value));
  const iv = bytes.subarray(0, 12);
  const cipher = bytes.subarray(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(decoder.decode(plain));
}

export function setCookie(token, maxAge) {
  return 'novamail=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAge;
}

export function clearCookie() {
  return 'novamail=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

export function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

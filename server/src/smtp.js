import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64Utf8(value) {
  const bytes = encoder.encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeHeader(value, fallback) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return fallback;
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return '=?UTF-8?B?' + b64Utf8(text) + '?=';
}

function wrapBase64(value) {
  return value.replace(/(.{76})/g, '$1\r\n');
}

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.attach(socket);
    this.buffer = new Uint8Array(0);
  }

  attach(socket) {
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
  }

  async readLine() {
    for (;;) {
      for (let i = 0; i < this.buffer.length - 1; i += 1) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          const line = decoder.decode(this.buffer.subarray(0, i));
          this.buffer = this.buffer.subarray(i + 2);
          return line;
        }
      }
      const { value, done } = await this.reader.read();
      if (done) {
        const rest = decoder.decode(this.buffer);
        this.buffer = new Uint8Array(0);
        return rest;
      }
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer, 0);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
  }

  async write(text) {
    await this.writer.write(encoder.encode(text));
  }

  async reply() {
    const lines = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) break;
    }
    const last = lines[lines.length - 1] || '';
    const code = Number(last.slice(0, 3)) || 0;
    return { code, lines, text: lines.join('\n') };
  }

  async expect(codes, action) {
    const reply = await this.reply();
    if (!codes.includes(reply.code)) {
      throw new Error(action + ' : ' + (reply.lines[reply.lines.length - 1] || 'réponse SMTP inattendue'));
    }
    return reply;
  }

  async command(line, codes, action) {
    await this.write(line + '\r\n');
    return this.expect(codes, action);
  }

  async startTls() {
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch {
      /* verrous déjà libérés */
    }
    const socket = this.socket.startTls();
    this.socket = socket;
    this.buffer = new Uint8Array(0);
    this.attach(socket);
  }

  async close() {
    try {
      await this.writer.write(encoder.encode('QUIT\r\n'));
    } catch {
      /* déjà fermé */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* déjà libéré */
    }
    try {
      await this.socket.close();
    } catch {
      /* déjà fermé */
    }
  }
}

export async function sendMail(config, password, message) {
  const secureFirst = Boolean(config.secure);
  const socket = connect(
    { hostname: config.host, port: Number(config.port) },
    { secureTransport: secureFirst ? 'on' : 'starttls' },
  );

  const client = new SmtpClient(socket);

  try {
    await client.expect([220], 'Accueil SMTP');
    let ehlo = await client.command('EHLO novamail', [250], 'EHLO');

    if (!secureFirst) {
      const supportsStartTls = /\bSTARTTLS\b/i.test(ehlo.text);
      if (!supportsStartTls) throw new Error('Le serveur SMTP ne propose pas STARTTLS : utilise le port 465 avec SSL.');
      await client.command('STARTTLS', [220], 'STARTTLS');
      await client.startTls();
      ehlo = await client.command('EHLO novamail', [250], 'EHLO après STARTTLS');
    }

    const mechanisms = /\bAUTH\b([^\n]*)/i.exec(ehlo.text);
    if (!mechanisms || !/LOGIN|PLAIN/i.test(mechanisms[1] || '')) {
      throw new Error('Le serveur SMTP n\'accepte pas AUTH LOGIN.');
    }

    await client.command('AUTH LOGIN', [334], 'AUTH LOGIN');
    await client.command(b64Utf8(message.user), [334], 'Identifiant SMTP');
    await client.command(b64Utf8(password), [235], 'Mot de passe SMTP');

    if (message.dryRun) return true;

    await client.command('MAIL FROM:<' + message.from + '>', [250], 'Expéditeur refusé');
    for (const recipient of message.recipients) {
      await client.command('RCPT TO:<' + recipient + '>', [250, 251], 'Destinataire refusé (' + recipient + ')');
    }

    await client.command('DATA', [354], 'DATA refusé');

    const html = String(message.html || '').trim();
    const boundary = 'nova-' + crypto.randomUUID();
    const headers = [
      'From: ' + encodeHeader(message.fromName, '') + ' <' + message.from + '>',
      'To: ' + message.to,
      message.cc ? 'Cc: ' + message.cc : '',
      'Subject: ' + encodeHeader(message.subject, '(sans objet)'),
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomUUID() + '@' + message.from.split('@')[1] + '>',
      'MIME-Version: 1.0',
      html ? 'Content-Type: multipart/alternative; boundary="' + boundary + '"' : 'Content-Type: text/plain; charset=UTF-8',
      html ? '' : 'Content-Transfer-Encoding: base64',
    ].filter(Boolean);

    let body;
    if (html) {
      body =
        '--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        wrapBase64(b64Utf8(message.text)) +
        '\r\n--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        wrapBase64(b64Utf8(html)) +
        '\r\n--' + boundary + '--';
    } else {
      body = wrapBase64(b64Utf8(message.text));
    }
    await client.write(headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.\r\n');
    await client.expect([250], 'Envoi du message');

    return true;
  } finally {
    await client.close();
  }
}

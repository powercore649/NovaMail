import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function indexOfCrlf(bytes) {
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function decodeMimeWords(value) {
  return String(value == null ? '' : value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, mode, data) => {
    try {
      const normalized = String(charset).toLowerCase();
      let text;
      if (mode.toUpperCase() === 'B') {
        text = new TextDecoder(normalized === 'utf-8' ? 'utf-8' : normalized).decode(
          Uint8Array.from(atob(data.replace(/\s+/g, '')), (char) => char.charCodeAt(0)),
        );
      } else {
        const decoded = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
        text = new TextDecoder(normalized === 'utf-8' ? 'utf-8' : normalized).decode(bytes);
      }
      return text;
    } catch {
      return match;
    }
  });
}

function quote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function parseInternalDate(value) {
  const match = String(value || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const utc = Date.UTC(Number(year), MONTHS[month] || 0, Number(day), Number(hour), Number(minute), Number(second));
  const shift = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60000 * (sign === '-' ? -1 : 1);
  return new Date(utc - shift).toISOString();
}

function parseAddress(value) {
  const text = decodeMimeWords(String(value || '').trim());
  const match = text.match(/^(.*)<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ''), address: match[2].trim() };
  }
  return { name: '', address: text };
}

export class ImapClient {
  constructor(socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    this.buffer = new Uint8Array(0);
    this.ended = false;
    this.tag = 0;
  }

  static async connect(config) {
    if (!config.secure) throw new Error('IMAP sans TLS n\'est pas pris en charge : utilise le port 993 avec SSL.');
    const socket = connect({ hostname: config.host, port: Number(config.port) }, { secureTransport: 'on' });
    const client = new ImapClient(socket);
    const greeting = await client.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
      throw new Error('Le serveur IMAP a refusé la connexion : ' + greeting);
    }
    return client;
  }

  async readMore() {
    if (this.ended) return false;
    const { value, done } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    this.buffer = concat(this.buffer, value);
    return true;
  }

  async fill(count) {
    while (this.buffer.length < count && !this.ended) {
      await this.readMore();
    }
  }

  async readLine() {
    for (;;) {
      const index = indexOfCrlf(this.buffer);
      if (index >= 0) {
        const line = decoder.decode(this.buffer.subarray(0, index));
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      if (!(await this.readMore())) {
        if (!this.buffer.length) return '';
        const rest = decoder.decode(this.buffer);
        this.buffer = new Uint8Array(0);
        return rest;
      }
    }
  }

  async readBytes(count) {
    await this.fill(count);
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  async command(text) {
    this.tag += 1;
    const tag = 'A' + this.tag;
    await this.writer.write(encoder.encode(tag + ' ' + text + '\r\n'));

    const segments = [];
    let status = 'BAD';
    let summary = '';

    for (;;) {
      const line = await this.readLine();
      if (line === '') {
        if (this.ended) break;
        continue;
      }
      const literal = line.match(/\{(\d+)\}$/);
      if (literal) {
        segments.push({ text: line + '\r\n', bytes: null });
        const bytes = await this.readBytes(Number(literal[1]));
        segments.push({ text: null, bytes });
        continue;
      }
      if (line.startsWith(tag + ' ')) {
        const parts = line.split(' ');
        status = (parts[1] || '').toUpperCase();
        summary = line.slice(tag.length + 1);
        break;
      }
      segments.push({ text: line + '\r\n', bytes: null });
    }

    return { status, summary, segments };
  }

  textOf(segments) {
    return segments.map((segment) => (segment.text !== null ? segment.text : decoder.decode(segment.bytes))).join('');
  }

  async login(user, pass) {
    const result = await this.command('LOGIN ' + quote(user) + ' ' + quote(pass));
    if (result.status !== 'OK') {
      const error = new Error(result.summary || 'Connexion IMAP refusée.');
      error.serverResponse = result.summary;
      throw error;
    }
  }

  async list() {
    const result = await this.command('LIST "" "*"');
    if (result.status !== 'OK') throw new Error('LIST a échoué : ' + result.summary);

    const mailboxes = [];
    for (const segment of result.segments) {
      const text = segment.text === null ? '' : segment.text;
      const match = text.match(/^\* LIST \(([^)]*)\) ([^ ]+) (.*)\r\n$/);
      if (!match) continue;
      let name = match[3].trim();
      if (name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      mailboxes.push({ path: name, flags: match[1] });
    }
    return mailboxes;
  }

  async status(mailbox) {
    const result = await this.command('STATUS ' + quote(mailbox) + ' (MESSAGES UNSEEN)');
    const text = this.textOf(result.segments);
    const messages = /MESSAGES (\d+)/i.exec(text);
    const unseen = /UNSEEN (\d+)/i.exec(text);
    return {
      messages: messages ? Number(messages[1]) : 0,
      unseen: unseen ? Number(unseen[1]) : 0,
    };
  }

  async select(mailbox) {
    const result = await this.command('SELECT ' + quote(mailbox));
    const text = this.textOf(result.segments);
    const exists = /\* (\d+) EXISTS/i.exec(text);
    return { status: result.status, exists: exists ? Number(exists[1]) : 0, summary: result.summary };
  }

  async fetchHeaders(mailbox, limit) {
    const selected = await this.select(mailbox);
    if (selected.status !== 'OK') throw new Error(selected.summary || 'Dossier introuvable.');

    const total = selected.exists;
    if (!total) return { total: 0, messages: [] };

    const start = Math.max(1, total - limit + 1);
    const result = await this.command(
      'FETCH ' + start + ':' + total + ' (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])',
    );
    if (result.status !== 'OK') throw new Error('FETCH a échoué : ' + result.summary);

    const messages = [];
    let pending = '';

    for (const segment of result.segments) {
      if (segment.text !== null) {
        if (/^\* \d+ FETCH/.test(segment.text)) pending = segment.text;
        else if (pending) pending += segment.text;
        continue;
      }

      const headers = decoder.decode(segment.bytes);
      const uid = /UID (\d+)/.exec(pending);
      const flags = /FLAGS \(([^)]*)\)/.exec(pending);
      const date = /INTERNALDATE "([^"]+)"/.exec(pending);
      const size = /RFC822\.SIZE (\d+)/.exec(pending);

      const fromMatch = /^From:\s*(.*(?:\r?\n[ \t].*)*)$/im.exec(headers);
      const subjectMatch = /^Subject:\s*(.*(?:\r?\n[ \t].*)*)$/im.exec(headers);
      const dateMatch = /^Date:\s*(.*(?:\r?\n[ \t].*)*)$/im.exec(headers);

      const from = parseAddress((fromMatch ? fromMatch[1] : '').replace(/\r?\n[ \t]+/g, ' '));
      const subject = decodeMimeWords((subjectMatch ? subjectMatch[1] : '').replace(/\r?\n[ \t]+/g, ' ').trim());

      messages.push({
        uid: uid ? Number(uid[1]) : 0,
        subject: subject || '(sans objet)',
        fromName: from.name,
        fromAddress: from.address,
        date: (dateMatch && Date.parse(dateMatch[1].trim())) || parseInternalDate(date ? date[1] : '') || new Date().toISOString(),
        unread: !(flags && flags[1].includes('\\Seen')),
        flagged: Boolean(flags && flags[1].includes('\\Flagged')),
        size: size ? Number(size[1]) : 0,
      });
      pending = '';
    }

    messages.reverse();
    return { total, messages };
  }

  async fetchMessage(mailbox, uid) {
    const selected = await this.select(mailbox);
    if (selected.status !== 'OK') throw new Error(selected.summary || 'Dossier introuvable.');

    const result = await this.command('UID FETCH ' + uid + ' (BODY.PEEK[])');
    if (result.status !== 'OK') throw new Error('Message introuvable : ' + result.summary);

    let raw = null;
    for (const segment of result.segments) {
      if (segment.bytes && segment.bytes.length && !raw) {
        raw = segment.bytes;
        break;
      }
    }
    if (!raw) throw new Error('Message introuvable.');
    return raw;
  }

  async setSeen(mailbox, uid, seen) {
    const selected = await this.select(mailbox);
    if (selected.status !== 'OK') throw new Error(selected.summary || 'Dossier introuvable.');
    const result = await this.command('UID STORE ' + uid + ' ' + (seen ? '+FLAGS' : '-FLAGS') + ' (\\Seen)');
    if (result.status !== 'OK') throw new Error('Impossible de modifier le message : ' + result.summary);
  }

  async setFlagged(mailbox, uid, flagged) {
    const selected = await this.select(mailbox);
    if (selected.status !== 'OK') throw new Error(selected.summary || 'Dossier introuvable.');
    const result = await this.command('UID STORE ' + uid + ' ' + (flagged ? '+FLAGS' : '-FLAGS') + ' (\\Flagged)');
    if (result.status !== 'OK') throw new Error('Impossible de modifier le message : ' + result.summary);
  }

  async findTrash() {
    const mailboxes = await this.list();
    const byFlag = mailboxes.find((box) => /\trash/i.test(box.flags));
    if (byFlag) return byFlag.path;
    const byName = mailboxes.find((box) => /^(trash|corbeille|deleted items|éléments supprimés)$/i.test(box.path));
    return byName ? byName.path : null;
  }

  async deleteMessage(mailbox, uid) {
    const selected = await this.select(mailbox);
    if (selected.status !== 'OK') throw new Error(selected.summary || 'Dossier introuvable.');

    const trash = await this.findTrash();
    if (trash && trash !== mailbox) {
      const copy = await this.command('UID COPY ' + uid + ' ' + quote(trash));
      if (copy.status !== 'OK') throw new Error('Impossible de déplacer le message : ' + copy.summary);
    }

    const store = await this.command('UID STORE ' + uid + ' +FLAGS (\Deleted)');
    if (store.status !== 'OK') throw new Error('Impossible de supprimer le message : ' + store.summary);

    const expunge = await this.command('UID EXPUNGE ' + uid);
    if (expunge.status !== 'OK') {
      const fallback = await this.command('EXPUNGE');
      if (fallback.status !== 'OK') throw new Error('Impossible de supprimer le message : ' + fallback.summary);
    }
  }

  async markAllSeen(mailbox) {
    const selected = await this.select(mailbox);
    if (selected.status !== 'OK') throw new Error(selected.summary || 'Dossier introuvable.');
    if (!selected.exists) return 0;
    const result = await this.command('UID STORE 1:* +FLAGS.SILENT (\Seen)');
    if (result.status !== 'OK') throw new Error('Impossible de marquer les messages : ' + result.summary);
    return selected.exists;
  }

  async logout() {
    try {
      await this.writer.write(encoder.encode('A999 LOGOUT\r\n'));
    } catch {
      /* socket déjà fermée */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* verrou déjà libéré */
    }
    try {
      await this.socket.close();
    } catch {
      /* déjà fermée */
    }
  }
}

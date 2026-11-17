'use strict';

const api = window.novaMail;

const PRESETS = {
  gmail: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  yahoo: { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
  icloud: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  ovh: { imap: { host: 'ssl0.ovh.net', port: 993, secure: true }, smtp: { host: 'ssl0.ovh.net', port: 465, secure: true } },
  free: { imap: { host: 'imap.free.fr', port: 993, secure: true }, smtp: { host: 'smtp.free.fr', port: 465, secure: true } },
  orange: { imap: { host: 'imap.orange.fr', port: 993, secure: true }, smtp: { host: 'smtp.orange.fr', port: 465, secure: true } },
};

const DOMAIN_PRESETS = {
  'gmail.com': 'gmail',
  'outlook.fr': 'outlook',
  'outlook.com': 'outlook',
  'hotmail.fr': 'outlook',
  'hotmail.com': 'outlook',
  'live.fr': 'outlook',
  'live.com': 'outlook',
  'yahoo.fr': 'yahoo',
  'yahoo.com': 'yahoo',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'ovh.fr': 'ovh',
  'free.fr': 'free',
  'orange.fr': 'orange',
  'wanadoo.fr': 'orange',
};

const PROVIDER_NOTES = {
  gmail: 'Gmail exige un <strong>mot de passe d\'application</strong> : active la validation en 2 étapes, puis crée-le sur <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>. Les espaces du mot de passe sont ignorés.',
  outlook: 'Outlook/Microsoft 365 : après avoir activé la validation en 2 étapes, crée un <strong>mot de passe d\'application</strong> sur <a href="https://account.microsoft.com/security" target="_blank" rel="noreferrer">account.microsoft.com/security</a>.',
  custom: 'Le mot de passe est chiffré par Windows (DPAPI) et reste sur cette machine. Pour Gmail ou Outlook, utilise un mot de passe d\'application.',
};

const FOLDER_LABELS = {
  inbox: 'Boîte de réception',
  sent: 'Envoyés',
  drafts: 'Brouillons',
  junk: 'Indésirables',
  trash: 'Corbeille',
  archive: 'Archives',
};

const state = {
  accounts: [],
  activeId: null,
  folders: [],
  folder: 'INBOX',
  folderLabel: 'Boîte de réception',
  messages: [],
  selectedUid: null,
  current: null,
  info: null,
  offline: false,
  loading: false,
  search: '',
  lastError: '',
  radar: 'all',
  focus: false,
  snoozes: {},
  snoozeUid: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatFullDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function cleanError(value) {
  return String((value && value.message) || value || '')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

function authHelp(message) {
  const text = String(message || '');
  if (/gmail/i.test(text)) {
    return { url: 'https://myaccount.google.com/apppasswords', label: 'Créer un mot de passe d\'application Gmail' };
  }
  if (/outlook|microsoft 365/i.test(text)) {
    return { url: 'https://account.microsoft.com/security', label: 'Gérer la sécurité Microsoft' };
  }
  return null;
}

function setHelp(message) {
  const link = $('#list-empty-link');
  const help = authHelp(message);
  if (help) {
    link.href = help.url;
    link.textContent = help.label;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' Ko';
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' Mo';
}

function isNoise(message) {
  const from = String(message.fromAddress || '').toLowerCase();
  const subject = String(message.subject || '').toLowerCase();
  return /no-?reply|newsletter|notification|marketing|mailchimp|substack|linkedin|facebookmail|twitter|github|googlealerts|info@|news@|promo/.test(from)
    || /newsletter|infolettre|promotion|offre speciale|offre spéciale|soldes|black friday|webinar|desabonnement|désabonnement|unsubscribe/.test(subject);
}

function isInvoice(message) {
  return /facture|invoice|recu|reçu|receipt|paiement|payment|commande|order/.test(String(message.subject || '').toLowerCase());
}

function isUrgent(message) {
  return /urgent|important|action requise|a faire|à faire|asap|deadline|echeance|échéance|relance|rappel|rdv|rendez-vous|contrat|signature/.test(String(message.subject || '').toLowerCase());
}

function priorityScore(message) {
  let score = 0;
  if (message.unread) score += 2;
  if (isUrgent(message)) score += 3;
  if (isInvoice(message)) score += 2;
  if (!isNoise(message) && message.fromAddress) score += 1;
  const age = (Date.now() - new Date(message.date).getTime()) / 86400000;
  if (message.unread && age > 3) score += 1;
  return score;
}

const THEME_KEY = 'novamail.theme';
const SNOOZE_KEY = 'novamail.snoozes.v1';

function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  document.documentElement.style.colorScheme = light ? 'light' : 'dark';
  const button = $('#theme-toggle');
  if (button) button.textContent = light ? 'Thème sombre' : 'Thème clair';
}

function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* stockage indisponible */ }
  applyTheme(saved === 'light' ? 'light' : 'dark');
}

function toggleTheme() {
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* stockage indisponible */ }
  applyTheme(next);
}

function readSnoozes() {
  try {
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}') || {};
    const now = Date.now();
    Object.keys(raw).forEach((key) => { if (!(Number(raw[key]) > now)) delete raw[key]; });
    return raw;
  } catch { return {}; }
}

function saveSnoozes() {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(state.snoozes)); } catch { /* stockage indisponible */ }
}

function snoozeKey(uid) {
  return (state.activeId || 'local') + '|' + state.folder + '|' + uid;
}

function snoozeAt(message) { return Number(state.snoozes[snoozeKey(message.uid)] || 0); }
function isSnoozed(message) { return snoozeAt(message) > Date.now(); }

function purgeSnoozes(notify) {
  const now = Date.now();
  const due = [];
  Object.keys(state.snoozes).forEach((key) => {
    if (Number(state.snoozes[key]) > now) return;
    delete state.snoozes[key];
    due.push(key.split('|').pop());
  });
  if (!due.length) return 0;
  saveSnoozes();
  if (notify) {
    const found = state.messages.find((message) => due.includes(String(message.uid)));
    toast('Rappel : ' + (found ? found.subject || '(sans objet)' : 'message'), 'ok');
  }
  return due.length;
}

function openSnooze() {
  if (!state.selectedUid) return;
  state.snoozeUid = state.selectedUid;
  const message = state.current || state.messages.find((item) => item.uid === state.selectedUid);
  $('#snooze-subject').textContent = message ? message.subject || '(sans objet)' : '';
  $('#snooze-clear').hidden = !state.snoozes[snoozeKey(state.selectedUid)];
  $('#snooze-modal').hidden = false;
}

function closeSnooze() {
  $('#snooze-modal').hidden = true;
  state.snoozeUid = null;
}

function applySnooze(hours) {
  if (!state.snoozeUid) return;
  const key = snoozeKey(state.snoozeUid);
  if (hours) state.snoozes[key] = Date.now() + Number(hours) * 3600000;
  else delete state.snoozes[key];
  saveSnoozes();
  closeSnooze();
  closeReader();
  renderMessages();
  toast(hours ? 'Rappel programmé.' : 'Rappel annulé.', 'ok');
}

function radarCounts() {
  const active = state.messages.filter((message) => !isSnoozed(message));
  return {
    priority: active.filter((message) => priorityScore(message) >= 4).length,
    unread: active.filter((message) => message.unread).length,
    invoice: active.filter(isInvoice).length,
    noise: active.filter(isNoise).length,
    snoozed: state.messages.filter(isSnoozed).length,
  };
}

let toastTimer = null;
function toast(message, kind) {
  const bar = $('#status');
  bar.textContent = message;
  bar.className = 'status ' + (kind || '');
  bar.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    bar.hidden = true;
  }, 4200);
}

function setSync(text, offline) {
  const node = $('#sync-state');
  node.textContent = text;
  node.classList.toggle('offline', Boolean(offline));
}

/* ------------------------------------------------------------------ */
/* Comptes                                                             */
/* ------------------------------------------------------------------ */

function activeAccount() {
  return state.accounts.find((account) => account.id === state.activeId) || null;
}

async function loadAccounts() {
  const data = await api.accounts.list();
  state.accounts = data.accounts;
  state.activeId = data.activeId || (data.accounts[0] ? data.accounts[0].id : null);
  renderAccounts();
}

function renderAccounts() {
  const container = $('#accounts');
  if (!state.accounts.length) {
    container.innerHTML = '<p class="hint-block">Aucun compte pour le moment.</p>';
    return;
  }

  container.innerHTML = state.accounts
    .map((account) => {
      const active = account.id === state.activeId;
      const initials = (account.name || account.email).slice(0, 1).toUpperCase();
      return (
        '<button class="account' + (active ? ' active' : '') + '" data-account="' + account.id + '" type="button">' +
        '<span class="avatar" style="--dot:' + escapeHtml(account.color) + '">' + escapeHtml(initials) + '</span>' +
        '<span class="account-meta"><strong>' + escapeHtml(account.name) + '</strong><small>' + escapeHtml(account.email) + '</small></span>' +
        '</button>'
      );
    })
    .join('');

  $$('.account').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.account;
      if (id === state.activeId) {
        openAccountModal(state.accounts.find((account) => account.id === id));
        return;
      }
      await api.accounts.activate(id);
      state.activeId = id;
      state.messages = [];
      state.selectedUid = null;
      state.folder = 'INBOX';
      renderAccounts();
      closeReader();
      await refreshAll();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Dossiers et messages                                                */
/* ------------------------------------------------------------------ */

function defaultFolders() {
  return [
    { path: 'INBOX', name: 'Boîte de réception', special: 'inbox', unseen: 0, total: 0 },
    { path: 'Sent', name: 'Envoyés', special: 'sent', unseen: 0, total: 0 },
    { path: 'Drafts', name: 'Brouillons', special: 'drafts', unseen: 0, total: 0 },
    { path: 'Trash', name: 'Corbeille', special: 'trash', unseen: 0, total: 0 },
  ];
}

async function loadFolders() {
  if (!state.activeId) {
    state.folders = [];
    renderFolders();
    return;
  }

  try {
    const result = await api.mail.folders(state.activeId);
    state.folders = result.folders;
    state.offline = false;
    setSync('Synchronisé à ' + new Date(result.syncedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
  } catch (error) {
    state.folders = defaultFolders();
    state.offline = true;
    state.lastError = cleanError(error);
    setSync('Connexion impossible', true);
  }

  renderFolders();
}

function renderFolders() {
  const container = $('#folders');
  const items = state.folders.length ? state.folders : (state.activeId ? defaultFolders() : []);

  container.innerHTML = items
    .map((folder) => {
      const active = folder.path === state.folder;
      const label = FOLDER_LABELS[folder.special] || folder.name;
      const badge = folder.unseen ? '<span class="badge">' + folder.unseen + '</span>' : '';
      return (
        '<button class="folder' + (active ? ' active' : '') + '" data-folder="' + escapeHtml(folder.path) + '" type="button">' +
        '<span class="folder-name">' + escapeHtml(label) + '</span>' + badge +
        '</button>'
      );
    })
    .join('');

  $$('.folder').forEach((button) => {
    button.addEventListener('click', () => selectFolder(button.dataset.folder));
  });
}

async function selectFolder(path) {
  if (path === state.folder && state.messages.length) return;
  state.folder = path;
  const found = state.folders.find((folder) => folder.path === path);
  state.folderLabel = found ? (FOLDER_LABELS[found.special] || found.name) : path;
  $('#folder-title').textContent = state.folderLabel;
  closeReader();
  renderFolders();
  await loadMessages();
}

async function loadMessages() {
  if (!state.activeId) return;

  state.loading = true;
  const loader = $('#list-loader');
  if (loader && !state.messages.length) loader.hidden = false;

  // Afficher le cache immediatement pour un affichage instantane.
  try {
    const cached = await api.mail.cache(state.activeId, state.folder);
    if (cached && Array.isArray(cached.messages) && cached.messages.length) {
      state.messages = cached.messages;
      state.offline = true;
      state.lastError = '';
      renderMessages();
      setSync('Cache · ' + cached.messages.length + ' message' + (cached.messages.length > 1 ? 's' : ''), true);
      if (loader) loader.hidden = true;
    }
  } catch {
    /* cache indisponible */
  }

  setSync(state.messages.length ? 'Synchronisation…' : 'Chargement…');

  try {
    const result = await api.mail.list(state.activeId, state.folder, 60);
    state.messages = result.messages;
    purgeSnoozes(true);
    state.offline = Boolean(result.offline);
    state.lastError = result.offline ? cleanError(result.error) : '';

    if (result.offline) {
      setSync('Hors ligne · cache du ' + formatDate(result.syncedAt), true);
    } else {
      setSync(result.total + ' message' + (result.total > 1 ? 's' : '') + ' · ' + formatDate(result.syncedAt));
    }
    renderMessages();
    setHelp(state.lastError);
  } catch (error) {
    if (!state.messages.length) {
      state.messages = [];
      state.lastError = cleanError(error);
      renderMessages();
      setSync('Connexion impossible', true);
      setHelp(state.lastError);
    } else {
      setSync('Hors ligne · cache', true);
    }
  } finally {
    state.loading = false;
    if (loader) loader.hidden = true;
  }
}

function visibleMessages() {
  let items = state.radar === 'snoozed'
    ? state.messages.filter(isSnoozed)
    : state.messages.filter((message) => !isSnoozed(message));
  if (state.radar === 'priority') items = items.filter((message) => priorityScore(message) >= 4);
  else if (state.radar === 'unread') items = items.filter((message) => message.unread);
  else if (state.radar === 'invoice') items = items.filter(isInvoice);
  else if (state.radar === 'noise') items = items.filter(isNoise);
  if (state.focus) items = items.filter((message) => !isNoise(message));
  const term = state.search.trim().toLowerCase();
  if (!term) return items;
  return items.filter((message) => {
    return (
      String(message.subject || '').toLowerCase().includes(term) ||
      String(message.fromName || '').toLowerCase().includes(term) ||
      String(message.fromAddress || '').toLowerCase().includes(term)
    );
  });
}

function renderMessages() {
  const list = $('#messages');
  const empty = $('#list-empty');
  renderRadar();
  const items = visibleMessages();

  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    const failed = !state.search && Boolean(state.lastError);
    $('#list-retry').hidden = !failed;
    $('#list-empty-title').textContent = state.search ? 'Aucun résultat' : (failed ? 'Connexion impossible' : 'Aucun message');
    $('#list-empty-text').textContent = state.search
      ? 'Essaie un autre mot-clé.'
      : (failed ? state.lastError : (state.activeId ? 'Ce dossier est vide ou hors ligne.' : 'Ajoute un compte pour commencer.'));
    return;
  }

  empty.hidden = true;
  list.innerHTML = items
    .map((message) => {
      const active = message.uid === state.selectedUid;
      const who = message.fromName || message.fromAddress || 'Inconnu';
      const hot = priorityScore(message) >= 4 ? ' hot' : '';
      return (
        '<li><button class="message' + (active ? ' active' : '') + (message.unread ? ' unread' : '') + hot + '" data-uid="' + message.uid + '" type="button">' +
        '<span class="message-top"><span class="who">' + escapeHtml(who) + '</span><span class="when">' + escapeHtml(formatDate(message.date)) + '</span></span>' +
        '<span class="subject">' + (isSnoozed(message) ? '<span class="star">⏰</span> ' : '') + (message.flagged ? '<span class="star">★</span> ' : '') + escapeHtml(message.subject || '(sans objet)') + '</span>' +
        '<span class="preview">' + escapeHtml(formatSize(message.size)) + (message.flagged ? ' · Important' : '') + '</span>' +
        '</button></li>'
      );
    })
    .join('');

  $$('.message').forEach((button) => {
    button.addEventListener('click', () => openMessage(Number(button.dataset.uid)));
  });
}

function renderRadar() {
  const radar = $('#radar');
  if (!radar) return;
  const counts = radarCounts();
  const chip = (key, label, count) =>
    '<button class="radar-chip' + (state.radar === key ? ' active' : '') + '" data-radar="' + key + '" type="button">' +
    label + ' <span>' + count + '</span></button>';

  if (state.radar === 'snoozed' && !counts.snoozed) state.radar = 'all';
  radar.innerHTML = '<span class="radar-label">Nova Radar</span>' +
    chip('priority', 'Priorité', counts.priority) +
    chip('unread', 'Non lus', counts.unread) +
    chip('invoice', 'Factures', counts.invoice) +
    chip('noise', 'Bruit', counts.noise) +
    (counts.snoozed ? chip('snoozed', 'Rappels', counts.snoozed) : '') +
    '<button class="radar-chip' + (state.focus ? ' active' : '') + '" data-focus="1" type="button">Focus</button>';
  radar.hidden = !state.messages.length;

  $$('[data-radar]').forEach((button) => {
    button.addEventListener('click', () => {
      state.radar = state.radar === button.dataset.radar ? 'all' : button.dataset.radar;
      renderMessages();
    });
  });
  const focus = radar.querySelector('[data-focus]');
  if (focus) {
    focus.addEventListener('click', () => {
      state.focus = !state.focus;
      if (state.focus && state.radar === 'noise') state.radar = 'all';
      renderMessages();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, link, meta, form, input, button').forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'srcset' || name === 'color' || name === 'bgcolor') {
        node.removeAttribute(attribute.name);
      }
      if (name === 'style') {
        const cleaned = String(attribute.value || '')
          .split(';')
          .map((part) => part.trim())
          .filter((part) => part && !/^(color|background(-color)?|background)$/i.test(part.split(':')[0].trim()))
          .join('; ');
        if (cleaned) node.setAttribute('style', cleaned);
        else node.removeAttribute('style');
      }
    });
  });
  return doc.body ? doc.body.innerHTML : '';
}

function closeReader() {
  state.selectedUid = null;
  state.current = null;
  $('#reader-doc').hidden = true;
  $('#reader-empty').hidden = false;
  renderMessages();
}

function detectIntent(message, text) {
  const hay = String((message.subject || '') + ' ' + (text || '')).toLowerCase();
  if (/facture|invoice|paiement|payment|montant|€|euros/.test(hay)) {
    return {
      label: 'Paiement / facture',
      replies: ['Je règle cela aujourd’hui.', 'Pouvez-vous renvoyer la facture ?', 'C’est déjà réglé de mon côté.'],
    };
  }
  if (/réunion|reunion|rendez-vous|rdv|meeting|invitation|agenda|créneau|creneau/.test(hay)) {
    return {
      label: 'Rendez-vous',
      replies: ['Je confirme ma présence.', 'Je ne suis pas disponible, pouvez-vous proposer un autre créneau ?', 'Merci, c’est noté.'],
    };
  }
  if (/\?/.test(String(message.subject || '')) || /(peux-tu|pouvez-vous|confirmez|validez|réponds|reponds|dis-moi)/.test(hay)) {
    return {
      label: 'Question / action attendue',
      replies: ['Oui, c’est noté.', 'Non, pas pour le moment.', 'Je reviens vers vous rapidement.'],
    };
  }
  if (/merci|thanks|remerci/.test(hay)) {
    return {
      label: 'Remerciement',
      replies: ['Avec plaisir !', 'Merci à vous.', 'Bien reçu, merci.'],
    };
  }
  return {
    label: 'Réponse simple',
    replies: ['Bien reçu, merci.', 'Je regarde et je reviens vers vous.', 'Merci pour votre message.'],
  };
}

function extractActions(text) {
  const source = String(text || '');
  const found = [];
  const add = (label, values) => {
    [...new Set(values || [])].slice(0, 3).forEach((value) => found.push(label + ' : ' + value.trim()));
  };
  add('Date', source.match(/\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|aujourd’hui|apres-demain|après-demain)\b|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/gi));
  add('Montant', source.match(/\b\d[\d\s.,]{0,12}\s?(?:€|EUR|euros?)(?=\s|$|[.,;:)])/gi));
  add('Suivi', source.match(/\b(?:[A-Z]{2}\d{9}[A-Z]{2}|1Z[0-9A-Z]{16})\b/g));
  add('Téléphone', source.match(/\b0[1-9](?:[ .-]?\d{2}){4}\b/g));
  add('Lien', source.match(/https?:\/\/[^\s<>"']+/g));
  return found.slice(0, 8);
}

function priorityReasons(message) {
  const reasons = [];
  if (message.unread) reasons.push('non lu');
  if (isUrgent(message)) reasons.push('mot-clé urgent');
  if (isInvoice(message)) reasons.push('facture / paiement');
  if (!isNoise(message) && message.fromAddress) reasons.push('expéditeur direct');
  return reasons;
}

function renderAssistant(message) {
  const box = $('#assistant');
  if (!box) return;
  const text = String(message.text || $('#reader-body').innerText || '').replace(/\s+/g, ' ').trim();
  if (!text && !message.subject) {
    box.hidden = true;
    return;
  }

  const intent = detectIntent(message, text);
  const actions = extractActions(text);
  const reasons = priorityReasons(message);
  const suggestions = intent.replies
    .map((reply) => '<button class="suggestion" data-reply="' + escapeHtml(reply) + '" type="button">' + escapeHtml(reply) + '</button>')
    .join('');
  const actionsHtml = actions.map((action) => '<span class="action-chip">' + escapeHtml(action) + '</span>').join('');

  box.innerHTML = '<div class="assistant-head"><span class="assistant-title">Nova AI</span><span class="assistant-tag">local</span></div>' +
    '<p class="assistant-intent">Intention : <strong>' + escapeHtml(intent.label) + '</strong></p>' +
    '<div class="assistant-suggestions">' + suggestions + '</div>' +
    (actionsHtml ? '<div class="assistant-actions">' + actionsHtml + '</div>' : '') +
    (reasons.length ? '<p class="assistant-reason">Priorité : ' + escapeHtml(reasons.join(' · ')) + '</p>' : '');
  box.hidden = false;

  box.querySelectorAll('[data-reply]').forEach((button) => {
    button.addEventListener('click', () => {
      const subject = /^re:/i.test(message.subject || '') ? message.subject : 'Re: ' + (message.subject || '');
      state.composeReply = { messageId: message.messageId, references: message.references };
      openCompose({ to: addressOf(message.from), subject, text: button.dataset.reply }, 'Réponse suggérée');
    });
  });
}

function buildSummary(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 160) return '';
  const sentences = clean.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter((item) => item.length >= 40 && item.length <= 280);
  if (sentences.length < 3) return '';
  const words = clean.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || [];
  const frequency = new Map();
  words.forEach((word) => frequency.set(word, (frequency.get(word) || 0) + 1));
  const scored = sentences.map((sentence, index) => {
    const tokens = sentence.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || [];
    const score = tokens.reduce((total, token) => total + (frequency.get(token) || 0), 0) / Math.sqrt(tokens.length + 1);
    return { sentence, score, index };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.index - b.index).map((item) => item.sentence).join(' ');
}

function renderSummary(message) {
  const body = $('#reader-body');
  const previous = body.querySelector('.summary');
  if (previous) previous.remove();
  const text = buildSummary(message.text || body.innerText || '');
  if (!text) return;
  const box = document.createElement('div');
  box.className = 'summary';
  box.innerHTML = '<strong>Résumé express</strong><p>' + escapeHtml(text) + '</p>';
  body.prepend(box);
}

async function openMessage(uid) {
  const summary = state.messages.find((message) => message.uid === uid);
  if (!summary) return;

  state.selectedUid = uid;
  renderMessages();
  $('#reader-empty').hidden = true;
  $('#reader-doc').hidden = false;
  $('#reader-subject').textContent = summary.subject || '(sans objet)';
  $('#reader-from').textContent = summary.fromName ? summary.fromName + ' <' + summary.fromAddress + '>' : summary.fromAddress;
  $('#reader-date').textContent = formatFullDate(summary.date);
  $('#reader-body').innerHTML = '<div class="loading"><img src="../build/icon.png" alt="" width="40" height="40"><span class="spinner"></span><p>Chargement du message…</p></div>';
  $('#assistant').hidden = true;
  $('#attachments').hidden = true;
  const flagButton = $('#toggle-flag');
  flagButton.textContent = summary.flagged ? 'Retirer important' : 'Important';
  $('#snooze').textContent = state.snoozes[snoozeKey(uid)] ? 'Modifier le rappel' : 'Rappel';

  try {
    const message = await api.mail.get(state.activeId, state.folder, uid);
    state.current = message;

    $('#reader-subject').textContent = message.subject || '(sans objet)';
    $('#reader-from').textContent = message.from || summary.fromAddress;
    $('#reader-date').textContent = formatFullDate(message.date);

    if (message.html) {
      $('#reader-body').innerHTML = '<div class="mail-html">' + sanitizeHtml(message.html) + '</div>';
    } else {
      $('#reader-body').innerHTML = '<pre class="mail-text">' + escapeHtml(message.text || '(message vide)') + '</pre>';
    }

    if (message.attachments && message.attachments.length) {
      const box = $('#attachments');
      box.hidden = false;
      box.innerHTML =
        '<h3>Pièces jointes (' + message.attachments.length + ')</h3>' +
        message.attachments
          .map((file, index) =>
            '<button class="attachment" type="button" data-index="' + index + '">' +
            escapeHtml(file.filename) + ' · ' + escapeHtml(formatSize(file.size)) +
            '</button>',
          )
          .join('');

      box.querySelectorAll('.attachment').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            const result = await api.mail.saveAttachment(state.activeId, state.folder, uid, Number(button.dataset.index));
            if (result && result.saved) toast('Pièce jointe enregistrée : ' + result.path, 'ok');
          } catch (error) {
            toast(cleanError(error), 'error');
          }
        });
      });
    }

    renderSummary(message);
    renderAssistant(message);

    if (summary.unread) {
      summary.unread = false;
      renderMessages();
      api.mail.flags(state.activeId, state.folder, uid, true).catch(() => {});
    }
  } catch (error) {
    $('#reader-body').innerHTML = '<p class="empty-text">' + escapeHtml(cleanError(error)) + '</p>';
  }
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

function textToHtml(value) {
  return escapeHtml(String(value || '')).replace(/\n/g, '<br>');
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ''));
}

function sanitizeComposeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const allowed = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'A', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'SPAN', 'BLOCKQUOTE']);
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, input, button, img, svg').forEach((node) => node.remove());
  [...doc.body.querySelectorAll('*')].forEach((node) => {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(doc.createTextNode(node.textContent || ''));
      return;
    }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (node.tagName === 'A' && name === 'href') {
        const value = String(attribute.value || '').trim();
        if (!/^(https?:|mailto:|tel:)/i.test(value)) node.removeAttribute('href');
        else {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (!(node.tagName === 'A' && (name === 'target' || name === 'rel'))) {
        node.removeAttribute(attribute.name);
      }
    });
    if (node.tagName === 'A' && !node.getAttribute('href')) node.replaceWith(...node.childNodes);
  });
  return doc.body ? doc.body.innerHTML : '';
}

function insertLink(editor) {
  if (!editor) return;
  const value = window.prompt('Adresse du lien (https://, mailto: ou tel:)', 'https://');
  if (!value) return;
  const url = value.trim();
  if (!/^(https?:|mailto:|tel:)/i.test(url)) {
    toast('Lien invalide : utilise https://, mailto: ou tel:', 'error');
    return;
  }
  editor.focus();
  const selection = window.getSelection();
  const selected = selection && selection.rangeCount > 0 && !selection.isCollapsed;
  if (selected) document.execCommand('createLink', false, url);
  else document.execCommand('insertHTML', false, '<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>');
}

function bindEditorToolbar(toolbar) {
  const editor = document.getElementById(toolbar.dataset.editor);
  if (!editor) return;
  toolbar.querySelectorAll('button').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      editor.focus();
      if (button.dataset.link) {
        insertLink(editor);
        return;
      }
      if (button.dataset.cmd) document.execCommand(button.dataset.cmd, false, null);
    });
  });
}

function signatureToHtml(value) {
  if (!value) return '';
  return looksLikeHtml(value) ? sanitizeComposeHtml(value) : textToHtml(value);
}

function openCompose(preset, title) {
  const modal = $('#compose-modal');
  const form = $('#compose-form');
  const editor = $('#compose-editor');
  form.reset();
  $('#compose-error').hidden = true;
  const heading = $('#compose-title');
  if (heading) heading.textContent = title || 'Nouveau message';
  form.elements.to.value = (preset && preset.to) || '';
  form.elements.cc.value = (preset && preset.cc) || '';
  form.elements.subject.value = (preset && preset.subject) || '';

  const account = activeAccount();
  const signature = signatureToHtml(account && account.signature);
  const base = textToHtml((preset && preset.text) || '');
  editor.innerHTML = base + (signature ? (base ? '<br><br>' : '') + '--<br>' + signature : '');
  modal.hidden = false;
  setTimeout(() => (preset && preset.to ? editor : form.elements.to).focus(), 30);
}

function closeCompose() {
  $('#compose-modal').hidden = true;
}

async function sendMessage(event) {
  event.preventDefault();
  const form = $('#compose-form');
  const error = $('#compose-error');
  const button = $('#send-btn');
  error.hidden = true;

  if (!state.activeId) {
    toast('Ajoute d\'abord un compte.', 'error');
    return;
  }

  const editor = $('#compose-editor');
  const text = String(editor.innerText || '').replace(/ /g, ' ').trim();
  const html = sanitizeComposeHtml(editor.innerHTML);
  if (!text && !html.replace(/<[^>]*>/g, '').trim()) {
    error.textContent = 'Écris un message avant d’envoyer.';
    error.hidden = false;
    return;
  }

  const payload = {
    accountId: state.activeId,
    to: form.elements.to.value.trim(),
    cc: form.elements.cc.value.trim(),
    subject: form.elements.subject.value.trim(),
    text,
    html,
    inReplyTo: state.composeReply ? state.composeReply.messageId : '',
    references: state.composeReply ? state.composeReply.references : '',
  };

  button.disabled = true;
  button.textContent = 'Envoi…';
  try {
    await api.mail.send(payload);
    closeCompose();
    toast('Message envoyé.', 'ok');
    state.composeReply = null;
    if (/sent/i.test(state.folder)) await loadMessages();
  } catch (err) {
    error.textContent = cleanError(err);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Envoyer';
  }
}

function addressOf(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim();
}

function splitAddresses(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function replyTo(all) {
  const message = state.current;
  if (!message) return;
  const account = activeAccount();
  const own = String((account && account.email) || '').toLowerCase();
  const sender = addressOf(message.from);
  const to = sender ? [sender] : [];
  const cc = [];

  if (all) {
    splitAddresses(message.to).forEach((item) => {
      const address = addressOf(item);
      if (address && address.toLowerCase() !== own && !to.includes(address)) to.push(address);
    });
    splitAddresses(message.cc).forEach((item) => {
      const address = addressOf(item);
      if (address && address.toLowerCase() !== own && !to.includes(address) && !cc.includes(address)) cc.push(address);
    });
  }

  const subject = /^re:/i.test(message.subject || '') ? message.subject : 'Re: ' + (message.subject || '');
  const quoted = String(message.text || '')
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');

  state.composeReply = { messageId: message.messageId, references: message.references };
  openCompose(
    { to: to.join(', '), cc: cc.join(', '), subject, text: '\n\n--- Message d\'origine ---\n' + quoted },
    all ? 'Répondre à tous' : 'Répondre',
  );
}

function forwardMessage() {
  const message = state.current;
  if (!message) return;
  const subject = /^fwd?:/i.test(message.subject || '') ? message.subject : 'Fwd: ' + (message.subject || '');
  const header = '--- Message transféré ---\nDe : ' + (message.from || '') +
    '\nDate : ' + (message.date ? formatFullDate(message.date) : '') +
    '\nObjet : ' + (message.subject || '') + '\n\n';
  state.composeReply = null;
  openCompose({ subject, text: '\n\n' + header + (message.text || '') }, 'Transférer');
}

async function deleteCurrent() {
  if (!state.activeId || !state.selectedUid) return;
  const folder = state.folders.find((item) => item.path === state.folder);
  const inTrash = Boolean(folder && folder.special === 'trash');
  const hasTrash = state.folders.some((item) => item.special === 'trash' && item.path !== state.folder);
  if (!window.confirm(inTrash || !hasTrash ? 'Supprimer définitivement ce message ?' : 'Déplacer ce message dans la corbeille ?')) return;
  try {
    await api.mail.delete(state.activeId, state.folder, state.selectedUid);
    closeReader();
    toast(inTrash ? 'Message supprimé.' : 'Message déplacé dans la corbeille.', 'ok');
    await refreshAll();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}


async function markAllRead() {
  if (!state.activeId || !state.messages.length) return;
  try {
    const result = await api.mail.markAllRead(state.activeId, state.folder);
    state.messages.forEach((message) => { message.unread = false; });
    renderMessages();
    loadFolders();
    toast('Messages marqués comme lus' + (result.count ? ' (' + result.count + ')' : '') + '.', 'ok');
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Modale de compte                                                    */
/* ------------------------------------------------------------------ */

let editingId = null;

function fillPreset(name) {
  const form = $('#account-form');
  const preset = PRESETS[name];
  if (!preset) return;
  form.elements.imaphost.value = preset.imap.host;
  form.elements.imapport.value = preset.imap.port;
  form.elements.imapsecure.checked = preset.imap.secure;
  form.elements.smtphost.value = preset.smtp.host;
  form.elements.smtpport.value = preset.smtp.port;
  form.elements.smtpsecure.checked = preset.smtp.secure;
}

function updateAccountNote(presetName) {
  const note = $('#account-note');
  if (!note) return;
  note.innerHTML = PROVIDER_NOTES[presetName] || PROVIDER_NOTES.custom;
}

function openAccountModal(account) {
  editingId = account ? account.id : null;
  const form = $('#account-form');
  form.reset();
  $('#account-error').hidden = true;
  $('#account-ok').hidden = true;
  $('#delete-account').hidden = !account;
  document.querySelector('#account-modal h2').textContent = 'Paramètres';
  const domain = (account ? String(account.email).split('@')[1] : '') || '';
  const presetName = DOMAIN_PRESETS[domain.toLowerCase()] || 'custom';
  updateAccountNote(presetName);
  const heading = $('#settings-sub');
  if (heading) heading.textContent = account ? 'Compte ' + account.email : 'Nouveau compte';
  const maintenance = $('#maintenance-section');
  if (maintenance) maintenance.hidden = !account;

  $('#signature-editor').innerHTML = '';
  form.elements.signature.value = '';

  if (account) {
    form.elements.name.value = account.name || '';
    form.elements.email.value = account.email || '';
    form.elements.imaphost.value = account.imap.host;
    form.elements.imapport.value = account.imap.port;
    form.elements.imapsecure.checked = account.imap.secure;
    form.elements.smtphost.value = account.smtp.host;
    form.elements.smtpport.value = account.smtp.port;
    form.elements.smtpsecure.checked = account.smtp.secure;
    const signatureEditor = $('#signature-editor');
    signatureEditor.innerHTML = signatureToHtml(account.signature || '');
    form.elements.signature.value = signatureEditor.innerHTML;
    form.elements.password.placeholder = account.hasPassword ? 'mot de passe enregistré (laisser vide pour garder)' : 'mot de passe';
    form.elements.preset.value = presetName;
  }

  $('#account-modal').hidden = false;
  setTimeout(() => form.elements.email.focus(), 30);
}

function closeAccountModal() {
  $('#account-modal').hidden = true;
  editingId = null;
}

function accountPayload() {
  const form = $('#account-form');
  return {
    id: editingId || undefined,
    name: form.elements.name.value.trim(),
    email: form.elements.email.value.trim(),
    imap: {
      host: form.elements.imaphost.value.trim(),
      port: Number(form.elements.imapport.value),
      secure: form.elements.imapsecure.checked,
    },
    smtp: {
      host: form.elements.smtphost.value.trim(),
      port: Number(form.elements.smtpport.value),
      secure: form.elements.smtpsecure.checked,
    },
    password: form.elements.password.value,
    signature: sanitizeComposeHtml($('#signature-editor').innerHTML),
  };
}

async function saveAccount(event) {
  event.preventDefault();
  const error = $('#account-error');
  const ok = $('#account-ok');
  error.hidden = true;
  ok.hidden = true;

  if (!editingId && !$('#account-form').elements.password.value) {
    error.textContent = 'Saisis ton mot de passe (ou un mot de passe d\'application).';
    error.hidden = false;
    return;
  }

  try {
    const result = await api.accounts.save(accountPayload());
    state.activeId = result.activeId || result.account.id;
    closeAccountModal();
    await loadAccounts();
    state.folder = 'INBOX';
    closeReader();
    await refreshAll();
    toast('Compte enregistré.', 'ok');
  } catch (err) {
    error.textContent = cleanError(err);
    error.hidden = false;
  }
}

async function testAccount() {
  const error = $('#account-error');
  const ok = $('#account-ok');
  const button = $('#test-account');
  error.hidden = true;
  ok.hidden = true;
  button.disabled = true;
  button.textContent = 'Test…';

  try {
    const result = await api.accounts.test(accountPayload());
    const lines = [];
    lines.push(result.imap ? 'IMAP : connexion réussie' : 'IMAP : échec');
    lines.push(result.smtp ? 'SMTP : connexion réussie' : 'SMTP : échec');
    if (result.errors && result.errors.length) lines.push(result.errors.join(' '));

    if (result.imap && result.smtp) {
      ok.textContent = lines.slice(0, 2).join(' · ');
      ok.hidden = false;
    } else {
      error.textContent = lines.join(' — ');
      error.hidden = false;
    }
  } catch (err) {
    error.textContent = cleanError(err);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Tester';
  }
}

async function deleteAccount() {
  if (!editingId) return;
  const account = state.accounts.find((item) => item.id === editingId);
  if (!window.confirm('Supprimer le compte ' + (account ? account.email : '') + ' et son cache local ?')) return;

  await api.accounts.remove(editingId);
  closeAccountModal();
  await loadAccounts();
  closeReader();
  await refreshAll();
  toast('Compte supprimé.', 'ok');
}

/* ------------------------------------------------------------------ */
/* Initialisation                                                      */
/* ------------------------------------------------------------------ */

async function refreshAll() {
  await loadFolders();
  const exists = state.folders.some((folder) => folder.path === state.folder);
  if (!exists) {
    state.folder = state.folders.find((folder) => folder.special === 'inbox')?.path || 'INBOX';
  }
  await loadMessages();
}

function bindEvents() {
  $('#compose').addEventListener('click', () => openCompose());
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#settings').addEventListener('click', () => openAccountModal(activeAccount()));
  const openNovaMail = $('#open-novamail');
  if (openNovaMail) openNovaMail.addEventListener('click', () => api.app.openNovaMail().catch(() => {}));
  $('#refresh').addEventListener('click', () => refreshAll());
  $('#list-retry').addEventListener('click', () => refreshAll());
  $('#read-all').addEventListener('click', markAllRead);
  $('#reply').addEventListener('click', () => replyTo(false));
  $('#reply-all').addEventListener('click', () => replyTo(true));
  $('#forward').addEventListener('click', forwardMessage);
  $('#print').addEventListener('click', () => window.print());
  $('#snooze').addEventListener('click', openSnooze);
  $('#snooze-modal').querySelector('[data-close]').addEventListener('click', closeSnooze);
  $('#snooze-clear').addEventListener('click', () => applySnooze(0));
  $$('#snooze-modal [data-hours]').forEach((button) => {
    button.addEventListener('click', () => applySnooze(Number(button.dataset.hours)));
  });
  $('#delete').addEventListener('click', deleteCurrent);
  $('#toggle-flag').addEventListener('click', async () => {
    if (!state.selectedUid) return;
    const summary = state.messages.find((message) => message.uid === state.selectedUid);
    if (!summary) return;
    const next = !summary.flagged;
    try {
      await api.mail.flag(state.activeId, state.folder, state.selectedUid, next);
      summary.flagged = next;
      $('#toggle-flag').textContent = next ? 'Retirer important' : 'Important';
      renderMessages();
      toast(next ? 'Marqué comme important.' : 'Important retiré.', 'ok');
    } catch (error) {
      toast(cleanError(error), 'error');
    }
  });
  $('#toggle-unread').addEventListener('click', async () => {
    if (!state.selectedUid) return;
    await api.mail.flags(state.activeId, state.folder, state.selectedUid, false).catch(() => {});
    const summary = state.messages.find((message) => message.uid === state.selectedUid);
    if (summary) summary.unread = true;
    renderMessages();
    toast('Marqué comme non lu.');
  });

  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderMessages();
  });

  $('#compose-form').addEventListener('submit', sendMessage);
  document.querySelectorAll('.editor-toolbar').forEach(bindEditorToolbar);
  $('#signature-editor').addEventListener('input', () => {
    $('#account-form').elements.signature.value = sanitizeComposeHtml($('#signature-editor').innerHTML);
  });
  $('#compose-editor').addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      $('#compose-form').requestSubmit();
    }
  });
  $('#account-form').addEventListener('submit', saveAccount);
  $('#test-account').addEventListener('click', testAccount);
  $('#delete-account').addEventListener('click', deleteAccount);
  $('#toggle-password').addEventListener('click', () => {
    const input = $('#account-form').elements.password;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggle-password').textContent = show ? 'Masquer' : 'Afficher';
  });
  $('#clear-cache').addEventListener('click', async () => {
    if (!editingId) return;
    if (!window.confirm('Vider le cache local de ce compte ?')) return;
    await api.app.clearCache(editingId);
    toast('Cache local vidé.', 'ok');
  });
  $('#preset').addEventListener('change', (event) => {
    fillPreset(event.target.value);
    updateAccountNote(event.target.value);
  });

  $('#account-form').elements.email.addEventListener('blur', (event) => {
    const domain = String(event.target.value).split('@')[1] || '';
    const preset = DOMAIN_PRESETS[domain.toLowerCase()];
    const select = $('#preset');
    if (preset && select.value === 'custom') {
      select.value = preset;
      fillPreset(preset);
      updateAccountNote(preset);
    }
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      closeCompose();
      closeAccountModal();
    });
  });

  $$('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeCompose();
        closeAccountModal();
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeCompose();
      closeAccountModal();
    }
    const typing = /input|textarea|select/i.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (!typing && event.key === 'c') {
      event.preventDefault();
      openCompose();
    }
    if (!typing && event.key === 'r' && state.current) {
      event.preventDefault();
      replyTo(false);
    }
    if (event.key === 'F5') {
      event.preventDefault();
      refreshAll();
    }
  });
}

async function init() {
  initTheme();
  state.snoozes = readSnoozes();
  bindEvents();
  state.info = await api.app.info();
  $('#version').textContent = 'v' + state.info.version;
  await loadAccounts();

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('e2e');
  if (mode === '1') {
    await runE2E();
    return;
  }
  if (mode === 'sync') {
    await runSyncCheck();
    return;
  }

  if (!state.accounts.length) {
    openAccountModal(null);
    renderFolders();
    renderMessages();
    setSync('Ajoute un compte pour recevoir tes messages');
    return;
  }

  await refreshAll();

  setInterval(() => {
    if (purgeSnoozes(true)) renderMessages();
  }, 30000);

  // Rafraichissement automatique pour un affichage a jour.
  setInterval(() => {
    if (state.activeId && !state.loading) refreshAll();
  }, 60000);
  window.addEventListener('focus', () => {
    if (state.activeId && !state.loading) refreshAll();
  });
}

/* ------------------------------------------------------------------ */
/* Vérification automatique                                            */
/* ------------------------------------------------------------------ */

async function runE2E() {
  const checks = [];
  const check = (name, condition, detail) => {
    checks.push({ name, ok: Boolean(condition), detail: detail === undefined ? '' : String(detail) });
  };

  try {
    check('brand', $('.brand').textContent.includes('NovaMail'));
    check('icône chargée', $('.brand img').naturalWidth > 0, $('.brand img').naturalWidth + 'px');
    check('accent', getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#ff8c42');
    check('version', /^v\d+\.\d+\.\d+$/.test($('#version').textContent), $('#version').textContent);

    $('#compose').click();
    check('composition ouverte', !$('#compose-modal').hidden);
    $('#compose-modal').querySelector('[data-close]').click();
    check('composition fermée', $('#compose-modal').hidden);

    $('#settings').click();
    check('réglages ouverts', !$('#account-modal').hidden);
    check('champs IMAP', $('#account-form').elements.imaphost !== undefined);

    $('#account-form').elements.email.value = 'pas-un-email';
    $('#account-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    check('validation e-mail', !$('#account-error').hidden, $('#account-error').textContent);

    const saved = await api.accounts.save({
      email: 'test@novamail.local',
      name: 'Test',
      imap: { host: 'imap.exemple.fr', port: 993, secure: true },
      smtp: { host: 'smtp.exemple.fr', port: 465, secure: true },
      password: 'secret-test',
      signature: 'NovaMail',
    });
    check('compte enregistré', Boolean(saved.account && saved.account.id), saved.account && saved.account.email);
    check('mot de passe masqué', saved.account.hasPassword === true && !('secret' in saved.account));

    const listing = await api.accounts.list();
    check('compte listé', listing.accounts.some((account) => account.email === 'test@novamail.local'));

    await api.accounts.remove(saved.account.id);
    const after = await api.accounts.list();
    check('compte supprimé', !after.accounts.some((account) => account.email === 'test@novamail.local'));

    const info = await api.app.info();
    check('données locales', Boolean(info.dataDir), info.dataDir);

    try {
      const probe = await api.accounts.test({
        email: 'novamail.test.inexistant@gmail.com',
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
        password: 'mot-de-passe-faux',
      });
      const joined = (probe.errors || []).join(' ');
      check('erreur Gmail expliquée', /mot de passe d'application/i.test(joined), joined.slice(0, 140));
    } catch (error) {
      check('erreur Gmail expliquée', false, cleanError(error).slice(0, 140));
    }
  } catch (error) {
    checks.push({ name: 'exception', ok: false, detail: String(error && error.message ? error.message : error) });
  }

  const report = {
    ok: checks.every((entry) => entry.ok),
    checks,
    at: new Date().toISOString(),
  };

  await api.app.e2e(report);
}

async function runSyncCheck() {
  const checks = [];
  try {
    await refreshAll();
    checks.push({
      name: 'sync',
      ok: state.messages.length > 0 && !state.lastError,
      detail: 'messages=' + state.messages.length + ' | dossiers=' + state.folders.length + ' | erreur=' + (state.lastError || 'aucune'),
    });

    if (state.messages[0]) {
      const message = await api.mail.get(state.activeId, state.folder, state.messages[0].uid);
      checks.push({
        name: 'lecture',
        ok: Boolean(message.text || message.html),
        detail: 'caracteres=' + String(message.html || message.text || '').length,
      });
    }
  } catch (error) {
    checks.push({ name: 'sync', ok: false, detail: cleanError(error) });
  }

  await api.app.e2e({ ok: checks.every((entry) => entry.ok), checks, at: new Date().toISOString() });
}

init();

'use strict';

const PRESETS = {
  gmail: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  yahoo: { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
  icloud: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  ovh: { imap: { host: 'ssl0.ovh.net', port: 993, secure: true }, smtp: { host: 'ssl0.ovh.net', port: 465, secure: true } },
  free: { imap: { host: 'imap.free.fr', port: 993, secure: true }, smtp: { host: 'smtp.free.fr', port: 465, secure: true } },
  orange: { imap: { host: 'imap.orange.fr', port: 993, secure: true }, smtp: { host: 'smtp.orange.fr', port: 465, secure: true } },
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
  account: null,
  folders: [],
  box: 'INBOX',
  messages: [],
  selectedUid: null,
  current: null,
  search: '',
  reply: null,
  radar: 'all',
  focus: false,
  snoozes: {},
  snoozeUid: null,
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options) {
  const settings = Object.assign({ credentials: 'same-origin', headers: { 'content-type': 'application/json' } }, options || {});
  const response = await fetch(path, settings);
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* réponse vide */
  }
  if (!response.ok) throw new Error(data.error || 'Erreur ' + response.status);
  return data;
}

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
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/* Nova Radar : tri local, sans cloud */
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
  if (button) {
    button.setAttribute('aria-label', light ? 'Thème sombre' : 'Thème clair');
    button.setAttribute('title', light ? 'Thème sombre' : 'Thème clair');
  }
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
  const account = state.account && state.account.email ? state.account.email : 'local';
  return account + '|' + state.box + '|' + uid;
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
  const message = state.current || state.messages.find((item) => String(item.uid) === String(state.selectedUid));
  $('#snooze-subject').textContent = message ? message.subject || '(sans objet)' : '';
  $('#snooze-clear').hidden = !state.snoozes[snoozeKey(state.selectedUid)];
  $('#snooze-panel').hidden = false;
}

function closeSnooze() {
  $('#snooze-panel').hidden = true;
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
  const node = $('#toast');
  node.textContent = message;
  node.className = 'toast ' + (kind || '');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3600);
}

function show(section) {
  $('#login').hidden = section !== 'login';
  $('#mailbox').hidden = section !== 'mailbox';
  $('#logout').hidden = section !== 'mailbox';
  $('#settings').hidden = section !== 'mailbox';
  $('#account-email').hidden = section !== 'mailbox';
}

function openSettings() {
  const account = state.account || {};
  const server = (value) => (value && value.host ? value.host + ':' + value.port + (value.secure ? ' · SSL/TLS' : '') : '—');
  $('#settings-email').textContent = account.email || '—';
  $('#settings-imap').textContent = server(account.imap);
  $('#settings-smtp').textContent = server(account.smtp);
  loadSignatureEditor();
  $('#settings-panel').hidden = false;
}

function closeSettings() {
  saveSignature();
  $('#settings-panel').hidden = true;
}

/* ------------------------------------------------------------------ */
/* Connexion                                                           */
/* ------------------------------------------------------------------ */

function applyAccountMode() {
  const novamail = Boolean(state.account && state.account.provider === 'novamail');
  $('#nm-banner').hidden = !novamail;
  const banner = $('#nm-banner-text');
  if (banner && novamail) {
    banner.textContent = 'Les messages envoyés à ' + (state.account.email || 'ton adresse') + ' arrivent directement ici.';
  }
}

async function createNovamailAddress(event) {
  if (event) event.preventDefault();
  const form = $('#nm-form');
  const error = $('#nm-error');
  const ok = $('#nm-ok');
  const button = $('#nm-create-btn');
  error.hidden = true;
  ok.hidden = true;
  button.disabled = true;
  button.textContent = 'Création…';

  const local = form.elements.local.value.trim();
  const password = form.elements.password.value;

  try {
    const created = await api('/api/novamail/create', {
      method: 'POST',
      body: JSON.stringify({ local, password }),
    });
    ok.textContent = 'Adresse créée : ' + created.address;
    ok.hidden = false;

    const account = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ provider: 'novamail', email: created.address, password }),
    });
    state.account = account;
    $('#account-email').textContent = account.email;
    show('mailbox');
    applyAccountMode();
    await loadFolders();
    await loadMessages();
    toast('Adresse ' + created.address + ' créée.', 'ok');
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Créer mon adresse';
  }
}

function fillPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  const form = $('#login-form');
  form.elements.imaphost.value = preset.imap.host;
  form.elements.imapport.value = preset.imap.port;
  form.elements.imapsecure.checked = preset.imap.secure;
  form.elements.smtphost.value = preset.smtp.host;
  form.elements.smtpport.value = preset.smtp.port;
  form.elements.smtpsecure.checked = preset.smtp.secure;
}

function loginPayload() {
  const form = $('#login-form');
  const presetName = form.elements.preset.value;
  const typed = form.elements.email.value.trim().toLowerCase();
  if (state.novamailDomain && typed.endsWith('@' + state.novamailDomain)) {
    return { email: typed, password: form.elements.password.value };
  }
  const preset = PRESETS[presetName];

  const imap = preset
    ? preset.imap
    : {
        host: form.elements.imaphost.value.trim(),
        port: Number(form.elements.imapport.value),
        secure: form.elements.imapsecure.checked,
      };
  const smtp = preset
    ? preset.smtp
    : {
        host: form.elements.smtphost.value.trim(),
        port: Number(form.elements.smtpport.value),
        secure: form.elements.smtpsecure.checked,
      };

  return {
    email: form.elements.email.value.trim(),
    password: form.elements.password.value,
    imap,
    smtp,
  };
}

async function submitLogin(event) {
  event.preventDefault();
  const error = $('#login-error');
  const button = $('#login-form').querySelector('button[type="submit"]');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Connexion…';

  try {
    const payload = loginPayload();
    if (state.novamailDomain && payload.email.toLowerCase().endsWith('@' + state.novamailDomain.toLowerCase())) {
      payload.provider = 'novamail';
      payload.imap = null;
      payload.smtp = null;
    }
    const account = await api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
    state.account = account;
    $('#account-email').textContent = account.email;
    show('mailbox');
    applyAccountMode();
    await loadFolders();
    await loadMessages();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Se connecter';
  }
}

/* ------------------------------------------------------------------ */
/* Dossiers                                                            */
/* ------------------------------------------------------------------ */

async function loadFolders() {
  try {
    const data = await api('/api/folders');
    state.folders = data.folders;
    renderFolders();
  } catch (error) {
    state.folders = [];
    renderFolders();
    toast(error.message, 'error');
  }
}

function renderFolders() {
  const container = $('#folders');
  container.innerHTML = state.folders
    .map((folder) => {
      const active = folder.path === state.box;
      const label = FOLDER_LABELS[folder.special] || folder.name;
      const badge = folder.unseen ? ' <span class="badge">' + folder.unseen + '</span>' : '';
      return '<button class="chip' + (active ? ' active' : '') + '" data-box="' + escapeHtml(folder.path) + '" type="button">' + escapeHtml(label) + badge + '</button>';
    })
    .join('');

  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.box = chip.dataset.box;
      renderFolders();
      loadMessages();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

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
  return items.filter((message) =>
    String(message.subject || '').toLowerCase().includes(term) ||
    String(message.fromName || '').toLowerCase().includes(term) ||
    String(message.fromAddress || '').toLowerCase().includes(term) ||
    String(message.toAddress || '').toLowerCase().includes(term),
  );
}

async function loadMessages() {
  const sync = $('#sync');
  const loader = $('#list-loader');
  sync.textContent = 'Chargement…';
  sync.classList.remove('offline');
  if (loader && !state.messages.length) loader.hidden = false;

  try {
    const data = await api('/api/messages?box=' + encodeURIComponent(state.box));
    state.messages = data.messages;
    purgeSnoozes(true);
    sync.textContent = data.total + ' message' + (data.total > 1 ? 's' : '') + ' dans ce dossier';
    renderMessages();
  } catch (error) {
    state.messages = [];
    sync.textContent = error.message;
    sync.classList.add('offline');
    renderMessages(error.message);
    setHelp(error.message);
  } finally {
    if (loader) loader.hidden = true;
  }
}

function renderMessages(errorMessage) {
  const list = $('#list');
  const empty = $('#empty');
  renderRadar();

  if (errorMessage) {
    list.innerHTML = '';
    empty.hidden = false;
    $('#empty-title').textContent = 'Connexion impossible';
    $('#empty-text').textContent = errorMessage;
    $('#retry').hidden = false;
    return;
  }

  const items = visibleMessages();
  if (!items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    $('#empty-title').textContent = state.search ? 'Aucun résultat' : 'Aucun message';
    $('#empty-text').textContent = state.search ? 'Essaie un autre mot-clé.' : (state.radar !== 'all' || state.focus ? 'Aucun message dans ce filtre.' : 'Ce dossier est vide.');
    $('#retry').hidden = true;
    $('#empty-link').hidden = true;
    return;
  }

  empty.hidden = true;
  $('#empty-link').hidden = true;
  list.innerHTML = items
    .map((message) => {
      const sentBox = state.box === 'SENT';
      const who = sentBox ? (message.toAddress || 'Destinataire') : (message.fromName || message.fromAddress || 'Inconnu');
      const hot = priorityScore(message) >= 4 ? ' hot' : '';
      return (
        '<li><button class="mail' + (message.unread ? ' unread' : '') + hot + '" data-uid="' + message.uid + '" type="button">' +
        '<span class="line"><span class="who">' + escapeHtml(who) + '</span><span class="when">' + escapeHtml(formatDate(message.date)) + '</span></span>' +
        '<span class="subject">' + (isSnoozed(message) ? '<span class="star">⏰</span> ' : '') + (message.flagged ? '<span class="star">★</span> ' : '') + escapeHtml(message.subject || '(sans objet)') + '</span>' +
        '</button></li>'
      );
    })
    .join('');

  list.querySelectorAll('.mail').forEach((item) => {
    item.addEventListener('click', () => openMessage(item.dataset.uid));
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

  radar.querySelectorAll('[data-radar]').forEach((button) => {
    button.addEventListener('click', () => {
      state.radar = state.radar === button.dataset.radar ? 'all' : button.dataset.radar;
      renderMessages();
    });
  });
  radar.querySelector('[data-focus]').addEventListener('click', () => {
    state.focus = !state.focus;
    if (state.focus && state.radar === 'noise') state.radar = 'all';
    renderMessages();
  });
}

function setHelp(message) {
  const link = $('#empty-link');
  const text = String(message || '');
  if (/gmail/i.test(text)) {
    link.href = 'https://myaccount.google.com/apppasswords';
    link.textContent = 'Créer un mot de passe d\'application Gmail';
    link.hidden = false;
  } else if (/outlook|microsoft 365/i.test(text)) {
    link.href = 'https://account.microsoft.com/security';
    link.textContent = 'Gérer la sécurité Microsoft';
    link.hidden = false;
  } else {
    link.hidden = true;
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
      if (name === 'href' && !/^(https?:|mailto:|tel:|#|[/])/i.test(String(attribute.value || '').trim())) {
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
      state.reply = { messageId: message.messageId, references: message.references };
      closeReader();
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
  const summary = state.messages.find((message) => String(message.uid) === String(uid));
  if (!summary) return;

  state.selectedUid = uid;
  state.current = null;
  $('#reader-subject').textContent = summary.subject || '(sans objet)';
  $('#reader-from').textContent = summary.fromName ? summary.fromName + ' <' + summary.fromAddress + '>' : summary.fromAddress;
  $('#reader-date').textContent = new Date(summary.date).toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  $('#reader-body').innerHTML = '<div class="loading"><img src="/icon.png" alt="" width="40" height="40"><span class="spinner"></span><p>Chargement du message…</p></div>';
  $('#assistant').hidden = true;
  $('#attachments').hidden = true;
  $('#reader').hidden = false;
  const flagButton = $('#reader-flag');
  flagButton.textContent = summary.flagged ? 'Retirer important' : 'Important';
  $('#reader-snooze').textContent = state.snoozes[snoozeKey(uid)] ? 'Modifier le rappel' : 'Rappel';

  try {
    const message = await api('/api/message?box=' + encodeURIComponent(state.box) + '&uid=' + uid);
    state.current = message;
    $('#reader-subject').textContent = message.subject;
    if (state.box === 'SENT') {
      $('#reader-from').textContent = 'À : ' + (message.to || message.toAddress || '');
    } else {
      $('#reader-from').textContent = message.from;
    }
    $('#reader-body').innerHTML = message.html
      ? '<div class="mail-html">' + sanitizeHtml(message.html) + '</div>'
      : '<pre class="mail-text">' + escapeHtml(message.text || '(message vide)') + '</pre>';

    if (message.attachments && message.attachments.length) {
      const box = $('#attachments');
      box.hidden = false;
      box.innerHTML = message.attachments.map((file, index) =>
        '<a class="attachment" href="/api/attachment?box=' + encodeURIComponent(state.box) + '&uid=' + encodeURIComponent(String(uid)) + '&index=' + index + '" download>' +
        escapeHtml(file.filename) +
        '</a>',
      ).join('');
    }

    renderSummary(message);
    renderAssistant(message);

    if (summary.unread) {
      summary.unread = false;
      renderMessages();
      api('/api/flags', { method: 'POST', body: JSON.stringify({ box: state.box, uid, seen: true }) }).catch(() => {});
    }
  } catch (error) {
    $('#reader-body').innerHTML = '<p class="muted">' + escapeHtml(error.message) + '</p>';
  }
}

function closeReader() {
  $('#reader').hidden = true;
  state.selectedUid = null;
  state.current = null;
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
    toast('Lien invalide : utilise https://, mailto: ou tel:');
    return;
  }
  editor.focus();
  const selection = window.getSelection();
  const selected = selection && selection.rangeCount > 0 && !selection.isCollapsed;
  if (selected) {
    document.execCommand('createLink', false, url);
  } else {
    document.execCommand('insertHTML', false, '<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>');
  }
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

function signatureKey() {
  const email = state.account && state.account.email ? state.account.email : 'local';
  return 'novamail.signature.' + email;
}

function signatureToHtml(value) {
  if (!value) return '';
  return looksLikeHtml(value) ? sanitizeComposeHtml(value) : textToHtml(value);
}

function getSignatureHtml() {
  try {
    return signatureToHtml(localStorage.getItem(signatureKey()) || '');
  } catch {
    return '';
  }
}

function loadSignatureEditor() {
  const editor = $('#signature-editor');
  if (!editor) return;
  let raw = '';
  try {
    raw = localStorage.getItem(signatureKey()) || '';
  } catch {
    /* stockage indisponible */
  }
  editor.innerHTML = signatureToHtml(raw);
}

function saveSignature() {
  const editor = $('#signature-editor');
  if (!editor) return;
  try {
    localStorage.setItem(signatureKey(), sanitizeComposeHtml(editor.innerHTML));
  } catch {
    /* stockage indisponible */
  }
}

function openCompose(preset, title) {
  const form = $('#compose-form');
  const editor = $('#compose-editor');
  form.reset();
  $('#compose-error').hidden = true;
  $('#compose-title').textContent = title || 'Nouveau message';
  form.elements.to.value = (preset && preset.to) || '';
  form.elements.cc.value = (preset && preset.cc) || '';
  form.elements.subject.value = (preset && preset.subject) || '';

  const base = textToHtml((preset && preset.text) || '');
  const signature = getSignatureHtml();
  editor.innerHTML = base + (signature ? (base ? '<br><br>' : '') + '--<br>' + signature : '');
  $('#compose').hidden = false;
  setTimeout(() => (preset && preset.to ? editor : form.elements.to).focus(), 40);
}

function closeCompose() {
  $('#compose').hidden = true;
}

async function sendMessage(event) {
  event.preventDefault();
  const form = $('#compose-form');
  const error = $('#compose-error');
  const button = $('#send');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Envoi…';

  const editor = $('#compose-editor');
  const text = String(editor.innerText || '').replace(/ /g, ' ').trim();
  const html = sanitizeComposeHtml(editor.innerHTML);
  if (!text && !html.replace(/<[^>]*>/g, '').trim()) {
    error.textContent = 'Écris un message avant d’envoyer.';
    error.hidden = false;
    button.disabled = false;
    button.textContent = 'Envoyer';
    return;
  }

  try {
    await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: form.elements.to.value.trim(),
        cc: form.elements.cc.value.trim(),
        subject: form.elements.subject.value.trim(),
        text,
        html,
        inReplyTo: state.reply ? state.reply.messageId : '',
        references: state.reply ? state.reply.references : '',
      }),
    });
    state.reply = null;
    closeCompose();
    toast('Message envoyé.', 'ok');
  } catch (err) {
    error.textContent = err.message;
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
  const own = String((state.account && state.account.email) || '').toLowerCase();
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
  state.reply = { messageId: message.messageId, references: message.references };
  closeReader();
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
    '\nDate : ' + (message.date ? new Date(message.date).toLocaleString('fr-FR') : '') +
    '\nObjet : ' + (message.subject || '') + '\n\n';
  state.reply = null;
  closeReader();
  openCompose({ subject, text: '\n\n' + header + (message.text || '') }, 'Transférer');
}

async function deleteCurrent() {
  if (!state.selectedUid) return;
  const inTrash = state.folders.some((folder) => folder.path === state.box && folder.special === 'trash');
  const hasTrash = state.folders.some((folder) => folder.special === 'trash' && folder.path !== state.box);
  const ok = window.confirm(inTrash || !hasTrash ? 'Supprimer définitivement ce message ?' : 'Déplacer ce message dans la corbeille ?');
  if (!ok) return;
  try {
    await api('/api/delete', { method: 'POST', body: JSON.stringify({ box: state.box, uid: state.selectedUid }) });
    closeReader();
    toast(inTrash ? 'Message supprimé.' : 'Message déplacé dans la corbeille.', 'ok');
    await loadFolders();
    await loadMessages();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function markAllRead() {
  if (!state.messages.length) return;
  try {
    const data = await api('/api/read-all', { method: 'POST', body: JSON.stringify({ box: state.box }) });
    state.messages.forEach((message) => { message.unread = false; });
    renderMessages();
    loadFolders();
    toast('Messages marqués comme lus' + (data.count ? ' (' + data.count + ')' : '') + '.', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Événements                                                          */
/* ------------------------------------------------------------------ */

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  closeSettings();
  state.account = null;
  state.messages = [];
  state.folders = [];
  state.current = null;
  $('#reader').hidden = true;
  $('#compose').hidden = true;
  $('#login-form').reset();
  applyAccountMode();
  show('login');
}

function bind() {
  $('#login-form').addEventListener('submit', submitLogin);
  $('#nm-form').addEventListener('submit', createNovamailAddress);
  $('#preset').addEventListener('change', (event) => fillPreset(event.target.value));
  $('#login-form').elements.email.addEventListener('blur', (event) => {
    const domain = String(event.target.value).split('@')[1] || '';
    const map = {
      'gmail.com': 'gmail', 'outlook.fr': 'outlook', 'outlook.com': 'outlook', 'hotmail.fr': 'outlook',
      'hotmail.com': 'outlook', 'live.fr': 'outlook', 'yahoo.fr': 'yahoo', 'yahoo.com': 'yahoo',
      'icloud.com': 'icloud', 'me.com': 'icloud', 'ovh.fr': 'ovh', 'free.fr': 'free', 'orange.fr': 'orange',
    };
    const preset = map[domain.toLowerCase()];
    if (preset) {
      $('#preset').value = preset;
      fillPreset(preset);
    }
  });

  $('#logout').addEventListener('click', logout);
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-logout').addEventListener('click', logout);
  $('#refresh').addEventListener('click', () => {
    loadFolders();
    loadMessages();
  });
  $('#retry').addEventListener('click', () => loadMessages());
  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderMessages();
  });

  $('#fab').addEventListener('click', () => openCompose());
  $('#reader-close').addEventListener('click', closeReader);
  $('#reader-reply').addEventListener('click', () => replyTo(false));
  $('#reader-reply-all').addEventListener('click', () => replyTo(true));
  $('#reader-forward').addEventListener('click', forwardMessage);
  $('#reader-print').addEventListener('click', () => window.print());
  $('#reader-snooze').addEventListener('click', openSnooze);
  $('#snooze-close').addEventListener('click', closeSnooze);
  $('#snooze-clear').addEventListener('click', () => applySnooze(0));
  document.querySelectorAll('#snooze-panel [data-hours]').forEach((button) => {
    button.addEventListener('click', () => applySnooze(Number(button.dataset.hours)));
  });
  $('#reader-delete').addEventListener('click', deleteCurrent);
  $('#reader-flag').addEventListener('click', async () => {
    if (!state.selectedUid) return;
    const summary = state.messages.find((message) => String(message.uid) === String(state.selectedUid));
    if (!summary) return;
    const next = !summary.flagged;
    try {
      await api('/api/flag', { method: 'POST', body: JSON.stringify({ box: state.box, uid: state.selectedUid, flagged: next }) });
      summary.flagged = next;
      $('#reader-flag').textContent = next ? 'Retirer important' : 'Important';
      renderMessages();
      toast(next ? 'Marqué comme important.' : 'Important retiré.');
    } catch (error) {
      toast(error.message);
    }
  });
  $('#read-all').addEventListener('click', markAllRead);
  $('#reader-unread').addEventListener('click', async () => {
    if (!state.selectedUid) return;
    await api('/api/flags', { method: 'POST', body: JSON.stringify({ box: state.box, uid: state.selectedUid, seen: false }) }).catch(() => {});
    const summary = state.messages.find((message) => String(message.uid) === String(state.selectedUid));
    if (summary) summary.unread = true;
    closeReader();
    renderMessages();
    toast('Marqué comme non lu.');
  });

  $('#compose-close').addEventListener('click', closeCompose);
  $('#compose-form').addEventListener('submit', sendMessage);
  document.querySelectorAll('.editor-toolbar').forEach(bindEditorToolbar);
  $('#signature-editor').addEventListener('input', saveSignature);
  $('#signature-editor').addEventListener('blur', saveSignature);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeReader();
      closeCompose();
      closeSettings();
      closeSnooze();
    }
  });

  setInterval(() => {
    if (purgeSnoozes(true)) renderMessages();
  }, 30000);
  setInterval(() => {
    if (!$('#mailbox').hidden && $('#reader').hidden && $('#compose').hidden) {
      loadFolders();
      loadMessages();
    }
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('#mailbox').hidden) {
      loadFolders();
      loadMessages();
    }
  });
}

async function loadNovamailDomain() {
  try {
    const info = await api('/api/novamail/info');
    if (info.domain) state.novamailDomain = info.domain;
    const node = $('#nm-domain');
    if (node && info.domain) node.textContent = '@' + info.domain;
  } catch {
    /* domaine indisponible : l'aide garde son texte par défaut */
  }
}

async function init() {
  initTheme();
  state.snoozes = readSnoozes();
  bind();
  loadNovamailDomain();
  try {
    const session = await api('/api/session');
    state.account = session;
    $('#account-email').textContent = session.email;
    show('mailbox');
    applyAccountMode();
    await loadFolders();
    await loadMessages();
  } catch {
    show('login');
  }
}

init();

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', '.tmp-webhook-secret');
fs.writeFileSync(file, 'whsec_' + crypto.randomBytes(24).toString('base64'), 'utf8');
console.log('secret de test écrit dans .tmp-webhook-secret (valeur non affichée)');

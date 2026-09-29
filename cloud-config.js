'use strict';
const crypto = require('node:crypto');
module.exports.readSecrets = function (env) {
  const token = env.HOMECAST_CONTROL_TOKEN || '';
  const seed = env.HOMECAST_STREAM_KEY || '';
  if (!/^[a-zA-Z0-9_+\/=-]{32,}$/.test(token) || token.startsWith('REPLACE_')) throw Error('Set a random HOMECAST_CONTROL_TOKEN of at least 32 characters.');
  if (!/^[a-zA-Z0-9_+\/=-]{24,}$/.test(seed) || seed.startsWith('REPLACE_')) throw Error('Set a random HOMECAST_STREAM_KEY of at least 24 characters.');
  // Render generates standard base64 secrets. Derive a stable URL-safe key if needed.
  const streamKey = /^[a-zA-Z0-9_-]+$/.test(seed) ? seed : crypto.createHash('sha256').update(seed).digest('hex');
  return {token, streamKey};
};

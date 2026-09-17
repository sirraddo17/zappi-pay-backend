const fetch = require('node-fetch');
const prisma = require('./prisma');

const BASE_URLS = {
  sandbox: 'https://sandbox.vtpass.com/api',
  live: 'https://vtpass.com/api',
};

// Settings is a single row — there's only ever one merchant account for
// this whole app, so "find the settings row" is always "find the first
// one, create it if it doesn't exist yet" rather than something scoped
// per branch/user.
async function getSettings() {
  let settings = await prisma.settings.findFirst();
  if (!settings) {
    settings = await prisma.settings.create({ data: {} });
  }
  return settings;
}

// GET requests (service catalog, variations, merchant-verify) use
// public-key; POST requests that actually move money (pay) use
// api-key + secret-key. Passing the wrong pair is a common VTpass
// integration mistake, so this is centralized here rather than left to
// each route to get right.
async function vtpassRequest(method, path, { query, body } = {}) {
  const settings = await getSettings();
  if (!settings.vtpassApiKey || !settings.vtpassSecretKey || !settings.vtpassPublicKey) {
    const err = new Error('VTpass credentials are not configured yet. Set them in Settings first.');
    err.code = 'VTPASS_NOT_CONFIGURED';
    throw err;
  }

  const baseUrl = BASE_URLS[settings.vtpassMode] || BASE_URLS.sandbox;
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (method === 'GET') {
    headers['api-key'] = settings.vtpassApiKey;
    headers['public-key'] = settings.vtpassPublicKey;
  } else {
    headers['api-key'] = settings.vtpassApiKey;
    headers['secret-key'] = settings.vtpassSecretKey;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.response_description || `VTpass request failed (${response.status})`);
    err.vtpassResponse = data;
    throw err;
  }
  return data;
}

module.exports = { getSettings, vtpassRequest };

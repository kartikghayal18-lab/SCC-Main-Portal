const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('./env');

// Deployment-level branding is controlled by config/client.json and
// branding/colors.json. Each copied client project only needs to edit those
// files, not the route or view code.
const CLIENT_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'client.json');
const BRANDING_COLORS_PATH = path.join(ROOT_DIR, 'branding', 'colors.json');

let cachedClientConfig = null;
let cachedColors = null;

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'demo-coaching';
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function getBrandingColors() {
  if (!cachedColors) {
    cachedColors = readJson(BRANDING_COLORS_PATH, {
      primary: '#2563eb',
      background: '#f3f6fb',
      surface: '#ffffff',
    });
  }

  return cachedColors;
}

function getClientConfig() {
  if (!cachedClientConfig) {
    const raw = readJson(CLIENT_CONFIG_PATH, {});
    const colors = getBrandingColors();
    const clientName = String(raw.clientName || 'Demo Coaching').trim() || 'Demo Coaching';
    const domain = String(raw.domain || '').trim();
    const primaryColor = String(raw.primaryColor || colors.primary || '#2563eb').trim() || '#2563eb';
    const supportEmail = String(raw.supportEmail || '').trim().toLowerCase();

    cachedClientConfig = {
      clientName,
      domain,
      primaryColor,
      supportEmail,
      logoPath: '/public/scc-logo.svg',
      faviconPath: '/public/scc-icon.svg',
      uploadPrefix: slugify(clientName),
    };
  }

  return cachedClientConfig;
}

module.exports = {
  getBrandingColors,
  getClientConfig,
};

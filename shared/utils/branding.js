const { getBrandingColors, getClientConfig } = require('../../config/client');

const HTTP_URL_PATTERN = /^https?:\/\//i;

function isValidHttpUrl(value) {
  return HTTP_URL_PATTERN.test(String(value || '').trim());
}

function normalizeLogoUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, 'http://localhost');

    if ((url.hostname === 'www.google.com' || url.hostname === 'google.com') && url.pathname === '/imgres') {
      const nestedImageUrl = url.searchParams.get('imgurl');
      if (nestedImageUrl && isValidHttpUrl(nestedImageUrl)) {
        return nestedImageUrl.trim();
      }
    }

    return isValidHttpUrl(raw) || raw.startsWith('/') ? raw : '';
  } catch {
    return raw.startsWith('/') ? raw : '';
  }
}

function normalizeHexColor(value, fallback) {
  const next = String(value || '').trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(next)) {
    if (next.length === 4) {
      return `#${next[1]}${next[1]}${next[2]}${next[2]}${next[3]}${next[3]}`.toLowerCase();
    }
    return next.toLowerCase();
  }
  return fallback;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex, '#2563eb').slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenHex(hex, amount = 22) {
  const { r, g, b } = hexToRgb(hex);
  const next = [r, g, b]
    .map((value) => Math.max(0, Math.min(255, value - amount)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `#${next}`;
}

function buildBranding(coaching = null) {
  const clientConfig = getClientConfig();
  const colors = getBrandingColors();
  const themePrimary = normalizeHexColor(coaching?.theme_primary, normalizeHexColor(clientConfig.primaryColor, colors.primary || '#2563eb'));
  const themeBackground = normalizeHexColor(coaching?.theme_background, normalizeHexColor(colors.background, '#f3f6fb'));
  const themeSurface = normalizeHexColor(coaching?.theme_surface, normalizeHexColor(colors.surface, '#ffffff'));
  const brandName = String(coaching?.brand_name || coaching?.name || clientConfig.clientName).trim() || clientConfig.clientName;

  return {
    brandName,
    coachingName: coaching?.name || brandName,
    logoUrl: normalizeLogoUrl(coaching?.logo_url || clientConfig.logoPath),
    faviconUrl: clientConfig.faviconPath,
    supportEmail: coaching?.contact_email || clientConfig.supportEmail || '',
    clientDomain: clientConfig.domain || '',
    themePrimary,
    themeBackground,
    themeSurface,
    ownerConsoleLabel: `${clientConfig.clientName} Control`,
    ownerLoginTitle: `${clientConfig.clientName} Owner Login`,
    portalLabel: `${clientConfig.clientName} Portal`,
    platformLabel: clientConfig.clientName,
    cssVars: [
      `--brand:${themePrimary}`,
      `--brand-dark:${darkenHex(themePrimary, 26)}`,
      `--bg:${themeBackground}`,
      `--card:${themeSurface}`,
      `--line:${rgbaFromHex(themePrimary, 0.14)}`,
      `--bg-accent-a:${rgbaFromHex(themePrimary, 0.18)}`,
      `--bg-accent-b:${rgbaFromHex(themePrimary, 0.08)}`,
      `--surface-glow:${rgbaFromHex(themePrimary, 0.1)}`,
      `--shadow:0 12px 30px ${rgbaFromHex(themePrimary, 0.08)}`,
    ].join(';'),
  };
}

module.exports = {
  buildBranding,
  isValidHttpUrl,
  normalizeLogoUrl,
};

function resolvePort(value) {
  const raw = String(value || '').trim();
  if (!raw) return 3000;

  if (/^\d+$/.test(raw)) {
    const numericPort = Number(raw);
    if (Number.isInteger(numericPort) && numericPort > 0 && numericPort < 65536) {
      return numericPort;
    }
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }

  return 3000;
}

module.exports = {
  resolvePort,
};

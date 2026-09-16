const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

const perfStore = new AsyncLocalStorage();
const GLOBAL_SLOW_LIMIT = 10;
const globalSlowOperations = [];

function nowMs() {
  return performance.now();
}

function roundMs(value) {
  return Number(value || 0).toFixed(1);
}

function createPerfTrace({ method, path, route }) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    method,
    path,
    route: route || `${method} ${path}`,
    startedAt: nowMs(),
    operations: [],
  };
}

function runWithPerfTrace(trace, work) {
  return perfStore.run(trace, work);
}

function getCurrentPerfTrace() {
  return perfStore.getStore() || null;
}

function recordPerfOperation(type, name, durationMs, meta = {}) {
  const trace = getCurrentPerfTrace();
  const operation = {
    type,
    name,
    durationMs: Number(durationMs || 0),
    meta,
  };

  if (trace) {
    trace.operations.push(operation);
  }

  globalSlowOperations.push({
    ...operation,
    route: trace?.route || 'unknown',
    path: trace?.path || '',
    recordedAt: new Date().toISOString(),
  });
  globalSlowOperations.sort((left, right) => right.durationMs - left.durationMs);
  globalSlowOperations.splice(GLOBAL_SLOW_LIMIT);

  return operation;
}

async function measurePerfOperation(type, name, work, meta = {}) {
  const startedAt = nowMs();
  try {
    return await work();
  } finally {
    recordPerfOperation(type, name, nowMs() - startedAt, meta);
  }
}

function getTraceSummary(trace, totalMs = null) {
  const operations = [...(trace?.operations || [])];
  const totalsByType = operations.reduce((acc, operation) => {
    acc[operation.type] = (acc[operation.type] || 0) + operation.durationMs;
    return acc;
  }, {});
  const slowest = operations
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, GLOBAL_SLOW_LIMIT)
    .map((operation) => ({
      type: operation.type,
      name: operation.name,
      ms: Number(roundMs(operation.durationMs)),
      meta: operation.meta,
    }));

  return {
    traceId: trace?.id,
    route: trace?.route,
    path: trace?.path,
    totalMs: Number(roundMs(totalMs ?? (nowMs() - (trace?.startedAt || nowMs())))),
    sqlMs: Number(roundMs(totalsByType.sql || 0)),
    renderMs: Number(roundMs(totalsByType.render || 0)),
    s3Ms: Number(roundMs(totalsByType.s3 || 0)),
    routeMs: Number(roundMs(Math.max(0, (totalMs ?? (nowMs() - (trace?.startedAt || nowMs()))) - (totalsByType.render || 0)))),
    operationCount: operations.length,
    slowest,
  };
}

function logPerfTrace(trace, totalMs = null) {
  if (!trace) return;
  const summary = getTraceSummary(trace, totalMs);
  console.log('[PERF]', JSON.stringify(summary));
  console.log('[PERF TOP10]', JSON.stringify(summary.slowest));
}

function getGlobalSlowOperations() {
  return globalSlowOperations.map((operation) => ({
    ...operation,
    durationMs: Number(roundMs(operation.durationMs)),
  }));
}

module.exports = {
  createPerfTrace,
  getCurrentPerfTrace,
  getGlobalSlowOperations,
  logPerfTrace,
  measurePerfOperation,
  nowMs,
  recordPerfOperation,
  runWithPerfTrace,
};

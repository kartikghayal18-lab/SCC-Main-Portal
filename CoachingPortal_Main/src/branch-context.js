const { AsyncLocalStorage } = require('async_hooks');

const branchContext = new AsyncLocalStorage();

function runWithBranchContext(scope, callback) {
  return branchContext.run({
    branchId: Number.isInteger(Number(scope?.branchId)) ? Number(scope.branchId) : null,
    isSuperAdmin: Boolean(scope?.isSuperAdmin),
  }, callback);
}

function getBranchContext() {
  return branchContext.getStore() || {
    branchId: null,
    isSuperAdmin: true,
  };
}

function getCurrentBranchId(req) {
  const branchId = Number(req?.session?.user?.branchId);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    const error = new Error('A valid branch session is required');
    error.status = 403;
    throw error;
  }
  return branchId;
}

module.exports = {
  getBranchContext,
  getCurrentBranchId,
  runWithBranchContext,
};

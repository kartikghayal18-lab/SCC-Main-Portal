const session = require('express-session');
const { getPool } = require('./db');

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 8;
const SESSION_TABLE = 'app_sessions';

let tableReadyPromise = null;

function getSessionExpireDate(sess) {
  const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
  if (cookieExpires && Number.isFinite(cookieExpires.getTime())) {
    return cookieExpires;
  }

  return new Date(Date.now() + DEFAULT_TTL_MS);
}

async function ensureSessionTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = Promise.resolve()
      .then(() => getPool().query(`
        CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
          sid TEXT PRIMARY KEY,
          sess JSONB NOT NULL,
          expire TIMESTAMPTZ NOT NULL
        )
      `))
      .then(() => getPool().query(`
        CREATE INDEX IF NOT EXISTS ${SESSION_TABLE}_expire_idx
        ON ${SESSION_TABLE} (expire)
      `))
      .catch((error) => {
        tableReadyPromise = null;
        throw error;
      });
  }

  return tableReadyPromise;
}

class PostgresSessionStore extends session.Store {
  async get(sid, callback = () => {}) {
    try {
      await ensureSessionTable();
      const result = await getPool().query(
        `SELECT sess
         FROM ${SESSION_TABLE}
         WHERE sid = $1 AND expire > NOW()
         LIMIT 1`,
        [sid]
      );
      callback(null, result.rows[0]?.sess || null);
    } catch (error) {
      callback(error);
    }
  }

  async set(sid, sess, callback = () => {}) {
    try {
      await ensureSessionTable();
      await getPool().query(
        `INSERT INTO ${SESSION_TABLE} (sid, sess, expire)
         VALUES ($1, $2, $3)
         ON CONFLICT (sid)
         DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, sess, getSessionExpireDate(sess)]
      );
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  async destroy(sid, callback = () => {}) {
    try {
      await ensureSessionTable();
      await getPool().query(`DELETE FROM ${SESSION_TABLE} WHERE sid = $1`, [sid]);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  async touch(sid, sess, callback = () => {}) {
    try {
      await ensureSessionTable();
      await getPool().query(
        `UPDATE ${SESSION_TABLE}
         SET expire = $2
         WHERE sid = $1`,
        [sid, getSessionExpireDate(sess)]
      );
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

module.exports = {
  PostgresSessionStore,
  ensureSessionTable,
};

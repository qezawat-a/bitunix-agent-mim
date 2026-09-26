import { Pool } from 'pg';
import { CONFIG } from '../config.js';
import { readLocal, writeLocal } from './memory.js';

let pool = null;
let poolFailed = false;

// Neon and most hosted providers verify TLS, but a local Postgres or one behind
// a proxy may not. DATABASE_SSL=false turns it off entirely and
// DATABASE_SSL_REJECT_UNAUTHORIZED=false keeps TLS on while skipping the check.
function sslOption() {
  if (String(CONFIG.DATABASE_SSL).toLowerCase() === 'false') return false;
  const rejectUnauthorized = String(CONFIG.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false';
  return { rejectUnauthorized };
}

function getPool() {
  if (!CONFIG.DATABASE_URL) return null;
  // One unreachable database must not retry on every save for the life of the process.
  if (poolFailed) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: CONFIG.DATABASE_URL,
      ssl: sslOption(),
    });
    pool.on('error', error => console.error('database pool error:', error.message));
  }
  return pool;
}

export async function ensureSchema() {
  const p = getPool();
  if (!p) return false;
  const client = await p.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS trader_store (id TEXT NOT NULL, key TEXT NOT NULL, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (id, key))');
    await client.query('CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, key TEXT NOT NULL, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (store, key))');
    return true;
  } finally {
    client.release();
  }
}

export async function loadStore() {
  const p = getPool();
  if (!p) return readLocal();
  try {
    await ensureSchema();
    const client = await p.connect();
    try {
      const res = await client.query('SELECT key, value FROM trader_store WHERE id = $1', [CONFIG.store_id]);
      const out = Object.create(null);
      for (const row of res.rows) out[row.key] = row.value;
      if (Object.keys(out).length === 0) return readLocal();
      return out;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('persist load error:', error.message);
    return readLocal();
  }
}

// Re-enables the database after a failed save, so /diag and the next restart
// can report a recovered connection.
export function resetPersistFailure() {
  poolFailed = false;
}

// The local file is written first and is the durable copy, so a database that
// is down or misconfigured must not throw: the caller keeps running on the file
// and the next save may well succeed.
export async function saveStore(data) {
  const local = await writeLocal(data);
  const p = getPool();
  if (!p) return local;
  try {
    await ensureSchema();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      try {
        for (const [key, value] of Object.entries(data)) {
          await client.query(
            'INSERT INTO trader_store (id, key, value) VALUES ($1, $2, $3) ON CONFLICT (id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
            [CONFIG.store_id, key, JSON.stringify(value)]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  } catch (error) {
    poolFailed = true;
    console.error('persist save error, keeping the local copy:', error.message);
  }
  return local;
}

export async function closePersist() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export const FileBackend = { load: readLocal, save: writeLocal };
export const PostgresBackend = { load: loadStore, save: saveStore, ensureSchema, close: closePersist };

import { CONFIG } from '../config.js';

export class Memory {
  store = {};
  backend = null;

  constructor() { this.store = {}; }

  async remember(key, value) {
    this.store[key] = value;
    await this.save();
  }

  async recall(key) {
    return this.store[key] ?? null;
  }

  async save() {
    if (!CONFIG.DATABASE_URL) return;
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: CONFIG.DATABASE_URL });
      const client = await pool.connect();
      const storeId = CONFIG.store_id;
      for (const [k, v] of Object.entries(this.store)) {
        await client.query(
          `INSERT INTO trader_store (id, key, value) VALUES ($1, $2, $3) ON CONFLICT (id, key) DO UPDATE SET value=$3`,
          [storeId, k, JSON.stringify(v)]
        );
      }
      client.release();
      await pool.end();
    } catch (e) {
      console.error('Neon persist error:', e.message);
    }
  }

  async load() {
    if (!CONFIG.DATABASE_URL) return;
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: CONFIG.DATABASE_URL });
      const client = await pool.connect();
      const storeId = CONFIG.store_id;
      const res = await client.query(
        `SELECT key, value FROM trader_store WHERE id = $1`,
        [storeId]
      );
      for (const row of res.rows) {
        try { this.store[row.key] = JSON.parse(row.value); } catch { this.store[row.key] = row.value; }
      }
      client.release();
      await pool.end();
    } catch (e) {
      console.error('Neon load error:', e.message);
    }
  }

  all() { return this.store; }
}
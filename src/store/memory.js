import fs from 'fs/promises';
import path from 'path';

const STORE_DIR = path.resolve('data');
const STORE_FILE = path.join(STORE_DIR, 'trader-store.json');

export async function readLocal() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

export async function writeLocal(data) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, STORE_FILE);
  return data;
}

export class StoreMemory {
  data = {};
  async load() { this.data = await readLocal(); return this.data; }
  async save() { return writeLocal(this.data); }
  get(k, fb = null) { return this.data[k] ?? fb; }
  set(k, v) { this.data[k] = v; return v; }
  all() { return this.data; }
}

import fs from 'fs/promises';
import path from 'path';

const SESSION_FILE = path.resolve('data/sessions.json');

async function readAll() {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function writeAll(all) {
  await fs.mkdir('data', { recursive: true });
  const tmp = SESSION_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(all, null, 2));
  await fs.rename(tmp, SESSION_FILE);
}

export async function saveSession(id, session) {
  const all = await readAll();
  all[id] = { ...session, updatedAt: new Date().toISOString() };
  await writeAll(all);
  return all[id];
}

export async function loadSession(id) {
  const all = await readAll();
  return all[id] ?? null;
}

export async function listSessions() {
  const all = await readAll();
  return Object.entries(all).map(([id, s]) => ({ id, ...s }));
}

export async function deleteSession(id) {
  const all = await readAll();
  delete all[id];
  await writeAll(all);
}

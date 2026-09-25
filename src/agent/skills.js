import fs from 'fs/promises';
import path from 'path';

const BUILTIN_DIR = path.resolve('skills');
const CUSTOM_DIR = path.resolve('data/skills');

function safeName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('skill name must use letters, numbers, _ or -');
  return value;
}

function description(text) {
  const match = String(text).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return '';
  for (const line of match[1].split('\n')) {
    const [key, ...value] = line.split(':');
    if (key?.trim() === 'description') return value.join(':').trim();
  }
  return '';
}

async function readSkillDirectory(directory, custom) {
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return []; }
  const output = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (/^readme\.md$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const content = await fs.readFile(file, 'utf8');
    const id = entry.name.replace(/\.md$/i, '').toLowerCase();
    output.push({ id, name: id, description: description(content), content, path: file, custom });
  }
  return output;
}

export async function listSkills(skillDir = BUILTIN_DIR) {
  const builtin = await readSkillDirectory(skillDir, false);
  const custom = await readSkillDirectory(CUSTOM_DIR, true);
  const merged = new Map(builtin.map(skill => [skill.id, skill]));
  for (const skill of custom) merged.set(skill.id, skill);
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadSkill(name, skillDir = BUILTIN_DIR) {
  const id = safeName(name);
  const skills = await listSkills(skillDir);
  return skills.find(skill => skill.id === id || skill.name === id) || null;
}

export async function saveSkill(name, content) {
  const id = safeName(name);
  const text = String(content || '').trim();
  if (!text) throw new Error('skill content cannot be empty');
  await fs.mkdir(CUSTOM_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(CUSTOM_DIR, `${id}.md`);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  await fs.rename(temporary, file);
  return { id, name: id, content: text, path: file, custom: true, description: description(text) };
}

export async function removeSkill(name) {
  const id = safeName(name);
  const file = path.join(CUSTOM_DIR, `${id}.md`);
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

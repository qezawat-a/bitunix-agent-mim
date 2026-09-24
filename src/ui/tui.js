import readline from 'readline';
import { CONFIG } from '../config.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'j-rock> ' });

console.log(`J-ROCK TUI — agent=${CONFIG.AGENT_NAME} dry_run=${CONFIG.dry_run ? 1 : 0}`);
console.log('Commands: /tsettings /tset key value /tget key /treset /tstatus /tsignal [symbol] /tsync /tauto_on /tauto_off /tdryrun 1|0 /settings /quit');

rl.prompt();
rl.on('line', async (line) => {
  const t = line.trim();
  if (t === '/quit' || t === '/exit') { rl.close(); return; }
  if (t === '/tsettings' || t === '/settings') {
    for (const [k, v] of Object.entries(CONFIG)) console.log(`${k} = ${Array.isArray(v) ? v.join(',') : v}`);
  } else if (t.startsWith('/tset ')) {
    const [, k, ...vp] = t.split(/\s+/);
    CONFIG[k] = vp.join(' ');
    console.log(`set ${k} = ${CONFIG[k]}`);
  } else if (t.startsWith('/tget ')) {
    const k = t.split(/\s+/)[1];
    console.log(`${k} = ${CONFIG[k]}`);
  } else if (t === '/treset') {
    console.log('settings reset requested (restart to apply defaults)');
  } else if (t === '/tstatus') {
    console.log(`symbol=${CONFIG.symbol} lev=${CONFIG.leverage} dry_run=${CONFIG.dry_run ? 1 : 0} auto=${CONFIG.auto_trade ? 'on' : 'off'}`);
  } else if (t.startsWith('/tsignal')) {
    console.log('(connect client to scan — run npm start for live scan)');
  } else if (t === '/tauto_on') { CONFIG.auto_trade = true; console.log('auto_trade on'); }
  else if (t === '/tauto_off') { CONFIG.auto_trade = false; console.log('auto_trade off'); }
  else if (t.startsWith('/tdryrun')) {
    const v = t.split(/\s+/)[1];
    CONFIG.dry_run = v !== '0';
    console.log(`dry_run=${CONFIG.dry_run ? 1 : 0}`);
  } else if (t) {
    console.log(`(agent) you said: ${t}`);
  }
  rl.prompt();
});
rl.on('close', () => process.exit(0));

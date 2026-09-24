import { spawn } from 'child_process';

export async function loadMcpTools(servers = []) {
  const tools = [];
  for (const srv of servers) {
    try {
      const t = await connectMcpServer(srv);
      tools.push(...t);
    } catch (e) {
      console.error(`MCP server ${srv.name} failed:`, e.message);
    }
  }
  return tools;
}

function sendJsonRpc(proc, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res = JSON.parse(line);
          if (res.id === id) {
            cleanup();
            resolve(res.result);
          }
        } catch {}
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.off('error', onErr);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('MCP timeout')); }, 10000);
    proc.stdout.on('data', onData);
    proc.on('error', onErr);
    proc.stdin.write(msg);
  });
}

async function connectMcpServer(srv) {
  const proc = spawn(srv.command, srv.args || [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const list = await sendJsonRpc(proc, 'tools/list');
  const tools = (list?.tools || []).map((t) => ({
    name: `mcp_${srv.name}_${t.name}`,
    description: t.description || `MCP ${srv.name} tool ${t.name}`,
    parameters: t.inputSchema || { type: 'object', properties: {} },
    async handler(args) {
      return sendJsonRpc(proc, 'tools/call', { name: t.name, arguments: args });
    },
  }));
  return tools;
}

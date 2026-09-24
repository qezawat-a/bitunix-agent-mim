import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import crypto from 'crypto';

function signWs(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'sign').sort();
  const str = keys.map((k) => `${k}${params[k]}`).join('');
  const digest = crypto.createHash('sha256').update(`${params.nonce}${params.timestamp}${params.apiKey}${str}`).digest('hex');
  return crypto.createHash('sha256').update(digest + secret).digest('hex');
}

export class BitunixWs {
  constructor({ onPublic = () => {}, onPrivate = () => {} } = {}) {
    this.onPublic = onPublic;
    this.onPrivate = onPrivate;
    this.publicWs = null;
    this.privateWs = null;
    this.subs = [];
  }

  connectPublic(channels = ['tickers']) {
    const url = CONFIG.BITUNIX_WS_PUBLIC;
    this.publicWs = new WebSocket(url);
    this.publicWs.on('open', () => {
      for (const ch of channels) {
        this.publicWs.send(JSON.stringify({ op: 'subscribe', args: [{ channel: ch }] }));
      }
    });
    this.publicWs.on('message', (raw) => {
      try { this.onPublic(JSON.parse(raw.toString())); } catch {}
    });
    this.publicWs.on('close', () => {
      setTimeout(() => this.connectPublic(channels), 5000);
    });
    this.publicWs.on('error', () => {});
    return this.publicWs;
  }

  connectPrivate(channels = ['balance', 'order', 'position', 'tp_sl']) {
    const url = CONFIG.BITUNIX_WS_PRIVATE;
    this.privateWs = new WebSocket(url);
    this.privateWs.on('open', () => {
      const nonce = String(Math.floor(Math.random() * 1e9));
      const timestamp = String(Date.now());
      const base = { apiKey: CONFIG.BITUNIX_API_KEY, nonce, timestamp };
      const sign = signWs(base, CONFIG.BITUNIX_API_SECRET);
      for (const ch of channels) {
        this.privateWs.send(JSON.stringify({ op: 'subscribe', args: [{ channel: ch, ...base, sign }] }));
      }
    });
    this.privateWs.on('message', (raw) => {
      try { this.onPrivate(JSON.parse(raw.toString())); } catch {}
    });
    this.privateWs.on('close', () => {
      setTimeout(() => this.connectPrivate(channels), 5000);
    });
    this.privateWs.on('error', () => {});
    return this.privateWs;
  }

  close() {
    try { this.publicWs?.close(); } catch {}
    try { this.privateWs?.close(); } catch {}
  }
}

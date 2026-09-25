import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import crypto from 'crypto';

function signWs(params, secret) {
  const keys = Object.keys(params).filter(key => key !== 'sign').sort();
  const value = keys.map(key => `${key}${params[key]}`).join('');
  const digest = crypto.createHash('sha256').update(`${params.nonce}${params.timestamp}${params.apiKey}${value}`).digest('hex');
  return crypto.createHash('sha256').update(digest + secret).digest('hex');
}

export class BitunixWs {
  constructor({ onPublic = () => {}, onPrivate = () => {} } = {}, WebSocketImpl = WebSocket) {
    this.onPublic = onPublic;
    this.onPrivate = onPrivate;
    this.WebSocketImpl = WebSocketImpl;
    this.publicWs = null;
    this.privateWs = null;
    this.publicReconnectTimer = null;
    this.privateReconnectTimer = null;
    this.stopped = true;
  }

  connectPublic(channels = ['tickers']) {
    this.stopped = false;
    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    const previous = this.publicWs;
    this.publicWs = null;
    try { previous?.close(); } catch {}
    const socket = new this.WebSocketImpl(CONFIG.BITUNIX_WS_PUBLIC);
    this.publicWs = socket;
    socket.on('open', () => {
      if (this.publicWs !== socket || this.stopped) return;
      for (const channel of channels) socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel }] }));
    });
    socket.on('message', raw => {
      if (this.publicWs !== socket) return;
      try { this.onPublic(JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', () => {
      if (this.publicWs !== socket) return;
      this.publicWs = null;
      if (!this.stopped) this.publicReconnectTimer = setTimeout(() => this.connectPublic(channels), 5000);
    });
    socket.on('error', () => {});
    return socket;
  }

  connectPrivate(channels = ['balance', 'order', 'position', 'tp_sl']) {
    this.stopped = false;
    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    const previous = this.privateWs;
    this.privateWs = null;
    try { previous?.close(); } catch {}
    const socket = new this.WebSocketImpl(CONFIG.BITUNIX_WS_PRIVATE);
    this.privateWs = socket;
    socket.on('open', () => {
      if (this.privateWs !== socket || this.stopped) return;
      const nonce = String(Math.floor(Math.random() * 1e9));
      const timestamp = String(Date.now());
      const base = { apiKey: CONFIG.BITUNIX_API_KEY, nonce, timestamp };
      const sign = signWs(base, CONFIG.BITUNIX_API_SECRET);
      for (const channel of channels) {
        socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel, ...base, sign }] }));
      }
    });
    socket.on('message', raw => {
      if (this.privateWs !== socket) return;
      try { this.onPrivate(JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', () => {
      if (this.privateWs !== socket) return;
      this.privateWs = null;
      if (!this.stopped) this.privateReconnectTimer = setTimeout(() => this.connectPrivate(channels), 5000);
    });
    socket.on('error', () => {});
    return socket;
  }

  close() {
    this.stopped = true;
    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    this.publicReconnectTimer = null;
    this.privateReconnectTimer = null;
    const publicSocket = this.publicWs;
    const privateSocket = this.privateWs;
    this.publicWs = null;
    this.privateWs = null;
    try { publicSocket?.close(); } catch {}
    try { privateSocket?.close(); } catch {}
  }
}

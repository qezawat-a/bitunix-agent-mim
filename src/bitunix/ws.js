import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import crypto from 'crypto';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

export function wsLoginSignature(nonceValue, timestamp, apiKey, secretKey) {
  const digest = sha256(`${nonceValue}${timestamp}${apiKey}`);
  return sha256(digest + secretKey);
}

export function normalizeChannel(channel, includeSymbol) {
  const source = typeof channel === 'string' ? { ch: channel } : { ...(channel || {}) };
  const ch = source.ch ?? source.channel;
  if (!ch) throw new Error('WebSocket channel is required');
  const result = { ...source, ch: String(ch) };
  delete result.channel;
  const symbol = source.symbol ?? (includeSymbol ? CONFIG.symbol : undefined);
  if (symbol) result.symbol = String(symbol).toUpperCase();
  return result;
}

export function normalizeChannels(channels, includeSymbol) {
  const list = Array.isArray(channels) ? channels : [channels];
  return list.filter(value => value !== null && value !== undefined).map(channel => normalizeChannel(channel, includeSymbol));
}

function startHeartbeat(socket, isCurrent) {
  const timer = setInterval(() => {
    if (!isCurrent()) return;
    try { socket.send(JSON.stringify({ op: 'ping', ping: Math.floor(Date.now() / 1000) })); } catch {}
  }, 3000);
  timer.unref?.();
  return timer;
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
    this.publicHeartbeatTimer = null;
    this.privateHeartbeatTimer = null;
    this.stopped = true;
  }

  connectPublic(channels = ['tickers']) {
    this.stopped = false;
    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    if (this.publicHeartbeatTimer) clearInterval(this.publicHeartbeatTimer);
    const previous = this.publicWs;
    this.publicWs = null;
    try { previous?.close(); } catch {}
    const socket = new this.WebSocketImpl(CONFIG.BITUNIX_WS_PUBLIC);
    this.publicWs = socket;
    socket.on('open', () => {
      if (this.publicWs !== socket || this.stopped) return;
      const args = normalizeChannels(channels, true);
      if (args.length) socket.send(JSON.stringify({ op: 'subscribe', args }));
      this.publicHeartbeatTimer = startHeartbeat(socket, () => this.publicWs === socket && !this.stopped);
    });
    socket.on('message', raw => {
      if (this.publicWs !== socket) return;
      try { this.onPublic(JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', () => {
      if (this.publicWs !== socket) return;
      this.publicWs = null;
      if (this.publicHeartbeatTimer) clearInterval(this.publicHeartbeatTimer);
      this.publicHeartbeatTimer = null;
      if (!this.stopped) {
        this.publicReconnectTimer = setTimeout(() => this.connectPublic(channels), 5000);
        this.publicReconnectTimer.unref?.();
      }
    });
    socket.on('error', () => {});
    return socket;
  }

  connectPrivate(channels = ['balance', 'order', 'position', 'tpsl']) {
    this.stopped = false;
    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    if (this.privateHeartbeatTimer) clearInterval(this.privateHeartbeatTimer);
    const previous = this.privateWs;
    this.privateWs = null;
    try { previous?.close(); } catch {}
    const socket = new this.WebSocketImpl(CONFIG.BITUNIX_WS_PRIVATE);
    this.privateWs = socket;
    socket.on('open', () => {
      if (this.privateWs !== socket || this.stopped) return;
      if (!CONFIG.BITUNIX_API_KEY || !CONFIG.BITUNIX_API_SECRET) return;
      const timestamp = Math.floor(Date.now() / 1000);
      const auth = {
        apiKey: CONFIG.BITUNIX_API_KEY,
        timestamp,
        nonce: nonce(),
      };
      auth.sign = wsLoginSignature(auth.nonce, timestamp, auth.apiKey, CONFIG.BITUNIX_API_SECRET);
      socket.send(JSON.stringify({ op: 'login', args: [auth] }));
      const args = normalizeChannels(channels, false);
      if (args.length) socket.send(JSON.stringify({ op: 'subscribe', args }));
      this.privateHeartbeatTimer = startHeartbeat(socket, () => this.privateWs === socket && !this.stopped);
    });
    socket.on('message', raw => {
      if (this.privateWs !== socket) return;
      try { this.onPrivate(JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', () => {
      if (this.privateWs !== socket) return;
      this.privateWs = null;
      if (this.privateHeartbeatTimer) clearInterval(this.privateHeartbeatTimer);
      this.privateHeartbeatTimer = null;
      if (!this.stopped) {
        this.privateReconnectTimer = setTimeout(() => this.connectPrivate(channels), 5000);
        this.privateReconnectTimer.unref?.();
      }
    });
    socket.on('error', () => {});
    return socket;
  }

  close() {
    this.stopped = true;
    for (const timer of [this.publicReconnectTimer, this.privateReconnectTimer]) if (timer) clearTimeout(timer);
    for (const timer of [this.publicHeartbeatTimer, this.privateHeartbeatTimer]) if (timer) clearInterval(timer);
    this.publicReconnectTimer = null;
    this.privateReconnectTimer = null;
    this.publicHeartbeatTimer = null;
    this.privateHeartbeatTimer = null;
    const publicSocket = this.publicWs;
    const privateSocket = this.privateWs;
    this.publicWs = null;
    this.privateWs = null;
    try { publicSocket?.close(); } catch {}
    try { privateSocket?.close(); } catch {}
  }
}

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 2567);
const MAX_PLAYERS_PER_ROOM = 100;
const WORLD_LIMIT = 20000;            // الخريطة الأونلاين 12000 × 12000، نترك هامشاً
const MIN_MOVE_INTERVAL_MS = 25;      // حماية بسيطة: لا أكثر من ~40 رسالة حركة في الثانية للاعب
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'hungry-snake-simple-server', rooms: rooms.size }));
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Hungry Snake multiplayer server is running.');
});

const wss = new WebSocketServer({ server, path: '/game' });

function safeName(value) {
  // إزالة < > \ والرموز التحكمية فقط (الإصدار السابق كان يحذف الأحرف الكبيرة والأرقام بالخطأ)
  const name = String(value || 'Player').replace(/[<>\\\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Player';
}
function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, except = null) {
  const message = JSON.stringify(data);
  for (const client of room.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(message);
  }
}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { code, clients: new Set(), players: new Map() });
  return rooms.get(code);
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  room.players.delete(ws.playerId);
  broadcast(room, { type: 'player_left', playerId: ws.playerId });
  if (room.clients.size === 0) rooms.delete(room.code);
  ws.room = null;
}
// يحدّث بيانات اللاعب من رسالة join/move (الموقع + النقاط + اللون + رقم الرأس)
function applyState(player, msg) {
  const x = Number(msg.x), y = Number(msg.y), angle = Number(msg.angle);
  if (Number.isFinite(x)) player.x = Math.max(0, Math.min(WORLD_LIMIT, x));
  if (Number.isFinite(y)) player.y = Math.max(0, Math.min(WORLD_LIMIT, y));
  if (Number.isFinite(angle)) player.angle = Math.max(-Math.PI * 4, Math.min(Math.PI * 4, angle));
  if (msg.boost !== undefined) player.boost = Boolean(msg.boost);
  if (msg.score !== undefined) {
    const score = Number(msg.score);
    if (Number.isFinite(score)) player.score = Math.max(0, Math.min(1000000, score));
  }
  if (msg.color !== undefined) player.color = clampInt(msg.color, -2147483648, 2147483647, player.color);
  if (msg.head !== undefined) player.head = clampInt(msg.head, -1, 99, player.head);
}

wss.on('connection', (ws) => {
  ws.playerId = randomUUID();
  ws.isAlive = true;
  ws.lastMove = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Invalid JSON' }); }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (ws.room) leave(ws);
      const code = String(msg.room || 'main').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) || 'MAIN';
      const room = getRoom(code);
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) {
        return send(ws, { type: 'error', message: 'Room is full' });
      }
      ws.room = room;
      ws.playerName = safeName(msg.name);
      room.clients.add(ws);
      const existing = [...room.players.values()];
      const player = { id: ws.playerId, name: ws.playerName, x: 6000, y: 6000, angle: 0, boost: false, score: 10, color: 0, head: -1 };
      applyState(player, msg);
      room.players.set(ws.playerId, player);
      send(ws, { type: 'joined', playerId: ws.playerId, room: code, players: existing });
      broadcast(room, { type: 'player_joined', player }, ws);
      return;
    }

    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    if (!ws.room) return send(ws, { type: 'error', message: 'Join a room first' });

    if (msg.type === 'leave') {          // اللاعب مات أو خرج من الجولة لكن الاتصال ما زال مفتوحاً
      leave(ws);
      return;
    }

    if (msg.type === 'move') {
      const now = Date.now();
      if (now - ws.lastMove < MIN_MOVE_INTERVAL_MS) return;
      ws.lastMove = now;
      // Prototype relay only: no collision, scoring, rewards, or authoritative movement here.
      const player = ws.room.players.get(ws.playerId);
      if (!player) return;
      applyState(player, msg);
      broadcast(ws.room, { type: 'player_moved', player }, ws);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hungry Snake server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/game`);
});

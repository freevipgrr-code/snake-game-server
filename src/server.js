'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 2567);
const MAX_PLAYERS_PER_ROOM = 100;
const TARGET_POPULATION = 100;       // اللاعبون الحقيقيون + بوتات السيرفر
const WORLD_SIZE = 12000;
const WORLD_CENTER = WORLD_SIZE / 2;
const ARENA_RADIUS = WORLD_SIZE / 2;
const BOT_TICK_MS = 50;              // محاكاة السيرفر: 20 إطاراً/ثانية
const BOT_BROADCAST_MS = 100;        // إرسال الحالة: 10 مرات/ثانية
const MIN_MOVE_INTERVAL_MS = 25;
const rooms = new Map();
const COLORS = [0xFF40C4FF, 0xFFFF5252, 0xFF69F0AE, 0xFFFFD740, 0xFFB388FF,
  0xFFFF80AB, 0xFF64FFDA, 0xFFFFAB40, 0xFF8C9EFF, 0xFFE6EE9C];
const BOT_NAMES = ['Alex', 'Max', 'Leo', 'Noah', 'Liam', 'Mia', 'Zoe', 'Kai', 'Ryan',
  'Adam', 'Ethan', 'Lucas', 'Ava', 'Luna', 'Milo', 'Nora', 'Jack', 'Ella', 'Omar', 'Sam'];

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'hungry-snake-authoritative-bots', rooms: rooms.size }));
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Hungry Snake multiplayer server is running.');
});
const wss = new WebSocketServer({ server, path: '/game' });

function safeName(value) {
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
function randomPoint() {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * (ARENA_RADIUS - 500);
  return { x: WORLD_CENTER + Math.cos(a) * r, y: WORLD_CENTER + Math.sin(a) * r };
}
function makeBot(room) {
  const id = 'bot-' + (++room.nextBotId);
  const pos = randomPoint();
  const serial = room.nextBotId - 1;
  const base = BOT_NAMES[serial % BOT_NAMES.length];
  const suffix = serial >= BOT_NAMES.length ? String(Math.floor(serial / BOT_NAMES.length) + 1) : '';
  const angle = Math.random() * Math.PI * 2;
  return {
    id, name: base + suffix + ' (Bot)', x: pos.x, y: pos.y, angle, target: angle,
    boost: false, score: 5 + Math.floor(Math.random() * 35),
    color: COLORS[Math.floor(Math.random() * COLORS.length)], head: -1,
    think: 0.2 + Math.random() * 0.8
  };
}
function ensureBots(room) {
  const wanted = Math.max(0, TARGET_POPULATION - room.players.size);
  while (room.bots.size > wanted) {
    const id = room.bots.keys().next().value;
    room.bots.delete(id);
  }
  while (room.bots.size < wanted) {
    const bot = makeBot(room);
    room.bots.set(bot.id, bot);
  }
}
function botSnapshot(room) {
  return [...room.bots.values()].map(b => ({
    id: b.id, name: b.name, x: b.x, y: b.y, angle: b.angle,
    boost: b.boost, score: b.score, color: b.color, head: b.head
  }));
}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, {
    code, clients: new Set(), players: new Map(), bots: new Map(), nextBotId: 0,
    broadcastT: 0
  });
  return rooms.get(code);
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  room.players.delete(ws.playerId);
  broadcast(room, { type: 'player_left', playerId: ws.playerId });
  if (room.clients.size === 0) {
    rooms.delete(room.code);
  } else {
    ensureBots(room);
    broadcast(room, { type: 'bot_state', bots: botSnapshot(room) });
  }
  ws.room = null;
}
function applyState(player, msg) {
  const x = Number(msg.x), y = Number(msg.y), angle = Number(msg.angle);
  if (Number.isFinite(x)) player.x = Math.max(0, Math.min(WORLD_SIZE, x));
  if (Number.isFinite(y)) player.y = Math.max(0, Math.min(WORLD_SIZE, y));
  if (Number.isFinite(angle)) player.angle = Math.max(-Math.PI * 4, Math.min(Math.PI * 4, angle));
  if (msg.boost !== undefined) player.boost = Boolean(msg.boost);
  if (msg.score !== undefined) {
    const score = Number(msg.score);
    if (Number.isFinite(score)) player.score = Math.max(0, Math.min(1000000, score));
  }
  if (msg.color !== undefined) player.color = clampInt(msg.color, -2147483648, 2147483647, player.color);
  if (msg.head !== undefined) player.head = clampInt(msg.head, -1, 99, player.head);
}
function turnToward(current, target, maxTurn) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + Math.max(-maxTurn, Math.min(maxTurn, d));
}
function updateBot(room, bot, dt) {
  const cx = bot.x - WORLD_CENTER, cy = bot.y - WORLD_CENTER;
  const safeRadius = ARENA_RADIUS - 650;
  if (cx * cx + cy * cy > safeRadius * safeRadius) {
    bot.target = Math.atan2(-cy, -cx);
  } else {
    bot.think -= dt;
    // تجنب الرؤوس القريبة للاعبين والبوتات، مع قرار الاتجاه من السيرفر فقط.
    const look = 260;
    const ax = bot.x + Math.cos(bot.angle) * look;
    const ay = bot.y + Math.sin(bot.angle) * look;
    let danger = null, dangerD = Infinity;
    const others = [...room.players.values(), ...room.bots.values()];
    for (const other of others) {
      if (other.id === bot.id) continue;
      const dx = other.x - ax, dy = other.y - ay;
      const d2 = dx * dx + dy * dy;
      if (d2 < 210 * 210 && d2 < dangerD) { danger = other; dangerD = d2; }
    }
    if (danger) {
      const cross = Math.cos(bot.angle) * (danger.y - bot.y) - Math.sin(bot.angle) * (danger.x - bot.x);
      bot.target = bot.angle + (cross > 0 ? -1.35 : 1.35);
      bot.think = 0.25;
    } else if (bot.think <= 0) {
      bot.think = 0.45 + Math.random() * 0.75;
      const nearest = [...room.players.values()].sort((a, b) =>
        ((a.x - bot.x) ** 2 + (a.y - bot.y) ** 2) - ((b.x - bot.x) ** 2 + (b.y - bot.y) ** 2))[0];
      if (nearest && Math.random() < 0.22) {
        bot.target = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
      } else {
        bot.target += (Math.random() - 0.5) * 1.5;
      }
    }
  }
  bot.angle = turnToward(bot.angle, bot.target, 4.2 * dt);
  const speed = bot.boost ? 340 : 190;
  bot.x += Math.cos(bot.angle) * speed * dt;
  bot.y += Math.sin(bot.angle) * speed * dt;
  const dx = bot.x - WORLD_CENTER, dy = bot.y - WORLD_CENTER;
  const max = ARENA_RADIUS - 120;
  if (dx * dx + dy * dy > max * max) {
    bot.target = Math.atan2(-dy, -dx);
    bot.x = WORLD_CENTER + dx * (max / Math.hypot(dx, dy));
    bot.y = WORLD_CENTER + dy * (max / Math.hypot(dx, dy));
  }
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
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) return send(ws, { type: 'error', message: 'Room is full' });
      ws.room = room;
      ws.playerName = safeName(msg.name);
      room.clients.add(ws);
      const existing = [...room.players.values()];
      const player = { id: ws.playerId, name: ws.playerName, x: 6000, y: 6000, angle: 0, boost: false, score: 10, color: 0, head: -1 };
      applyState(player, msg);
      room.players.set(ws.playerId, player);
      ensureBots(room);
      send(ws, { type: 'joined', playerId: ws.playerId, room: code, players: existing, bots: botSnapshot(room) });
      broadcast(room, { type: 'player_joined', player }, ws);
      broadcast(room, { type: 'bot_state', bots: botSnapshot(room) }, ws);
      return;
    }
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    if (!ws.room) return send(ws, { type: 'error', message: 'Join a room first' });
    if (msg.type === 'leave') { leave(ws); return; }
    if (msg.type === 'move') {
      const now = Date.now();
      if (now - ws.lastMove < MIN_MOVE_INTERVAL_MS) return;
      ws.lastMove = now;
      const player = ws.room.players.get(ws.playerId);
      if (!player) return;
      applyState(player, msg);
      broadcast(ws.room, { type: 'player_moved', player }, ws);
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;
  for (const room of rooms.values()) {
    if (room.clients.size === 0) continue;
    ensureBots(room);
    for (const bot of room.bots.values()) updateBot(room, bot, dt);
    room.broadcastT += now - (room.lastBroadcastAt || now);
    room.lastBroadcastAt = now;
    if (room.broadcastT >= BOT_BROADCAST_MS) {
      room.broadcastT = 0;
      broadcast(room, { type: 'bot_state', bots: botSnapshot(room) });
    }
  }
}, BOT_TICK_MS);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hungry Snake authoritative-bot server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/game`);
});

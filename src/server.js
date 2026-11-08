'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 2567);
const MAX_PLAYERS_PER_ROOM = 100;
const TARGET_POPULATION = 100;
const WORLD_SIZE = 12000;
const WORLD_CENTER = WORLD_SIZE / 2;
const ARENA_RADIUS = WORLD_SIZE / 2;
const BORDER_R = 30;
const HEAD_HIT = 0.45;
const BODY_HIT = 0.78;
const BOT_TICK_MS = 33;                 // محاكاة 30 مرة في الثانية
const BROADCAST_MS = 60;                 // لقطة العالم ~15 مرة في الثانية
const MIN_MOVE_INTERVAL_MS = 25;
const FOOD_TARGET = 3000;
const MAX_FOOD = 8000;
const VIEW_RANGE = 3200;                // نرسل لكل لاعب من حوله فقط (يقلل البيانات كثيراً)
const MAX_SEGMENTS = 350;
const rooms = new Map();
const COLORS = [0xFF40C4FF, 0xFFFF5252, 0xFF69F0AE, 0xFFFFD740, 0xFFB388FF,
  0xFFFF80AB, 0xFF64FFDA, 0xFFFFAB40, 0xFF8C9EFF, 0xFFE6EE9C];
const BOT_NAMES = ['Alex', 'Max', 'Leo', 'Noah', 'Liam', 'Mia', 'Zoe', 'Kai', 'Ryan',
  'Adam', 'Ethan', 'Lucas', 'Ava', 'Luna', 'Milo', 'Nora', 'Jack', 'Ella', 'Omar', 'Sam'];

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'hungry-snake-authoritative-world', rooms: rooms.size }));
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Hungry Snake multiplayer server is running.');
});
const wss = new WebSocketServer({ server, path: '/game' });

function safeName(value) {
  const name = String(value || 'Player').replace(/[<>\\\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Player';
}
function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
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
function radius(score) { return 9 + Math.min(64, Math.sqrt(Math.max(0, score)) * 0.85); }
function segmentCount(score) { return Math.min(MAX_SEGMENTS, 12 + Math.floor(Math.sqrt(Math.max(0, score)) * 4.5)); }
function spacing(score) { return radius(score) * 0.72; }
function bodyRadius(score, index, count) {
  const r = radius(score), tail = Math.max(6, Math.min(26, Math.round(count * 0.45)));
  const start = count - tail;
  if (index <= start) return r;
  const u = (index - start) / Math.max(1, count - 1 - start);
  return r * Math.pow(Math.max(0, 1 - u), 1.3);
}
function makeBody(x, y, angle, score) {
  const n = segmentCount(score), gap = spacing(score), body = [];
  for (let i = 0; i < n; i++) body.push({ x: x - Math.cos(angle) * gap * i, y: y - Math.sin(angle) * gap * i });
  return body;
}
function parseBody(raw, player) {
  if (!Array.isArray(raw)) return;
  const out = [];
  for (let i = 0; i + 1 < raw.length && out.length < MAX_SEGMENTS; i += 2) {
    const x = Number(raw[i]), y = Number(raw[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    out.push({ x: clamp(x, 0, WORLD_SIZE, player.x), y: clamp(y, 0, WORLD_SIZE, player.y) });
  }
  if (out.length >= 2) {
    // الرأس الوارد هو مرجع الجسم؛ نمنع الجسم من أن يبدأ بعيداً عنه.
    if (Math.hypot(out[0].x - player.x, out[0].y - player.y) < 350) player.body = out;
  }
}
function makeFood(room, x, y, color, value) {
  if (room.foods.size >= MAX_FOOD) return null;
  const f = { id: 'f' + (++room.nextFoodId), x: clamp(x, 0, WORLD_SIZE, WORLD_CENTER),
    y: clamp(y, 0, WORLD_SIZE, WORLD_CENTER), c: color | 0, v: clamp(value, 0.1, 1000, 1) };
  room.foods.set(f.id, f);
  room.foodAdded.push(f);
  return f;
}
function spawnFood(room) {
  const p = randomPoint();
  makeFood(room, p.x, p.y, COLORS[Math.floor(Math.random() * COLORS.length)], 1);
}
function foodSnapshot(room) { return [...room.foods.values()]; }
function getRoom(code) {
  if (!rooms.has(code)) {
    const room = { code, clients: new Set(), players: new Map(), bots: new Map(), foods: new Map(),
      nextBotId: 0, nextFoodId: 0, foodAdded: [], foodRemoved: [], broadcastT: 0, statsT: 0 };
    for (let i = 0; i < FOOD_TARGET; i++) spawnFood(room);
    room.foodAdded.length = 0;
    rooms.set(code, room);
  }
  return rooms.get(code);
}
function makeBot(room) {
  const id = 'bot-' + (++room.nextBotId), p = randomPoint(), serial = room.nextBotId - 1;
  const base = BOT_NAMES[serial % BOT_NAMES.length];
  const suffix = serial >= BOT_NAMES.length ? String(Math.floor(serial / BOT_NAMES.length) + 1) : '';
  const angle = Math.random() * Math.PI * 2, score = 5 + Math.floor(Math.random() * 35);
  return { id, name: base + suffix + ' (Bot)', x: p.x, y: p.y, angle, target: angle,
    boost: false, score, color: COLORS[Math.floor(Math.random() * COLORS.length)], head: -1,
    body: makeBody(p.x, p.y, angle, score), think: 0.2 + Math.random() * 0.8,
    invulnUntil: Date.now() + 1500, respawnAt: 0, dropT: 0, alive: true };
}
function ensureBots(room) {
  const wanted = Math.max(0, TARGET_POPULATION - room.players.size);
  while (room.bots.size > wanted) {
    const id = room.bots.keys().next().value;
    room.bots.delete(id);
    broadcast(room, { type: 'worm_dead', id });
  }
  while (room.bots.size < wanted) { const b = makeBot(room); room.bots.set(b.id, b); }
}
function snapshotWorm(w) {
  return { id: w.id, name: w.name, x: Math.round(w.x), y: Math.round(w.y),
    angle: Math.round(w.angle * 100) / 100, boost: !!w.boost,
    score: Math.round(w.score * 10) / 10, color: w.color,
    head: (w.head === undefined || w.head === null) ? -1 : w.head, alive: w.alive !== false };
}
function botSnapshot(room) { return [...room.bots.values()].filter(b => b.alive).map(snapshotWorm); }
function playerSnapshot(room) { return [...room.players.values()].filter(p => p.alive).map(snapshotWorm); }
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  const p = room.players.get(ws.playerId);
  if (p && p.alive) dropBody(room, p);
  room.players.delete(ws.playerId);
  broadcast(room, { type: 'player_left', playerId: ws.playerId });
  if (room.clients.size === 0) rooms.delete(room.code);
  else ensureBots(room);
  ws.room = null;
}
function applyPlayerState(player, msg) {
  const x = Number(msg.x), y = Number(msg.y), angle = Number(msg.angle);
  if (Number.isFinite(x)) player.x = clamp(x, 0, WORLD_SIZE, player.x);
  if (Number.isFinite(y)) player.y = clamp(y, 0, WORLD_SIZE, player.y);
  if (Number.isFinite(angle)) player.angle = clamp(angle, -Math.PI * 4, Math.PI * 4, player.angle);
  if (msg.boost !== undefined) player.boost = Boolean(msg.boost) && player.score > 6;
  if (msg.color !== undefined) player.color = clampInt(msg.color, -2147483648, 2147483647, player.color);
  if (msg.head !== undefined) player.head = clampInt(msg.head, -1, 99, player.head);
  parseBody(msg.segments, player);
}
function turnToward(current, target, maxTurn) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + Math.max(-maxTurn, Math.min(maxTurn, d));
}
function followBody(w) {
  const n = segmentCount(w.score), gap = spacing(w.score);
  if (!w.body || !w.body.length) w.body = makeBody(w.x, w.y, w.angle, w.score);
  w.body[0] = { x: w.x, y: w.y };
  while (w.body.length < n) w.body.push({ ...w.body[w.body.length - 1] });
  if (w.body.length > n) w.body.length = n;
  for (let i = 1; i < n; i++) {
    const prev = w.body[i - 1], cur = w.body[i];
    let dx = cur.x - prev.x, dy = cur.y - prev.y, d = Math.hypot(dx, dy);
    if (d < 0.001) { dx = -Math.cos(w.angle); dy = -Math.sin(w.angle); d = 1; }
    cur.x = prev.x + dx / d * gap;
    cur.y = prev.y + dy / d * gap;
  }
}
// حركة اللاعب يحسبها السيرفر: الجهاز يرسل الاتجاه المطلوب والتسريع فقط (input).
function stepPlayer(p, dt) {
  p.angle = turnToward(p.angle, p.target, 4.2 * dt);
  const speed = (p.boost && p.score > 6) ? 340 : 190;
  p.x += Math.cos(p.angle) * speed * dt;
  p.y += Math.sin(p.angle) * speed * dt;
  followBody(p);
}
function updateBot(room, bot, dt) {
  const cx = bot.x - WORLD_CENTER, cy = bot.y - WORLD_CENTER;
  const safeRadius = ARENA_RADIUS - 650;
  if (cx * cx + cy * cy > safeRadius * safeRadius) bot.target = Math.atan2(-cy, -cx);
  else {
    bot.think -= dt;
    const look = 260, ax = bot.x + Math.cos(bot.angle) * look, ay = bot.y + Math.sin(bot.angle) * look;
    let danger = null, dangerD = Infinity;
    const others = [...room.players.values(), ...room.bots.values()];
    for (const other of others) {
      if (other.id === bot.id || other.alive === false) continue;
      const dx = other.x - ax, dy = other.y - ay, d2 = dx * dx + dy * dy;
      if (d2 < 210 * 210 && d2 < dangerD) { danger = other; dangerD = d2; }
    }
    if (danger) {
      const cross = Math.cos(bot.angle) * (danger.y - bot.y) - Math.sin(bot.angle) * (danger.x - bot.x);
      bot.target = bot.angle + (cross > 0 ? -1.35 : 1.35); bot.think = 0.25;
    } else if (bot.think <= 0) {
      bot.think = 0.45 + Math.random() * 0.75;
      const nearest = [...room.players.values()].filter(p => p.alive)
        .sort((a, b) => ((a.x - bot.x) ** 2 + (a.y - bot.y) ** 2) - ((b.x - bot.x) ** 2 + (b.y - bot.y) ** 2))[0];
      if (nearest && Math.random() < 0.22) bot.target = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
      else bot.target += (Math.random() - 0.5) * 1.5;
    }
  }
  bot.angle = turnToward(bot.angle, bot.target, 4.2 * dt);
  const speed = bot.boost ? 340 : 190;
  bot.x += Math.cos(bot.angle) * speed * dt;
  bot.y += Math.sin(bot.angle) * speed * dt;
  const dx = bot.x - WORLD_CENTER, dy = bot.y - WORLD_CENTER, max = ARENA_RADIUS - 120;
  if (dx * dx + dy * dy > max * max) {
    bot.target = Math.atan2(-dy, -dx);
    const d = Math.hypot(dx, dy) || 1;
    bot.x = WORLD_CENTER + dx * max / d; bot.y = WORLD_CENTER + dy * max / d;
  }
  followBody(bot);
}
function dropBody(room, w) {
  const body = w.body && w.body.length ? w.body : [{ x: w.x, y: w.y }];
  const value = Math.max(1, w.score / Math.max(1, body.length / 2)) * 0.8;
  for (let i = 0; i < body.length; i += 2) {
    const s = body[i]; makeFood(room, s.x + (Math.random() - 0.5) * 10,
      s.y + (Math.random() - 0.5) * 10, w.color, value);
  }
}
function killWorm(room, w, reason) {
  if (!w || w.alive === false) return;
  w.alive = false; w.boost = false;
  dropBody(room, w);
  if (w.id.startsWith('bot-')) {
    w.respawnAt = Date.now() + 3000;
    broadcast(room, { type: 'worm_dead', id: w.id });
  } else {
    const ws = [...room.clients].find(c => c.playerId === w.id);
    if (ws) send(ws, { type: 'player_dead', playerId: w.id, score: w.score, reason: reason || 'collision' });
    broadcast(room, { type: 'player_dead', playerId: w.id, score: w.score, reason: reason || 'collision' }, ws || null);
  }
}
function checkCollisions(room) {
  const all = [...room.players.values(), ...room.bots.values()].filter(w => w.alive !== false);
  const dying = [];
  for (const w of all) {
    if (Date.now() < (w.invulnUntil || 0)) continue;
    const rr = radius(w.score), cx = w.x - WORLD_CENTER, cy = w.y - WORLD_CENTER;
    const edge = ARENA_RADIUS - BORDER_R - rr * 0.3;
    if (cx * cx + cy * cy > edge * edge) { dying.push([w, 'border']); continue; }
    let dead = false;
    for (const other of all) {
      if (other === w || other.alive === false) continue;
      const or = radius(other.score), dxh = other.x - w.x, dyh = other.y - w.y;
      const headLimit = (rr + or) * 0.55;
      if (dxh * dxh + dyh * dyh < headLimit * headLimit && w.score <= other.score) { dead = true; break; }
      const body = other.body || [];
      const quick = rr + or + 60;
      if (w.x < other.minX - quick || w.x > other.maxX + quick || w.y < other.minY - quick || w.y > other.maxY + quick) continue;
      for (let i = 1; i < body.length; i++) {
        const dx = body[i].x - w.x, dy = body[i].y - w.y;
        const lim = rr * HEAD_HIT + bodyRadius(other.score, i, body.length) * BODY_HIT;
        if (dx * dx + dy * dy < lim * lim) { dead = true; break; }
      }
      if (dead) break;
    }
    if (dead) dying.push([w, 'snake']);
  }
  for (const [w, reason] of dying) killWorm(room, w, reason);
}
function updateBounds(w) {
  const body = w.body || [];
  let minX = w.x, maxX = w.x, minY = w.y, maxY = w.y;
  for (const s of body) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); }
  w.minX = minX; w.maxX = maxX; w.minY = minY; w.maxY = maxY;
}
function updateFoodAndGrowth(room, w, dt) {
  if (w.alive === false) return;
  if (w.boost && w.score > 6) {
    w.score = Math.max(3, w.score - 3.5 * dt);
    w.dropT += dt;
    if (w.dropT >= 0.35) {
      w.dropT = 0;
      const tail = w.body && w.body[w.body.length - 1] || { x: w.x, y: w.y };
      makeFood(room, tail.x, tail.y, w.color, 1);
    }
  }
  const r = radius(w.score), eatR = r + 16;
  for (const [id, f] of room.foods) {
    const dx = w.x - f.x, dy = w.y - f.y;
    if (dx * dx + dy * dy <= eatR * eatR) {
      w.score += f.v;
      room.foods.delete(id);
      room.foodRemoved.push(id);
    }
  }
}
function respawnBot(room, bot) {
  const p = randomPoint(); bot.x = p.x; bot.y = p.y; bot.angle = bot.target = Math.random() * Math.PI * 2;
  bot.score = 5 + Math.floor(Math.random() * 35); bot.body = makeBody(bot.x, bot.y, bot.angle, bot.score);
  bot.alive = true; bot.invulnUntil = Date.now() + 1500; bot.dropT = 0;
}
function processRoom(room, dt) {
  const now = Date.now();
  ensureBots(room);
  for (const bot of room.bots.values()) {
    if (bot.alive === false) { if (now >= bot.respawnAt) respawnBot(room, bot); continue; }
    updateBot(room, bot, dt);
  }
  for (const p of room.players.values()) {
    if (p.alive === false) continue;
    stepPlayer(p, dt);
    updateFoodAndGrowth(room, p, dt);
    updateBounds(p);
  }
  for (const b of room.bots.values()) if (b.alive !== false) { updateFoodAndGrowth(room, b, dt); updateBounds(b); }
  checkCollisions(room);
  while (room.foods.size < FOOD_TARGET) spawnFood(room);
}

wss.on('connection', (ws) => {
  ws.playerId = randomUUID(); ws.isAlive = true; ws.lastMove = 0;
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
      ws.room = room; ws.playerName = safeName(msg.name); room.clients.add(ws);
      const p = { id: ws.playerId, name: ws.playerName, x: clamp(msg.x, 0, WORLD_SIZE, WORLD_CENTER),
        y: clamp(msg.y, 0, WORLD_SIZE, WORLD_CENTER), angle: clamp(msg.angle, -Math.PI * 4, Math.PI * 4, 0),
        boost: false, score: 10, target: clamp(msg.angle, -Math.PI * 4, Math.PI * 4, 0), color: clampInt(msg.color, -2147483648, 2147483647, 0xFF40C4FF),
        head: clampInt(msg.head, -1, 99, -1), body: [], alive: true, invulnUntil: Date.now() + 2500, dropT: 0 };
      p.body = makeBody(p.x, p.y, p.angle, p.score); parseBody(msg.segments, p);
      room.players.set(ws.playerId, p); ensureBots(room);
      send(ws, { type: 'joined', playerId: ws.playerId, room: code,
        players: playerSnapshot(room).filter(x => x.id !== p.id), bots: botSnapshot(room), foods: foodSnapshot(room),
        playerStats: { score: p.score, alive: true } });
      broadcast(room, { type: 'player_joined', player: snapshotWorm(p) }, ws);
      return;
    }
    if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t });
    if (!ws.room) return send(ws, { type: 'error', message: 'Join a room first' });
    if (msg.type === 'leave') { leave(ws); return; }
    if (msg.type === 'input') {
      const p = ws.room.players.get(ws.playerId); if (!p || p.alive === false) return;
      const now = Date.now();
      const el = Math.min(0.3, Math.max(0.02, (now - (p.lastInput || now - 40)) / 1000));
      p.lastInput = now;
      const a = Number(msg.angle);
      if (Number.isFinite(a)) {
        // الجهاز يرسل اتجاهه الفعلي: نتبعه مباشرة (مع حد للدوران يمنع الغش) فيتطابق مسار السيرفر مع شاشة اللاعب
        const maxTurn = 4.2 * (el + 0.12) * 1.5 + 0.1;
        p.angle = turnToward(p.angle, clamp(a, -Math.PI * 8, Math.PI * 8, p.angle), maxTurn);
        p.target = clamp(a, -Math.PI * 8, Math.PI * 8, p.angle);
      }
      p.boost = Boolean(msg.boost) && p.score > 6;
      return;
    }
    if (msg.type === 'move') {        // رسالة قديمة: لا نقبل الموقع من الجهاز، فقط اللون والرأس
      const p = ws.room.players.get(ws.playerId); if (!p) return;
      if (msg.color !== undefined) p.color = clampInt(msg.color, -2147483648, 2147483647, p.color);
      if (msg.head !== undefined) p.head = clampInt(msg.head, -1, 99, p.head);
    }
  });
  ws.on('close', () => leave(ws)); ws.on('error', () => leave(ws));
});

function sendState(room) {
  const snaps = [];
  for (const p of room.players.values()) if (p.alive !== false) snaps.push([p, false]);
  for (const b of room.bots.values()) if (b.alive !== false) snaps.push([b, true]);
  const cache = new Map();
  for (const ws of room.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const me = room.players.get(ws.playerId);
    const cx = me ? me.x : WORLD_CENTER, cy = me ? me.y : WORLD_CENTER;
    const ps = [], bs = [];
    for (const [w, isBot] of snaps) {
      if (w.id === ws.playerId) continue;
      const dx = w.x - cx, dy = w.y - cy;
      const range = VIEW_RANGE + Math.min(2500, (w.body ? w.body.length : 10) * spacing(w.score) * 0.5);
      if (dx * dx + dy * dy > range * range) continue;
      let str = cache.get(w.id);
      if (!str) { str = JSON.stringify(snapshotWorm(w)); cache.set(w.id, str); }
      (isBot ? bs : ps).push(str);
    }
    const self = me ? JSON.stringify({ x: Math.round(me.x), y: Math.round(me.y),
      angle: Math.round(me.angle * 100) / 100, score: Math.round(me.score * 10) / 10, alive: me.alive !== false }) : 'null';
    ws.send('{"type":"state","players":[' + ps.join(',') + '],"bots":[' + bs.join(',') + '],"self":' + self + '}');
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000)); lastTick = now;
  for (const room of rooms.values()) {
    if (!room.clients.size) continue;
    processRoom(room, dt);
    room.broadcastT += dt * 1000;
    if (room.broadcastT >= BROADCAST_MS) {
      room.broadcastT = 0;
      sendState(room);
      if (room.foodAdded.length || room.foodRemoved.length) {
        const removedIds = new Set(room.foodRemoved);
        const additions = room.foodAdded.filter(f => !removedIds.has(f.id));
        broadcast(room, { type: 'food_delta', add: additions, remove: room.foodRemoved });
        room.foodAdded = []; room.foodRemoved = [];
      }
    }
  }
}, BOT_TICK_MS);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hungry Snake authoritative-world server listening on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/game`);
});

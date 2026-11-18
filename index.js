// Lift Run - authoritative multiplayer server (rooms of up to 20 players)
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const path = require('path');
['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png'].forEach((f) =>
  app.get('/' + f, (q, r) => r.sendFile(path.join(__dirname, f))));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (q, r) => r.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const MAX = 20, WORLD = 1400, LANES = 3, TICK = 50;
const COLORS = ['#ff5a4f', '#ffc83d', '#4fe3b0', '#5aa9ff', '#c58bff', '#ff8fd0', '#9be564', '#ffa94d'];
const rooms = new Map();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sk = (v) => clamp(v | 0, 0, 5);
const cleanSkills = (s = {}) => ({ speed: sk(s.speed), jump: sk(s.jump), rescue: sk(s.rescue), shield: sk(s.shield), stealth: sk(s.stealth) });

function newRoom() {
  const id = 'r' + Math.random().toString(36).slice(2, 7);
  const r = { id, lvl: 1, players: new Map(), mon: { x: 600, l: 1, stun: 0, sw: 0, dir: 1, roam: 0 }, liftT: 0, wipeT: 0 };
  rooms.set(id, r);
  return r;
}
function pickRoom() {
  for (const r of rooms.values()) if (r.players.size < MAX) return r;
  return newRoom();
}
function resetLevel(r, lvl) {
  r.lvl = lvl; r.liftT = 0; r.wipeT = 0;
  r.mon = { x: 500 + Math.random() * 400, l: (Math.random() * LANES) | 0, stun: 0, sw: 0, dir: 1, roam: 0 };
  for (const p of r.players.values()) {
    p.x = 20 + Math.random() * 40; p.l = (Math.random() * LANES) | 0; p.s = 0; p.inv = 2; p.rv = 0; p.dx = 0;
  }
  io.to(r.id).emit('level', lvl);
}

io.on('connection', (socket) => {
  let room = null, me = null;
  socket.on('join', (data = {}) => {
    if (room) return;
    room = pickRoom();
    me = {
      id: socket.id, socket, name: String(data.name || 'لاعب').slice(0, 12),
      color: COLORS[(Math.random() * COLORS.length) | 0], x: 30, l: (Math.random() * LANES) | 0,
      s: 0, dx: 0, laneAt: 0, inv: 2, rv: 0, skills: cleanSkills(data.skills), shieldAt: 0
    };
    room.players.set(socket.id, me);
    socket.join(room.id);
    socket.emit('joined', { id: socket.id, world: WORLD, lanes: LANES, lvl: room.lvl });
  });
  socket.on('input', (d) => { if (me) me.dx = clamp(Number(d && d.dx) || 0, -1, 1); });
  socket.on('lane', (d) => {
    if (!me || me.s !== 0) return;
    const now = Date.now();
    if (now < me.laneAt) return;
    const dir = Number(d && d.d) > 0 ? 1 : -1;
    me.l = clamp(me.l + dir, 0, LANES - 1);
    me.laneAt = now + 900 - 120 * me.skills.jump;
  });
  socket.on('skills', (s) => { if (me) me.skills = cleanSkills(s); });
  socket.on('disconnect', () => {
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(room.id);
  });
});

function step(r, dt) {
  const now = Date.now();
  const list = [...r.players.values()];
  // movement
  for (const p of list) {
    if (p.inv > 0) p.inv -= dt;
    if (p.s !== 0) continue;
    p.x = clamp(p.x + p.dx * (110 + 14 * p.skills.speed) * dt, 0, WORLD);
    if (p.x >= WORLD - 20) { p.s = 2; p.x = WORLD - 10; p.socket.emit('evt', { t: 'lift' }); }
  }
  // monster
  const m = r.mon;
  if (m.stun > 0) m.stun -= dt;
  else {
    let target = null, best = 1e9;
    for (const p of list) {
      if (p.s !== 0) continue;
      const range = 650 - 90 * p.skills.stealth;
      const d = Math.abs(p.x - m.x) + Math.abs(p.l - m.l) * 120;
      if (d < range && d < best) { best = d; target = p; }
    }
    const speed = Math.min(70 + 9 * r.lvl, 190);
    m.sw -= dt;
    if (target) {
      const dir = Math.sign(target.x - m.x);
      if (Math.abs(target.x - m.x) > 4) m.x += dir * speed * dt;
      if (target.l !== m.l && m.sw <= 0) { m.l += Math.sign(target.l - m.l); m.sw = 1.2; }
    } else {
      m.x += m.dir * 50 * dt;
      if (m.x < 150) m.dir = 1;
      if (m.x > WORLD - 150) m.dir = -1;
      m.roam -= dt;
      if (m.roam <= 0) { m.roam = 4; m.l = (Math.random() * LANES) | 0; }
    }
    m.x = clamp(m.x, 0, WORLD);
    for (const p of list) {
      if (p.s !== 0 || p.inv > 0 || p.l !== m.l || Math.abs(p.x - m.x) > 26) continue;
      if (p.skills.shield > 0 && now >= p.shieldAt) {
        p.shieldAt = now + (28000 - 3000 * p.skills.shield);
        p.inv = 1.5; m.stun = 1;
        p.socket.emit('evt', { t: 'shield' });
      } else {
        p.s = 1; p.rv = 0; p.dx = 0;
        p.socket.emit('evt', { t: 'down' });
      }
    }
  }
  // rescue
  for (const d of list) {
    if (d.s !== 1) continue;
    const a = list.find((p) => p.s === 0 && p.l === d.l && Math.abs(p.x - d.x) < 40);
    if (a) {
      d.rv += dt;
      if (d.rv >= 3 - 0.4 * a.skills.rescue) { d.s = 0; d.inv = 2; d.rv = 0; a.socket.emit('evt', { t: 'revive' }); }
    } else d.rv = Math.max(0, d.rv - dt);
  }
  // level flow
  const alive = list.filter((p) => p.s === 0).length;
  const lift = list.filter((p) => p.s === 2).length;
  if (lift > 0 && alive === 0) {
    r.liftT += dt;
    if (r.liftT >= 5) resetLevel(r, r.lvl + 1);
  } else r.liftT = 0;
  if (list.length > 0 && alive === 0 && lift === 0) {
    r.wipeT += dt;
    if (r.wipeT >= 5) resetLevel(r, r.lvl); // everyone caught: retry same level (endless, no game over)
  } else r.wipeT = 0;
}

setInterval(() => {
  for (const r of rooms.values()) {
    step(r, TICK / 1000);
    io.to(r.id).emit('snap', {
      lvl: r.lvl,
      m: [Math.round(r.mon.x), r.mon.l],
      p: [...r.players.values()].map((p) => [p.id, Math.round(p.x), p.l, p.s, p.inv > 0 ? 1 : 0, +(p.rv / 3).toFixed(2), p.name, p.color])
    });
  }
}, TICK);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Lift Run server on :' + PORT));

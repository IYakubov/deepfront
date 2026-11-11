// ═══════════════════════════════════════════════════════
//  WAR FRONT — combined-arms 3D browser battle
//  Express + Socket.io: 6-digit rooms, lobby, vehicles, tickets, damage authority
// ═══════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 30000 });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build')));
app.use('/vendor/three-addons', express.static(path.join(__dirname, 'node_modules/three/examples/jsm')));

const PORT = process.env.PORT || 3000;

// ── game constants (keep in sync with client) ──
const MAX_PLAYERS = 16;
const MATCH_TIME = 60 * 60;      // safety cap, seconds; normally a match ends when one side has no machines left
const HP = { tank: 120, jeep: 50, plane: 70, ship: 260, gunner: 40, icbm: 90, drone: 8 };
const MACHINES = 11;             // per team; machine-gun posts don't count
// base layout for team 0 (west); team 1 is mirrored in x
const LAYOUT = [
  ['tank', -1110, -10, Math.PI / 2], ['tank', -1110, 25, Math.PI / 2], ['tank', -1110, 60, Math.PI / 2],
  ['jeep', -1170, 150, Math.PI / 2], ['jeep', -1150, 165, Math.PI / 2], ['jeep', -1130, 180, Math.PI / 2],
  ['plane', -1430, -262, Math.PI / 2], ['plane', -1395, -238, Math.PI / 2],
  ['ship', -1260, 560, 0.25], ['ship', -1150, 590, 0.25],
  ['icbm', -1265, 110, Math.PI / 2], ['drone', -1185, 14, Math.PI / 2], ['drone', -1185, 22, Math.PI / 2],
  ['gunner', -985, 40, Math.PI / 2], ['gunner', -1010, 215, Math.PI / 2], ['gunner', -1150, 405, 0],
];

const rooms = new Map();

function newCode() {
  let c;
  do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(c));
  return c;
}
function cleanName(n) {
  n = String(n || '').replace(/[<>]/g, '').trim().slice(0, 14);
  return n || 'Боец' + Math.floor(Math.random() * 90 + 10);
}
function makeVehicles() {
  const vs = [];
  for (const team of [0, 1]) {
    const count = {};
    for (const [type, x, z, yaw] of LAYOUT) {
      count[type] = (count[type] || 0) + 1;
      const sp = team === 0 ? { x, z, yaw } : { x: -x, z, yaw: -yaw };
      vs.push({ vid: `${team}${type[0]}${count[type]}`, team, type, n: count[type], hp: HP[type], max: HP[type], alive: true, driver: null, ammo: type === 'icbm' ? 2 : 0, spent: false, spawn: sp, st: null, respawnAt: 0, lastHitBy: null, lastHitAt: 0 });
    }
  }
  return vs;
}
function publicRoom(r) {
  return {
    code: r.code, hostId: r.hostId, state: r.state, mode: 'team', seed: r.seed, tickets: r.tickets,
    timeLeft: r.endsAt && r.state === 'playing' ? Math.max(0, r.endsAt - Date.now()) : null,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, vid: p.vid, kills: p.kills, deaths: p.deaths, dmg: p.dmg })),
    vehicles: r.vehicles.map(v => ({ vid: v.vid, team: v.team, type: v.type, n: v.n, hp: v.hp, max: v.max, alive: v.alive, ammo: v.ammo, spent: v.spent, driver: v.driver, spawn: v.spawn, st: v.st, }))
  };
}
function countMachines(r) { r.tickets = [0, 1].map(t => r.vehicles.filter(v => v.team === t && v.alive && !v.spent && v.type !== 'gunner' && v.type !== 'drone').length); }
function broadcastRoom(r) { io.to(r.code).emit('room', publicRoom(r)); }
function teamCount(r, t) { let n = 0; for (const p of r.players.values()) if (p.team === t) n++; return n; }
function rebalance(r) {
  const a = teamCount(r, 0), b = teamCount(r, 1);
  if (Math.abs(a - b) <= 1) return;
  const from = a > b ? 0 : 1;
  const mover = [...r.players.values()].reverse().find(p => p.team === from);
  if (mover) mover.team = 1 - from;
}

function startMatch(r) {
  clearInterval(r.tick);
  r.state = 'playing';
  r.seed = Math.floor(Math.random() * 1e9);
  r.tickets = [MACHINES, MACHINES];
  r.vehicles = makeVehicles();
  for (const p of r.players.values()) { p.kills = 0; p.deaths = 0; p.dmg = 0; p.vid = null; }
  r.endsAt = Date.now() + 3000 + MATCH_TIME * 1000;
  r.startAt = Date.now() + 3000;
  broadcastRoom(r);
  io.to(r.code).emit('matchStart', { startAt: 3000 });
  r.tick = setInterval(() => tick(r), 1000);
}
function tick(r) {
  if (r.state !== 'playing') return;
  const now = Date.now();
  if (now >= r.endsAt) endMatch(r);
}
function endMatch(r) {
  if (r.state !== 'playing') return;
  clearInterval(r.tick);
  r.state = 'ended';
  const winner = r.tickets[0] === r.tickets[1] ? -1 : r.tickets[0] > r.tickets[1] ? 0 : 1;
  io.to(r.code).emit('matchEnd', { winner, tickets: r.tickets });
  broadcastRoom(r);
}
function destroyVehicle(r, v, by, how) {
  if (!v.alive) return;
  v.alive = false; v.hp = 0;
  countMachines(r);
  const driver = v.driver && r.players.get(v.driver);
  if (driver) { driver.deaths++; driver.vid = null; }
  // credit: the shooter, or whoever hit it last in the past 15 s
  let killer = by && r.players.get(by);
  if ((!killer || killer.team === v.team) && v.lastHitBy && Date.now() - v.lastHitAt < 15000) killer = r.players.get(v.lastHitBy);
  if (killer && killer.team !== v.team) killer.kills++;
  io.to(r.code).emit('vdead', { vid: v.vid, by: killer ? killer.id : null, driver: v.driver, how: how || '' });
  v.driver = null;
  broadcastRoom(r);
  if (r.tickets[v.team] <= 0) setTimeout(() => endMatch(r), 1500);
}
function damage(r, v, dmg, by, pt, kind) {
  if (!v.alive || r.state !== 'playing') return;
  const real = Math.min(dmg, v.hp);
  v.hp -= real;
  const sh = by && r.players.get(by);
  if (sh && sh.team !== v.team) { sh.dmg += real; v.lastHitBy = sh.id; v.lastHitAt = Date.now(); }
  io.to(r.code).emit('dmg', { vid: v.vid, by, dmg: real, hp: v.hp, pt, kind });
  if (v.hp <= 0) destroyVehicle(r, v, by, kind);
}

io.on('connection', socket => {
  let room = null;
  const me = () => room && room.players.get(socket.id);
  const myVehicle = () => { const p = me(); return p && p.vid ? room.vehicles.find(v => v.vid === p.vid) : null; };

  function attach(r, name) {
    room = r;
    socket.join(r.code);
    const team = teamCount(r, 0) <= teamCount(r, 1) ? 0 : 1;
    r.players.set(socket.id, { id: socket.id, name: cleanName(name), team, vid: null, kills: 0, deaths: 0, dmg: 0 });
  }

  socket.on('create', (d, cb) => {
    if (room) return cb && cb({ ok: false, err: 'Вы уже в комнате' });
    const code = newCode();
    const r = { code, hostId: socket.id, players: new Map(), state: 'lobby', seed: Math.floor(Math.random() * 1e9), tickets: [MACHINES, MACHINES], vehicles: makeVehicles(), endsAt: null };
    rooms.set(code, r);
    attach(r, d && d.name);
    cb && cb({ ok: true, code, id: socket.id });
    broadcastRoom(r);
  });
  socket.on('join', (d, cb) => {
    const code = String((d && d.code) || '').replace(/\D/g, '');
    const r = rooms.get(code);
    if (!r) return cb && cb({ ok: false, err: 'Нет игры с кодом ' + code });
    if (r.players.size >= MAX_PLAYERS) return cb && cb({ ok: false, err: 'Комната заполнена' });
    if (room) return cb && cb({ ok: false, err: 'Вы уже в комнате' });
    attach(r, d && d.name);
    cb && cb({ ok: true, code, id: socket.id });
    broadcastRoom(r);
    if (r.state === 'playing') socket.emit('lateJoin', {});
  });
  socket.on('setMode', () => {});
  socket.on('setTeam', t => {
    if (!room || room.state === 'playing') return;
    const p = me();
    if (p) { p.team = t ? 1 : 0; broadcastRoom(room); }
  });
  socket.on('start', () => {
    if (!room || room.hostId !== socket.id || room.state === 'playing') return;
    startMatch(room);
  });
  socket.on('toLobby', () => {
    if (!room || room.hostId !== socket.id) return;
    clearInterval(room.tick);
    room.state = 'lobby';
    for (const p of room.players.values()) p.vid = null;
    broadcastRoom(room);
    io.to(room.code).emit('lobby');
  });

  // ── vehicles: get in, get out ──
  socket.on('enter', (vid, cb) => {
    const p = me();
    if (!p || !room || room.state !== 'playing') return cb && cb({ ok: false });
    const v = room.vehicles.find(x => x.vid === vid);
    if (!v || !v.alive || v.team !== p.team) return cb && cb({ ok: false, err: 'Недоступно' });
    if (v.driver && v.driver !== p.id) return cb && cb({ ok: false, err: 'Занято' });
    const old = myVehicle(); if (old && old !== v) old.driver = null;
    v.driver = p.id; p.vid = v.vid;
    cb && cb({ ok: true, st: v.st });
    broadcastRoom(room);
  });
  socket.on('exit', () => {
    const p = me(), v = myVehicle();
    if (!p) return;
    if (v) v.driver = null;
    p.vid = null;
    broadcastRoom(room);
  });
  // own vehicle state: stored (for empty vehicles / late joiners) and relayed
  socket.on('st', s => {
    const v = myVehicle();
    if (!v || !v.alive || !Array.isArray(s)) return;
    v.st = s.slice(0, 13);
    socket.to(room.code).volatile.emit('st', v.vid, v.st);
  });
  // shooter reports a hit; server owns hp
  socket.on('hit', h => {
    if (!room || room.state !== 'playing' || !h) return;
    const p = me(), v = room.vehicles.find(x => x.vid === h.vid);
    if (!p || !v || v.team === p.team || Date.now() < room.startAt) return;
    const now = Date.now();
    p.hits = (p.hits || []).filter(t => now - t < 1000);
    if (p.hits.length >= 18) return;
    p.hits.push(now);
    const dmg = Math.max(1, Math.min(h.k === 'icbm' ? 300 : 95, Math.round(Number(h.dmg) || 0)));
    const pt = Array.isArray(h.pt) ? h.pt.slice(0, 3).map(Number) : null;
    damage(room, v, dmg, p.id, pt, String(h.k || '').slice(0, 8));
  });
  // own vehicle hit by an enemy SAM (simulated on the victim's client)
  socket.on('samhit', () => {
    const v = myVehicle(), now = Date.now();
    if (!v || v.type !== 'plane' || now - (v.lastSam || 0) < 400) return;
    v.lastSam = now;
    damage(room, v, 40, null, null, 'sam');
  });
  // crashed / sank / abandoned in the air
  socket.on('crash', how => {
    const v = myVehicle();
    if (!v || !room) return;
    destroyVehicle(room, v, null, String(how || 'crash').slice(0, 10));
  });
  // visuals of shots for everyone else
  socket.on('shot', s => {
    if (!room || !s) return;
    if (s.k === 'icbm') {
      // an SS-27 has 2 missiles; once both are gone (and the last one has landed) it no longer counts as a machine
      const v = myVehicle(), r = room;
      if (!v || v.type !== 'icbm' || v.ammo <= 0) return;
      v.ammo--;
      if (v.ammo <= 0) setTimeout(() => {
        if (!r.vehicles.includes(v) || r.state !== 'playing') return;
        v.spent = true; countMachines(r); broadcastRoom(r);
        io.to(r.code).emit('spent', { vid: v.vid });
        if (r.tickets[v.team] <= 0) setTimeout(() => endMatch(r), 1500);
      }, 27000);
      broadcastRoom(r);
    }
    socket.to(room.code).emit('shot', socket.id, s);
  });
  socket.on('missile', m => { if (room && m) socket.to(room.code).emit('missile', socket.id, m); });
  socket.on('mboom', m => { if (room && m) socket.to(room.code).emit('mboom', socket.id, m); });
  socket.on('flare', () => { if (room) io.to(room.code).emit('flare', socket.id); });

  socket.on('chat', t => {
    if (!room) return;
    const p = me();
    t = String(t || '').replace(/[<>]/g, '').slice(0, 80);
    if (p && t) io.to(room.code).emit('chat', { name: p.name, team: p.team, text: t });
  });
  socket.on('disconnect', () => {
    if (!room) return;
    const r = room, p = me();
    const v = myVehicle(); if (v) v.driver = null;
    r.players.delete(socket.id);
    if (r.players.size === 0) { clearInterval(r.tick); rooms.delete(r.code); return; }
    if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;
    if (r.state === 'lobby') rebalance(r);
    io.to(r.code).emit('left', { id: socket.id, name: p ? p.name : '' });
    broadcastRoom(r);
  });
});

server.listen(PORT, () => console.log('WAR FRONT running on http://localhost:' + PORT));

// ═══════════════════════════════════════════════════════
//  WAR FRONT — combined-arms 3D browser battle
//  Express + Socket.io: 6-digit rooms, lobby, vehicles, tickets, damage authority
// ═══════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 30000 });

// models, textures and sounds are cached by the browser (the game asks for them with a version number)
app.use('/models', express.static(path.join(__dirname, 'public/models'), { maxAge: '30d', immutable: true }));
app.use('/audio', express.static(path.join(__dirname, 'public/audio'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build'), { maxAge: '7d' }));
app.use('/vendor/three-addons', express.static(path.join(__dirname, 'node_modules/three/examples/jsm'), { maxAge: '7d' }));

const PORT = process.env.PORT || 3000;

// ── game constants (keep in sync with client) ──
const MAX_PLAYERS = 16;
const MATCH_TIME = 60 * 60;      // safety cap, seconds; normally a match ends when one side has no machines left
const HP = { tank: 120, jeep: 50, plane: 70, ship: 260, gunner: 40, icbm: 90, drone: 8, soldier: 30, moto: 35 };
const MACHINES = 15;             // per team; machine-gun posts, drones and foot soldiers don't count
const NOT_MACHINE = new Set(['gunner', 'drone', 'soldier']);
const PFX = { soldier: 'a' };     // vid prefix (ship already uses 's')
const SKIN_HP = { harley: 45, b2: 130 };   // the Harley survives one shotgun blast (a moto takes 35)
// repair hangar per base (team 0; team 1 mirrored in x): one machine at a time, 60 s, can be destroyed
const HANGAR = { x: -1195, z: -75, hx: 18, hz: 15, hp: 120 };   // as tough as a tank
const REPAIR_T = 60;
const REPAIRABLE = new Set(['tank', 'jeep', 'plane', 'moto']);
// base layout for team 0 (west); team 1 is mirrored in x
const LAYOUT = [
  ['tank', -1110, -10, Math.PI / 2], ['tank', -1110, 25, Math.PI / 2], ['tank', -1110, 60, Math.PI / 2],
  ['tank', -1070, 5, Math.PI / 2], ['tank', -1070, 45, Math.PI / 2],
  ['jeep', -1170, 150, Math.PI / 2], ['jeep', -1150, 165, Math.PI / 2], ['jeep', -1130, 180, Math.PI / 2],
  ['jeep', -1110, 200, Math.PI / 2, 'l9'],              // Li Auto L9 with a roof machine gun
  // aircraft on the three arms of the E-shaped apron south of the runway, noses towards the runway
  ['plane', -1170, -345, 0], ['plane', -1050, -345, 0],
  ['plane', -1110, -345, 0, 'b2'],                      // B-2 Spirit: 80 bombs, invisible to ПВО
  ['ship', -1260, 560, 0.25], ['ship', -1150, 590, 0.25],
  ['drone', -1185, 14, Math.PI / 2], ['drone', -1185, 22, Math.PI / 2],
  ['moto', -1235, 75, Math.PI / 2], ['moto', -1235, 90, Math.PI / 2],
  ['moto', -1235, 105, Math.PI / 2, 'harley'],          // the biker on the Harley with a pump shotgun (no sidecar)
  ['gunner', -985, 40, Math.PI / 2], ['gunner', -1010, 215, Math.PI / 2], ['gunner', -1150, 405, 0],
];

const MAPS = ['valley', 'ice', 'storm', 'mars'];       // Долина, Ледяной остров, Ночной шторм (no ships)
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
// Ледяной остров: the blue airfield is on the south side of its base and its harbour further south
function iceBlueSpot(type, x, z) {
  if (type === 'plane') return 120 - z;
  if (type === 'ship') return z + 260;
  if (type === 'gunner' && z > 300) return 490;          // the coastal gun, clear of the runway
  return z;
}
function makeVehicles(map) {
  const vs = [];
  for (const team of [0, 1]) {
    const count = {};
    for (const [type, x, z, yaw, skin] of LAYOUT) {
      if ((map === 'storm' || map === 'mars') && type === 'ship') continue;
      if (map === 'mars' && skin === 'b2') continue;          // no B-2 on Mars
      const ck = skin || type;
      count[ck] = (count[ck] || 0) + 1;
      const isle = map === 'ice' || map === 'storm';
      // blue mirrors red in x; on the island maps its airfield is also mirrored in z (planes then face the other way)
      const sp = team === 0 ? { x, z, yaw } : { x: -x, z: isle ? iceBlueSpot(type, x, z) : z, yaw: isle && type === 'plane' ? Math.PI + yaw : -yaw };
      vs.push({ vid: `${team}${skin === 'harley' ? 'h' : skin === 'b2' ? 'b' : skin ? 'l' : PFX[type] || type[0]}${count[ck]}`, team, type, skin: skin || null, n: count[ck], hp: SKIN_HP[skin] || HP[type], max: SKIN_HP[skin] || HP[type], alive: true, driver: null, ammo: type === 'icbm' ? 2 : 0, spent: false, spawn: sp, st: null, respawnAt: 0, lastHitBy: null, lastHitAt: 0 });
    }
  }
  return vs;
}
function publicRoom(r) {
  return {
    code: r.code, hostId: r.hostId, state: r.state, mode: 'team', map: r.map || 'valley', seed: r.seed, tickets: r.tickets,
    timeLeft: r.endsAt && r.state === 'playing' ? Math.max(0, r.endsAt - Date.now()) : null,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, away: !!p.away, vid: p.vid, kills: p.kills, deaths: p.deaths, dmg: Math.round(p.dmg) })),
    vehicles: r.vehicles.map(v => ({ vid: v.vid, team: v.team, type: v.type, skin: v.skin || null, n: v.n, hp: v.hp, max: v.max, alive: v.alive, ammo: v.ammo, spent: v.spent, driver: v.driver, gunner: v.gunner || null, auto: v.auto || null, spawn: v.spawn, st: v.st, })),
    hangars: (r.hangars || []).map(h => ({ team: h.team, hp: h.hp, max: h.max, busy: h.busy, prog: h.prog })),
  };
}
function countMachines(r) { r.tickets = [0, 1].map(t => r.vehicles.filter(v => v.team === t && v.alive && !v.spent && !NOT_MACHINE.has(v.type)).length); }
function makeHangars() { return [0, 1].map(team => ({ team, x: team ? -HANGAR.x : HANGAR.x, z: HANGAR.z, hx: HANGAR.hx, hz: HANGAR.hz, hp: HANGAR.hp, max: HANGAR.hp, busy: null, prog: 0, from: 0, t0: 0 })); }
const hangarState = h => ({ team: h.team, hp: h.hp, max: h.max, busy: h.busy, prog: h.prog });
// once a second: the hangar takes the machine that has been parked inside longest and repairs it over 60 s
function hangarTick(r) {
  const now = Date.now();
  for (const h of r.hangars || []) {
    if (h.hp <= 0) continue;
    const inside = v => v.team === h.team && v.alive && REPAIRABLE.has(v.type) && v.st && Math.abs(v.st[0] - h.x) < h.hx - 1 && Math.abs(v.st[2] - h.z) < h.hz - 1 && Math.abs(v.st[6] || 0) < 1.5;
    for (const v of r.vehicles) if (v.team === h.team) { if (inside(v)) v.inHangar = v.inHangar || now; else v.inHangar = 0; }
    let cur = h.busy && r.vehicles.find(v => v.vid === h.busy);
    if (cur && cur.noRepair > now) { cur = null; h.busy = null; h.prog = 0; io.to(r.code).emit('hangar', hangarState(h)); }
    if (cur && !cur.inHangar) { io.to(r.code).emit('repair', { vid: cur.vid, state: 'left', prog: h.prog }); cur = null; h.busy = null; h.prog = 0; io.to(r.code).emit('hangar', hangarState(h)); }
    if (!cur) {
      const next = r.vehicles.filter(v => v.team === h.team && v.inHangar && v.hp < v.max && !(v.noRepair > now)).sort((a, b) => a.inHangar - b.inHangar)[0];
      if (!next) continue;
      cur = next; h.busy = next.vid; h.from = next.hp; h.t0 = now; h.prog = 0;
      io.to(r.code).emit('repair', { vid: next.vid, state: 'start', prog: 0 });
    }
    h.prog = Math.min(1, (now - h.t0) / 1000 / REPAIR_T);
    cur.hp = Math.round(h.from + (cur.max - h.from) * h.prog);
    io.to(r.code).emit('heal', { vid: cur.vid, hp: cur.hp, prog: h.prog });
    if (h.prog >= 1) { cur.hp = cur.max; io.to(r.code).emit('repair', { vid: cur.vid, state: 'done', prog: 1 }); h.busy = null; h.prog = 0; }
    io.to(r.code).emit('hangar', hangarState(h));
  }
}
const ROOM_KEEP = 30 * 60 * 1000;                    // a room nobody is playing in stays open this long
const online = r => [...r.players.values()].filter(p => !p.away);
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (online(r).length) { r.lastActive = now; continue; }
    if (now - (r.lastActive || 0) > ROOM_KEEP) { clearInterval(r.tick); for (const p of r.players.values()) { clearTimeout(p.awayTimer); clearTimeout(p.seatTimer); } rooms.delete(r.code); console.log('room closed (idle 30 min)', r.code); }
  }
}, 60000);
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
  r.vehicles = makeVehicles(r.map);
  r.hangars = makeHangars();
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
  hangarTick(r);
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
  const gunner = v.gunner && r.players.get(v.gunner);
  if (gunner) { gunner.deaths++; gunner.vid = null; }
  // credit: the shooter, or whoever hit it last in the past 15 s
  let killer = by && r.players.get(by);
  if ((!killer || killer.team === v.team) && v.lastHitBy && Date.now() - v.lastHitAt < 15000) killer = r.players.get(v.lastHitBy);
  if (killer && killer.team !== v.team) killer.kills++;
  io.to(r.code).emit('vdead', { vid: v.vid, by: killer ? killer.id : null, driver: v.driver, gunner: v.gunner || null, how: how || '' });
  v.driver = null; v.gunner = null; v.auto = null;
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
  // hit while in the repair hangar: no repair for a minute, counted from the last hit
  if ((v.inHangar || (v.type === 'plane' && Date.now() - (v.fixAt || 0) < 2500)) && v.hp > 0) { v.noRepair = Date.now() + REPAIR_T * 1000; io.to(r.code).emit('repair', { vid: v.vid, state: 'hit', prog: 0 }); }
  if (v.hp <= 0) destroyVehicle(r, v, by, kind);
}

io.on('connection', socket => {
  let room = null;
  const me = () => room && room.players.get(socket.id);
  const myVehicle = () => { const p = me(); return p && p.vid ? room.vehicles.find(v => v.vid === p.vid) : null; };
  // free my seat (driver's, or the gunner's seat of a motorcycle)
  const leaveSeat = v => { if (!v) return; if (v.gunner === socket.id) { v.gunner = null; v.gst = null; } if (v.driver === socket.id) v.driver = null; };

  function attach(r, name) {
    room = r;
    socket.join(r.code);
    const team = teamCount(r, 0) <= teamCount(r, 1) ? 0 : 1;
    const token = crypto.randomBytes(12).toString('hex');
    r.players.set(socket.id, { id: socket.id, token, name: cleanName(name), team, vid: null, kills: 0, deaths: 0, dmg: 0 });
    return token;
  }
  // free the driver's / gunner's seat of a player who is not here (the autopilot car keeps going)
  function releaseSeats(r, id) {
    const p = r.players.get(id); if (!p) return;
    for (const v of r.vehicles) { if (v.gunner === id) { v.gunner = null; v.gst = null; } if (v.driver === id) v.driver = null; }
    p.vid = null;
    broadcastRoom(r);
  }
  // final removal of a player (left, or did not come back in time)
  function removePlayer(r, id) {
    const p = r.players.get(id); if (!p) return;
    for (const v of r.vehicles) {
      if (v.gunner === id) { v.gunner = null; v.gst = null; }
      if (v.driver === id) v.driver = null;
      if (v.auto === id) v.auto = null;                                   // the car stops where it is
    }
    clearTimeout(p.seatTimer); clearTimeout(p.awayTimer);
    r.players.delete(id);
    if (r.players.size === 0) return;                                     // the empty room is kept for 30 min (see sweep)
    if (r.hostId === id) r.hostId = (online(r)[0] || r.players.values().next().value).id;
    if (r.state === 'lobby') rebalance(r);
    io.to(r.code).emit('left', { id, name: p.name });
    broadcastRoom(r);
  }

  socket.onAny(() => { if (room) room.lastActive = Date.now(); });
  socket.on('create', (d, cb) => {
    if (room) return cb && cb({ ok: false, err: 'Вы уже в комнате' });
    const code = newCode();
    const r = { code, hostId: socket.id, players: new Map(), state: 'lobby', map: 'valley', seed: Math.floor(Math.random() * 1e9), tickets: [MACHINES, MACHINES], vehicles: makeVehicles(), hangars: makeHangars(), endsAt: null };
    r.lastActive = Date.now();
    rooms.set(code, r);
    const token = attach(r, d && d.name);
    cb && cb({ ok: true, code, id: socket.id, token });
    broadcastRoom(r);
  });
  socket.on('join', (d, cb) => {
    const code = String((d && d.code) || '').replace(/\D/g, '');
    const r = rooms.get(code);
    if (!r) return cb && cb({ ok: false, err: 'Нет игры с кодом ' + code });
    if (r.players.size >= MAX_PLAYERS) return cb && cb({ ok: false, err: 'Комната заполнена' });
    if (room) return cb && cb({ ok: false, err: 'Вы уже в комнате' });
    const token = attach(r, d && d.name);
    if (!r.players.has(r.hostId) || r.players.get(r.hostId).away) r.hostId = socket.id;
    cb && cb({ ok: true, code, id: socket.id, token });
    broadcastRoom(r);
    if (r.state === 'playing') socket.emit('lateJoin', {});
  });
  socket.on('setMode', () => {});
  // the host picks the map in the lobby
  socket.on('setMap', m => {
    if (!room || room.hostId !== socket.id || room.state === 'playing' || !MAPS.includes(m)) return;
    room.map = m; room.vehicles = makeVehicles(m); broadcastRoom(room);
  });
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
    let seat = 0;
    if (v.driver && v.driver !== p.id) {
      // a motorcycle has a second seat: the machine-gunner in the sidecar
      if (v.type !== 'moto' || v.skin === 'harley' || (v.gunner && v.gunner !== p.id)) return cb && cb({ ok: false, err: 'Занято' });
      seat = 1;
    }
    const old = myVehicle(); if (old && old !== v) leaveSeat(old);
    if (seat) v.gunner = p.id; else { if (v.gunner === p.id) { v.gunner = null; v.gst = null; } v.driver = p.id; v.auto = null; }   // taking over an autopilot car
    p.vid = v.vid;
    cb && cb({ ok: true, st: v.st, seat });
    broadcastRoom(room);
  });
  // a plane parked on its own airfield gets its hit points back over 30 s (the client asks once a second)
  socket.on('pfix', () => {
    const v = myVehicle(), now = Date.now();
    if (!v || v.type !== 'plane' || !v.alive || v.driver !== socket.id || room.state !== 'playing' || !v.st) return;
    const bx = v.team ? 1200 : -1200;
    const x = v.st[0], z = v.st[2];
    const rz = (room.map === 'ice' || room.map === 'storm') && v.team ? 370 : -250;
    const home = Math.hypot(x - bx, z - 60) < 290 || (Math.abs(x) > 990 && Math.sign(x) === (v.team ? 1 : -1) && Math.abs(z - rz) < 90);   // base or its runway
    if (!home || Math.abs(v.st[6] || 0) > 2) return;
    if (now - (v.fixAt || 0) < 850) return;
    v.fixAt = now;
    if (v.noRepair > now || v.hp >= v.max) return;
    v.hp = Math.min(v.max, v.hp + Math.ceil(v.max / 30));
    io.to(room.code).emit('heal', { vid: v.vid, hp: v.hp, prog: v.hp / v.max });
  });
  socket.on('exit', () => {
    const p = me(), v = myVehicle();
    if (!p) return;
    leaveSeat(v);
    p.vid = null;
    broadcastRoom(room);
  });
  // own vehicle state: stored (for empty vehicles / late joiners) and relayed
  socket.on('st', s => {
    const v = myVehicle();
    if (!v || !v.alive || !Array.isArray(s) || v.driver !== socket.id) return;
    v.st = s.slice(0, 13);
    if (v.gunner && v.gst) { v.st[7] = v.gst[0]; v.st[8] = v.gst[1]; v.st[9] = v.gst[2]; }   // the gunner aims and fires
    socket.to(room.code).volatile.emit('st', v.vid, v.st);
  });
  // autopilot: the driver hands the car to his own browser, which drives it and reports its state
  socket.on('autopilot', vid => {
    const p = me(), v = myVehicle();
    if (!p || !v || v.vid !== vid || !v.alive || v.driver !== socket.id || v.skin !== 'l9') return;
    v.auto = socket.id; v.driver = null; p.vid = null;
    broadcastRoom(room);
  });
  // strategic orders: free machines of my team move under my control (they only drive)
  socket.on('order', vids => {
    const p = me(); if (!p || !room || room.state !== 'playing' || !Array.isArray(vids)) return;
    for (const vid of vids.slice(0, 40)) {
      const v = room.vehicles.find(x => x.vid === vid);
      if (!v || !v.alive || v.team !== p.team || v.driver || (v.auto && v.auto !== socket.id) || !['tank', 'jeep', 'moto', 'icbm', 'plane', 'ship'].includes(v.type)) continue;
      v.auto = socket.id;
    }
    broadcastRoom(room);
  });
  socket.on('unorder', vid => {
    const v = room && room.vehicles.find(x => x.vid === vid);
    if (v && v.auto === socket.id) { v.auto = null; broadcastRoom(room); }
  });
  socket.on('ast', (vid, s) => {
    if (!room || !Array.isArray(s)) return;
    const v = room.vehicles.find(x => x.vid === vid);
    if (!v || !v.alive || v.auto !== socket.id) return;
    v.st = s.slice(0, 13);
    socket.to(room.code).volatile.emit('st', v.vid, v.st);
  });
  // motorcycle gunner: where the machine gun points and whether it fires
  socket.on('gst', s => {
    const v = myVehicle();
    if (!v || !v.alive || v.gunner !== socket.id || !Array.isArray(s)) return;
    v.gst = [Number(s[0]) || 0, Number(s[1]) || 0, s[2] ? 1 : 0];
    if (v.st) { v.st[7] = v.gst[0]; v.st[8] = v.gst[1]; v.st[9] = v.gst[2]; }
    socket.to(room.code).volatile.emit('gst', v.vid, v.gst);
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
  // an enemy repair hangar hit by a shell, rocket, bomb or drone
  socket.on('hhit', h => {
    if (!room || room.state !== 'playing' || !h) return;
    const p = me(), hg = (room.hangars || [])[h.team ? 1 : 0];
    if (!p || !hg || hg.team === p.team || hg.hp <= 0 || Date.now() < room.startAt) return;
    const now = Date.now();
    p.hh = (p.hh || []).filter(t => now - t < 1000); if (p.hh.length >= 10) return; p.hh.push(now);
    hg.hp = Math.max(0, hg.hp - Math.max(1, Math.min(120, Math.round(Number(h.dmg) || 0))));
    if (hg.hp <= 0) {
      const cur = hg.busy; hg.busy = null; hg.prog = 0;
      if (cur) io.to(room.code).emit('repair', { vid: cur, state: 'lost', prog: 0 });
      io.to(room.code).emit('hangarDown', { team: hg.team, by: p.id });
    }
    io.to(room.code).emit('hangar', hangarState(hg));
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
    if (!v || !room || v.driver !== socket.id) return;
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
  // a dropped connection or a reloaded page keeps the player: his seat for 90 s, himself (team, score) for 30 min
  socket.on('disconnect', () => {
    if (!room) return;
    const r = room, p = me(); if (!p) return;
    if (p.leaving) { removePlayer(r, socket.id); return; }
    p.away = Date.now();
    p.seatTimer = setTimeout(() => { if (r.players.get(p.id) === p && p.away) releaseSeats(r, p.id); }, 90000);
    p.awayTimer = setTimeout(() => { if (r.players.get(p.id) === p && p.away) removePlayer(r, p.id); }, ROOM_KEEP);
    if (r.hostId === p.id && online(r).length) r.hostId = online(r)[0].id;
    io.to(r.code).emit('away', { id: p.id, name: p.name });
    broadcastRoom(r);
  });
  socket.on('leaving', () => { const p = me(); if (p) p.leaving = true; });
  // the Leave button: out at once, seat freed
  socket.on('leave', (d, cb) => { if (room) { const r = room; removePlayer(r, socket.id); socket.leave(r.code); room = null; } cb && cb(); });
  socket.on('rejoin', (d, cb) => {
    const r = rooms.get(String((d && d.code) || ''));
    const p = r && [...r.players.values()].find(q => q.token && q.token === (d && d.token));
    if (!r || !p || room) return cb && cb({ ok: false });
    const old = p.id, nid = socket.id;
    clearTimeout(p.awayTimer); clearTimeout(p.seatTimer); p.away = 0;
    r.lastActive = Date.now();
    // the player now answers to the new connection's id
    r.players.delete(old); p.id = nid; r.players.set(nid, p);
    if (r.hostId === old || !r.players.has(r.hostId) || r.players.get(r.hostId).away) r.hostId = nid;
    for (const v of r.vehicles) { if (v.driver === old) v.driver = nid; if (v.gunner === old) v.gunner = nid; if (v.auto === old) v.auto = nid; if (v.lastHitBy === old) v.lastHitBy = nid; }
    room = r; socket.join(r.code);
    cb && cb({ ok: true, code: r.code, id: nid, old, state: r.state });
    io.to(r.code).emit('rejoined', { old, id: nid, name: p.name });
    broadcastRoom(r);
  });
});

server.listen(PORT, () => console.log('WAR FRONT running on http://localhost:' + PORT));

// ═══════════════════════════════════════════════════════
//  WAR FRONT — client
// ═══════════════════════════════════════════════════════
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const socket = io({ transports: ['websocket', 'polling'] });
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;

// ── map & bases (keep in sync with server) ──
const MAP_X = 1600, MAP_Z = 1100;
const BASE_Y = 6;
const BASES = [{ x: -1200, z: 60 }, { x: 1200, z: 60 }];
const BASE_R = 270;
const RWY = { x0: 1030, x1: 1480, z: -250, w: 30 };   // |x| range, mirrored per team
const PORT = [{ x: -1200, z: 520 }, { x: 1200, z: 520 }];
const SAMS = [[-1010, -110], [-1300, 330], [-1450, -60]];   // team 0, team 1 mirrored
const HP = { tank: 120, jeep: 50, plane: 70, ship: 260, gunner: 40, icbm: 90, drone: 8 };
const TYPE_NAME = { tank: 'Танк', jeep: 'Джип', plane: 'Самолёт', ship: 'Корабль', gunner: 'Пулемётчик', icbm: 'SS-27', drone: 'FPV-дрон' };
const TYPE_ICON = { tank: '▣', jeep: '◆', plane: '✈', ship: '⛴', gunner: '☗', icbm: '⇪', drone: '✣' };
const TEAM_COL = [0x6f7d40, 0x3f6283];
const TEAM_CSS = ['#a9b86a', '#7fa6c9'];
// collision / hit boxes in local space [hx, y0, y1, hz]
const HITBOX = { tank: [1.75, 0, 2.7, 3.5], jeep: [1.15, 0.2, 2.3, 2.3], plane: [7, -1.2, 2.6, 8.6], ship: [4, -2.5, 12, 23], gunner: [1.7, 0, 2.2, 1.7], icbm: [1.9, 0, 4.2, 11], drone: [0.7, -0.35, 0.5, 0.7] };
// damage per weapon against each vehicle type
const DMG = {
  shell: { tank: 30, jeep: 45, plane: 45, ship: 24, gunner: 40 },
  mg: { tank: 1, jeep: 3, plane: 4, ship: 1, gunner: 5 },
  cannon: { tank: 2, jeep: 5, plane: 5, ship: 2, gunner: 8 },
  rocket: { tank: 36, jeep: 45, plane: 40, ship: 30, gunner: 40 },
  navshell: { tank: 24, jeep: 40, plane: 30, ship: 22, gunner: 40 },
  navrocket: { tank: 34, jeep: 45, plane: 40, ship: 32, gunner: 40 },
  fpv: { tank: 65, jeep: 90, plane: 90, ship: 45, gunner: 90, icbm: 90, drone: 90 },
  bomb: { tank: 85, jeep: 90, plane: 90, ship: 90, gunner: 90 },
};

// ── state ──
let myId = null, room = null, inGame = false, worldSeed = null;
let mode = 'cmd';               // 'cmd' (top view over the base) | 'drive'
let myVid = null;               // vehicle I'm driving
let matchStartAt = 0;
const vehicles = new Map();     // vid -> entity
let world = null;
// ═══════════ MENU / LOBBY UI ═══════════
const nameIn = $('name');
try { nameIn.value = localStorage.getItem('wf_name') || ''; } catch (e) {}
const digitEls = [...document.querySelectorAll('#digits input')];
digitEls.forEach((el, i) => {
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '').slice(-1);
    if (el.value && i < 5) digitEls[i + 1].focus();
    if (digitCode().length === 6) $('joinBtn').focus();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !el.value && i > 0) digitEls[i - 1].focus();
    if (e.key === 'Enter') doJoin();
  });
  el.addEventListener('paste', e => {
    const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (t.length) { e.preventDefault(); t.split('').forEach((c, k) => digitEls[k] && (digitEls[k].value = c)); digitEls[Math.min(5, t.length)].focus(); }
  });
});
const digitCode = () => digitEls.map(e => e.value).join('');
const urlCode = (new URLSearchParams(location.search).get('code') || '').replace(/\D/g, '').slice(0, 6);
if (urlCode.length === 6) urlCode.split('').forEach((c, i) => digitEls[i].value = c);

function saveName() { try { localStorage.setItem('wf_name', nameIn.value.trim()); } catch (e) {} }
function showScreen(id) {
  for (const s of ['menu', 'lobby', 'pause', 'result']) $(s).classList.toggle('on', s === id);
}
$('createBtn').onclick = () => {
  audio.unlock(); saveName();
  socket.emit('create', { name: nameIn.value }, r => {
    if (!r.ok) return $('err').textContent = r.err;
    myId = r.id; history.replaceState(null, '', '?code=' + r.code); showScreen('lobby');
  });
};
function doJoin() {
  audio.unlock(); saveName();
  const code = digitCode();
  if (code.length !== 6) return $('err').textContent = 'Введите 6-значный код';
  socket.emit('join', { code, name: nameIn.value }, r => {
    if (!r.ok) return $('err').textContent = r.err;
    myId = r.id; history.replaceState(null, '', '?code=' + r.code); showScreen('lobby');
  });
}
$('joinBtn').onclick = doJoin;
$('copyBtn').onclick = () => {
  const link = location.origin + location.pathname + '?code=' + room.code;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
    () => { $('copyBtn').textContent = 'Ссылка скопирована'; setTimeout(() => $('copyBtn').textContent = 'Скопировать ссылку', 1500); },
    () => prompt('Ссылка-приглашение', link));
};
$('mTeam').onclick = () => socket.emit('setMode', 'team');
$('mFfa').onclick = () => socket.emit('setMode', 'ffa');
$('startBtn').onclick = () => { audio.unlock(); socket.emit('start'); };
$('leaveBtn').onclick = $('pLeaveBtn').onclick = $('resLeave').onclick = () => { location.href = location.pathname; };
$('resumeBtn').onclick = () => { showScreen(null); if (mode === 'drive') lockPointer(); };
$('pLobbyBtn').onclick = () => socket.emit('toLobby');
$('resLobby').onclick = () => socket.emit('toLobby');
$('resAgain').onclick = () => socket.emit('start');

function isHost() { return room && room.hostId === myId; }
function me() { return room && room.players.find(p => p.id === myId); }

function renderLobby() {
  if (!room) return;
  $('codebig').innerHTML = room.code.split('').map(c => `<b>${c}</b>`).join('');
  $('pcode').textContent = room.code;
  $('mTeam').classList.toggle('on', room.mode === 'team');
  $('mFfa').classList.toggle('on', room.mode === 'ffa');
  $('mTeam').disabled = $('mFfa').disabled = !isHost();
  const chip = p => `<div class="chip ${p.id === myId ? 'me' : ''}"><span>${esc(p.name)}</span>${p.id === room.hostId ? '<i>ХОСТ</i>' : ''}</div>`;
  if (room.mode === 'team') {
    const col = (t, nm, c) => `<div class="team"><h4 style="color:${c}">${nm}<button data-t="${t}">${me() && me().team === t ? 'ВАША КОМАНДА' : 'ВОЙТИ'}</button></h4>${room.players.filter(p => p.team === t).map(chip).join('')}</div>`;
    $('teams').innerHTML = col(0, 'АЛЬФА', 'var(--a)') + col(1, 'БРАВО', 'var(--b)');
    $('teams').querySelectorAll('button').forEach(b => b.onclick = () => socket.emit('setTeam', +b.dataset.t));
  } else {
    $('teams').innerHTML = `<div class="team"><h4>ВСЕ ПРОТИВ ВСЕХ · ${room.players.length}/10</h4>${room.players.map(chip).join('')}</div>`;
  }
  $('startBtn').disabled = !isHost();
  $('startBtn').textContent = isHost() ? (room.players.length < 2 ? 'Начать (тренировка)' : 'Начать бой') : 'Ожидание хоста…';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));



// ═══════════ AUDIO ═══════════
const audio = (() => {
  let ctx = null, master = null, muted = false, unlocked = false;
  const buffers = {};
  const music = new Audio('audio/tank_epic.mp3');
  music.loop = true; music.volume = 0.3;
  let engOsc, engOsc2, engGain, engFilter, noiseBuf = null, amb = null;
  async function load(name) {
    try {
      const r = await fetch('audio/' + name + '.mp3');
      buffers[name] = await ctx.decodeAudioData(await r.arrayBuffer());
    } catch (e) {}
  }
  function unlock() {
    if (unlocked) return; unlocked = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    ['shoot', 'hit', 'ricochet', 'energy', 'victory'].forEach(load);
    // electric motor + propeller hum
    engOsc = ctx.createOscillator(); engOsc.type = 'sawtooth'; engOsc.frequency.value = 50;
    engOsc2 = ctx.createOscillator(); engOsc2.type = 'triangle'; engOsc2.frequency.value = 25;
    engFilter = ctx.createBiquadFilter(); engFilter.type = 'lowpass'; engFilter.frequency.value = 260;
    engGain = ctx.createGain(); engGain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.6;
    engOsc.connect(engFilter); engOsc2.connect(g2); g2.connect(engFilter);
    engFilter.connect(engGain); engGain.connect(master);
    engOsc.start(); engOsc2.start();
    // deep-water ambience: low filtered noise
    const an = ctx.createBufferSource(); an.buffer = noiseBuf; an.loop = true;
    const af = ctx.createBiquadFilter(); af.type = 'lowpass'; af.frequency.value = 180;
    amb = ctx.createGain(); amb.gain.value = 0;
    an.connect(af); af.connect(amb); amb.connect(master); an.start();
    if (!muted) music.play().catch(() => {});
  }
  function play(name, vol = 1, pan = 0, rate = 1) {
    if (!ctx || muted || !buffers[name] || vol <= 0.01) return;
    const s = ctx.createBufferSource(); s.buffer = buffers[name]; s.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = vol;
    let node = s;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); s.connect(p); node = p; }
    node.connect(g); g.connect(master); s.start();
  }
  function panOf(pos) {
    const dx = pos.x - camera.position.x, dy = pos.y - camera.position.y, dz = pos.z - camera.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    camera.getWorldDirection(_a1);
    const right = _a2.set(-_a1.z, 0, _a1.x).normalize();
    return { d, pan: d > 0.1 ? (dx * right.x + dz * right.z) / d : 0 };
  }
  function at(name, pos, vol = 1, rate = 1, range = 1200) {
    if (!camera) return play(name, vol);
    const { d, pan } = panOf(pos);
    const att = Math.max(0, 1 - d / range) ** 1.4;
    play(name, vol * att, pan * 0.8, rate);
  }
  const ENG = { tank: [32, 60, 260, 520], jeep: [55, 140, 400, 1300], plane: [70, 190, 700, 2600], ship: [24, 34, 160, 300] };
  function engine(kind, load, speed) {
    if (!ctx) return;
    const t = ctx.currentTime, on = muted ? 0 : 1, e = ENG[kind] || ENG.tank;
    engGain.gain.setTargetAtTime(on * (0.025 + load * 0.03 + speed * 0.025), t, 0.25);
    engOsc.frequency.setTargetAtTime(e[0] + (e[1] - e[0]) * Math.max(load, speed), t, 0.3);
    engOsc2.frequency.setTargetAtTime((e[0] + (e[1] - e[0]) * Math.max(load, speed)) * 0.5, t, 0.3);
    engFilter.frequency.setTargetAtTime(e[2] + (e[3] - e[2]) * speed, t, 0.3);
    amb.gain.setTargetAtTime(on * 0.008, t, 0.5);
  }
  function engineOff() { if (ctx) { engGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); amb.gain.setTargetAtTime(0, ctx.currentTime, 0.5); } }
  function setMusicVol(v) { music.volume = v; }
  function toggle() {
    muted = !muted;
    $('mute').textContent = muted ? '✕' : '♪';
    if (muted) { music.pause(); engineOff(); } else if (unlocked) music.play().catch(() => {});
  }
  function tone(freq, dur = 0.06, vol = 0.06, type = 'square') {
    if (!ctx || muted) return;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = vol; g.gain.setTargetAtTime(0, ctx.currentTime + dur * 0.7, 0.01);
    o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur + 0.05);
  }
  // launch: filtered noise rush
  function whoosh(vol = 1) {
    if (!ctx || muted || !noiseBuf || vol <= 0.01) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(220, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.4); f.frequency.exponentialRampToValueAtTime(300, t + 1.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol * 1.3, t + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 1.6);
  }
  // explosion: deep thump + crack
  function boom(pos, vol = 1) {
    if (!ctx || muted) return;
    const { d, pan } = panOf(pos);
    const k = vol * Math.max(0, 1 - d / 1500) ** 1.2; if (k < 0.01) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.2);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7 * k, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    let node = g; o.connect(g);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan * 0.7)); g.connect(p); node = p; }
    node.connect(master); o.start(t); o.stop(t + 1.7);
    play('hit', 1.1 * k, pan * 0.6, 0.55);
  }
  return { unlock, play, at, engine, engineOff, setMusicVol, toggle, tone, whoosh, boom };
})();
$('mute').onclick = () => { audio.unlock(); audio.toggle(); };
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3();



// ═══════════ THREE SETUP ═══════════
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const SKY = new THREE.Color(0xb9c3c2);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 700, 3200);
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 7000);
camera.position.set(-1200, 600, 500); camera.lookAt(-1200, 0, 60);
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xdfe6e4, 0x4a4a3e, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
let shadowSize = 0;
function setShadowSize(s) {
  if (s === shadowSize) return; shadowSize = s;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 2400 });
  sun.shadow.camera.updateProjectionMatrix();
}
setShadowSize(140);
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
{
  const g = new THREE.SphereGeometry(5000, 24, 12);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x6f8ea6) }, bot: { value: SKY } },
    vertexShader: 'varying vec3 vp; void main(){ vp=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 vp; void main(){ float h=clamp(normalize(vp).y*2.0,0.,1.); gl_FragColor=vec4(mix(bot,top,h),1.); }'
  });
  const sky = new THREE.Mesh(g, m); sky.renderOrder = -1; scene.add(sky);
  sky.onBeforeRender = () => sky.position.copy(camera.position);
}
function placeSun(x, y, z) {
  sun.position.set(x + SUN_DIR.x * 900, y + SUN_DIR.y * 900, z + SUN_DIR.z * 900);
  sun.target.position.set(x, y, z);
}

const hud = $('hud'), hctx = hud.getContext('2d');
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const dpr = Math.min(devicePixelRatio, 2);
  hud.width = w * dpr; hud.height = h * dpr; hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

function fwd(h, p, out) { const c = Math.cos(p); return out.set(Math.sin(h) * c, Math.sin(p), Math.cos(h) * c); }
function wrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }

// ═══════════ WORLD GENERATION ═══════════
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeNoise(rand) {
  const p = new Uint8Array(512), v = new Float32Array(256);
  for (let i = 0; i < 256; i++) { p[i] = i; v[i] = rand(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const a = v[p[p[X] + Y]], b = v[p[p[X + 1] + Y]], c = v[p[p[X] + Y + 1]], d = v[p[p[X + 1] + Y + 1]];
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
let H = () => -150;

function camFade(mat, near, far) {
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCfWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 cfw = vec4(transformed,1.0);\n#ifdef USE_INSTANCING\ncfw = instanceMatrix * cfw;\n#endif\nvCfWorld = (modelMatrix * cfw).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCfWorld;')
      .replace('void main() {', `void main() {
  float cfd = distance(vCfWorld, cameraPosition);
  if (cfd < ${far.toFixed(1)}) {
    float cfa = smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, cfd);
    vec2 cfp = floor(mod(gl_FragCoord.xy, 4.0));
    float cft = (mod(cfp.x * 2.0 + cfp.y * 3.0 + cfp.x * cfp.y, 4.0) + 0.5) / 4.0;
    if (cfa < 0.98 && cft > cfa) discard;
  }`);
  };
  mat.customProgramCacheKey = () => 'cf' + near + '_' + far;
  return mat;
}
const waterUniforms = { uTime: { value: 0 } };
const coastZ = x => 440 + Math.sin(x * 0.0023) * 55 + Math.sin(x * 0.007 + 1) * 15;
const teamX = (team, x) => team === 0 ? x : -x;
const roadZ = x => 60 + Math.sin(x * 0.004) * 80;
const onBasePad = (x, z) => BASES.some(b => Math.hypot(x - b.x, z - b.z) < BASE_R + 15) || (Math.abs(x) > RWY.x0 - 50 && Math.abs(z - RWY.z) < RWY.w + 25);

function buildWorld(seed) {
  if (world) { scene.remove(world.group); world.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
  const rand = mulberry32(seed);
  const n1 = makeNoise(mulberry32(777)), n2 = makeNoise(mulberry32(778));   // terrain is the same every match
  const fbm = (x, z) => { let s = 0, a = 1, f = 1; for (let i = 0; i < 5; i++) { s += (n1(x * f, z * f) - .5) * a; a *= .5; f *= 2.03; } return s; };
  H = (x, z) => {
    // rolling hills, flattened at both bases and their runways
    let h = BASE_Y + Math.max(-3, fbm(x * 0.0024 + 3, z * 0.0024 - 2) * 85 + 10);
    let flat = 0;
    for (const b of BASES) flat = Math.max(flat, 1 - smooth(BASE_R - 40, BASE_R + 120, Math.hypot(x - b.x, z - b.z)));
    const ax = Math.abs(x);
    if (ax > RWY.x0 - 60 && ax < RWY.x1 + 60) flat = Math.max(flat, 1 - smooth(RWY.w, RWY.w + 70, Math.abs(z - RWY.z)));
    h = lerp(h, BASE_Y, flat);
    // mountains along the north edge and the sides
    if (z < -MAP_Z + 220) h += Math.min(240, (-MAP_Z + 220 - z) * 1.1) + (n2(x * 0.01, z * 0.01) - .5) * 40 * smooth(-MAP_Z + 220, -MAP_Z, z);
    if (ax > MAP_X - 140) h += Math.min(240, (ax - MAP_X + 140) * 1.1);
    // coast and sea to the south
    const cz = coastZ(x);
    if (z > cz - 70) h = lerp(h, 1.2, smooth(cz - 70, cz, z));
    if (z > cz) h = Math.max(-26, 1.2 - (z - cz) * 0.17);
    return h + (n2(x * 0.05, z * 0.05) - .5) * 0.6 * (1 - flat);
  };

  const group = new THREE.Group();
  const boxes = [];             // axis-aligned solid blocks {x,z,hx,hz,y0,y1}
  const dummy = new THREE.Object3D();
  const addBox = (x, z, hx, hz, y1) => boxes.push({ x, z, hx, hz, y0: -5, y1 });

  // ── terrain ──
  const SX = MAP_X * 2 + 900, SZ = MAP_Z * 2 + 900;
  let geo = new THREE.PlaneGeometry(SX, SZ, 320, 220);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, H(pos.getX(i), pos.getZ(i)));
  geo = geo.toNonIndexed(); geo.computeVertexNormals();
  const p2 = geo.attributes.position, nrm = geo.attributes.normal;
  const cols = new Float32Array(p2.count * 3);
  const cG1 = new THREE.Color(0x7d8a4c), cG2 = new THREE.Color(0x96904f), cDirt = new THREE.Color(0x8a7653), cRock = new THREE.Color(0x77736a),
        cSand = new THREE.Color(0xcbb98a), cWet = new THREE.Color(0x8d8466), cBase = new THREE.Color(0x8e8c84), cSnow = new THREE.Color(0xe8ebe6), c = new THREE.Color();
  for (let i = 0; i < p2.count; i += 3) {
    const x = (p2.getX(i) + p2.getX(i + 1) + p2.getX(i + 2)) / 3, y = (p2.getY(i) + p2.getY(i + 1) + p2.getY(i + 2)) / 3, z = (p2.getZ(i) + p2.getZ(i + 1) + p2.getZ(i + 2)) / 3;
    const slope = 1 - nrm.getY(i);
    c.copy(cG1).lerp(cG2, n2(x * 0.004, z * 0.004));
    if (n2(x * 0.02 + 9, z * 0.02) > 0.7) c.lerp(cDirt, 0.6);
    if (slope > 0.18) c.lerp(cRock, Math.min(1, (slope - 0.18) * 3));
    if (y > 200) c.lerp(cSnow, smooth(200, 270, y) * 0.85);
    for (const b of BASES) if (Math.hypot(x - b.x, z - b.z) < BASE_R) c.lerp(cBase, 0.65);
    if (y < 3) c.lerp(cSand, smooth(3, 1, y));
    if (y < 0) c.copy(cWet);
    c.multiplyScalar(0.94 + rand() * 0.1);
    for (let k = 0; k < 3; k++) { cols[(i + k) * 3] = c.r; cols[(i + k) * 3 + 1] = c.g; cols[(i + k) * 3 + 2] = c.b; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const detailTex = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d');
    g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5200; i++) { const v = 150 + Math.random() * 105 | 0; g.fillStyle = `rgba(${v},${v},${v},${0.25 + Math.random() * 0.5})`; const r = 0.6 + Math.random() * 2.2; g.fillRect(Math.random() * 256, Math.random() * 256, r, r * (0.6 + Math.random())); }
    for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(120,120,120,${0.1 + Math.random() * 0.12})`; g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 6 + Math.random() * 16, 0, TAU); g.fill(); }
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(SX / 14, SZ / 14); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  })();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTex, roughness: 1, flatShading: true }));
  terrain.receiveShadow = true;
  group.add(terrain);

  // ── sea ──
  const wgeo = new THREE.PlaneGeometry(SX + 2000, 2400, 160, 70); wgeo.rotateX(-Math.PI / 2); wgeo.translate(0, 0, MAP_Z);
  const wmat = new THREE.MeshStandardMaterial({ color: 0x3f6d78, roughness: .35, metalness: .15, flatShading: true, transparent: true, opacity: .9 });
  wmat.onBeforeCompile = sh => {
    sh.uniforms.uTime = waterUniforms.uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.y += sin(position.x * 0.04 + uTime * 0.9) * 0.45 + cos(position.z * 0.055 + uTime * 1.1) * 0.4;`);
  };
  const water = new THREE.Mesh(wgeo, wmat); water.receiveShadow = true; group.add(water);

  // ── materials ──
  const M = (color, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: .85, flatShading: true }, extra));
  const mWall = M(0x9a9384), mWall2 = M(0x7f8a7a), mRoof = M(0x5b4a3e), mMetal = M(0x80878a, { metalness: .4, roughness: .55 }), mDark = M(0x3a3d3e),
        mConc = M(0xa29f96), mWood = M(0x6e5840), mRed = M(0x9a3a2e), mWhite = M(0xe2e0d8), mGlass = M(0x2a3a44, { metalness: .5, roughness: .2 });
  const mk = (geo, mat, x, y, z, ry = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = true; m.receiveShadow = true; group.add(m); return m; };
  const PR = { win: [], crate: [], barrel: [], lamp: [], bulb: [], rl: [], pole: [], bush: [], rock: [], hay: [], cloud: [] };
  const winBox = (x, z, w, d, y) => {
    for (let a = -w / 2 + 1.8; a <= w / 2 - 1.8 + 0.01; a += 3.4) { PR.win.push([x + a, y, z + d / 2 + 0.03, 0]); PR.win.push([x + a, y, z - d / 2 - 0.03, 0]); }
    for (let a = -d / 2 + 1.8; a <= d / 2 - 1.8 + 0.01; a += 3.4) { PR.win.push([x + w / 2 + 0.03, y, z + a, Math.PI / 2]); PR.win.push([x - w / 2 - 0.03, y, z + a, Math.PI / 2]); }
  };
  const tentGeo = (() => { const sh = new THREE.Shape(); sh.moveTo(-3, 0); sh.lineTo(3, 0); sh.lineTo(0, 3); sh.closePath(); const g = new THREE.ExtrudeGeometry(sh, { depth: 7, bevelEnabled: false }); g.translate(0, 0, -3.5); return g; })();
  const block = (x, z, w, h, d, mat, y = null) => { const y0 = y ?? H(x, z) - 0.5; mk(new THREE.BoxGeometry(w, h, d), mat, x, y0 + h / 2, z); addBox(x, z, w / 2, d / 2, y0 + h); };

  // ── the two bases ──
  const rwTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 512;
    const g = cv.getContext('2d'); g.fillStyle = '#3c3e3f'; g.fillRect(0, 0, 64, 512);
    g.fillStyle = '#d8d6cc'; for (let y = 10; y < 512; y += 64) g.fillRect(29, y, 6, 36);
    g.fillRect(2, 0, 3, 512); g.fillRect(59, 0, 3, 512);
    const t = new THREE.CanvasTexture(cv); t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 6); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const flagTex = team => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 40; const g = cv.getContext('2d'); g.fillStyle = TEAM_CSS[team]; g.fillRect(0, 0, 64, 40); g.fillStyle = '#f3f1e8'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.fillText(team ? 'Б' : 'А', 32, 30); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const samSites = [];
  for (const team of [0, 1]) {
    const bx = BASES[team].x, bz = BASES[team].z, sx = team ? -1 : 1;   // sx: direction towards the map centre
    // runway
    const rl = RWY.x1 - RWY.x0 + 40;
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(RWY.w * 2, rl), new THREE.MeshStandardMaterial({ map: rwTex, roughness: .95, polygonOffset: true, polygonOffsetFactor: -2 }));
    rw.rotation.set(-Math.PI / 2, 0, Math.PI / 2); rw.position.set(teamX(team, (RWY.x0 + RWY.x1) / 2), BASE_Y + 0.05, RWY.z); rw.receiveShadow = true; group.add(rw);
    // taxiway to the base
    const tw = new THREE.Mesh(new THREE.PlaneGeometry(18, 200), new THREE.MeshStandardMaterial({ color: 0x55585a, roughness: .95, polygonOffset: true, polygonOffsetFactor: -2 }));
    tw.rotation.x = -Math.PI / 2; tw.position.set(bx - sx * 60, BASE_Y + 0.04, -130); tw.receiveShadow = true; group.add(tw);
    // hangars (open towards the runway)
    for (const hx of [-1330, -1210]) {
      const x = teamX(team, hx), z = -330;
      const hg = mk(new THREE.CylinderGeometry(20, 20, 40, 14, 1, true, 0, Math.PI), M(0x80878a, { metalness: .4, roughness: .55, side: THREE.DoubleSide }), x, BASE_Y, z); hg.rotation.set(0, 0, Math.PI / 2);
      addBox(x, z - 19, 20, 1.5, BASE_Y + 14); addBox(x, z + 19, 20, 1.5, BASE_Y + 14);
    }
    // control tower
    const tx = teamX(team, -1270), tz = -180;
    block(tx, tz, 8, 18, 8, mConc, BASE_Y);
    mk(new THREE.BoxGeometry(11, 4, 11), mGlass, tx, BASE_Y + 20, tz);
    mk(new THREE.BoxGeometry(12, 0.8, 12), mDark, tx, BASE_Y + 22.4, tz);
    const radar = mk(new THREE.BoxGeometry(5, 1.2, 0.3), mWhite, tx, BASE_Y + 24.5, tz);
    // HQ with the team flag
    block(bx - sx * 70, bz - 40, 34, 9, 22, mWall2, BASE_Y);
    mk(new THREE.BoxGeometry(36, 1, 24), mRoof, bx - sx * 70, BASE_Y + 9.5, bz - 40);
    mk(new THREE.CylinderGeometry(0.25, 0.25, 22, 6), mMetal, bx - sx * 40, BASE_Y + 11, bz - 60);
    const flag = mk(new THREE.PlaneGeometry(7, 4.4), new THREE.MeshStandardMaterial({ map: flagTex(team), side: THREE.DoubleSide, roughness: .9 }), bx - sx * 40 + 3.6, BASE_Y + 19.5, bz - 60);
    // barracks, fuel tanks, sandbag walls
    for (let i = 0; i < 3; i++) { block(bx - sx * 150, bz + 80 + i * 38, 14, 6, 30, mWall, BASE_Y); mk(new THREE.BoxGeometry(16, 1, 32), mRoof, bx - sx * 150, BASE_Y + 6.4, bz + 80 + i * 38); }
    for (let i = 0; i < 3; i++) { const fx = bx - sx * (40 + i * 18), fz = bz + 210; mk(new THREE.CylinderGeometry(7, 7, 10, 16), mWhite, fx, BASE_Y + 5, fz); addBox(fx, fz, 6, 6, BASE_Y + 10); }
    for (const [ox, oz, w, d] of [[150, -75, 4, 50], [150, 235, 4, 50], [20, 290, 60, 4]]) block(bx + sx * ox, bz + oz, w, 2.4, d, M(0xa08f6a), BASE_Y);
    // garage sheds for tanks / jeeps
    mk(new THREE.BoxGeometry(30, 0.6, 100), mRoof, bx + sx * 115, BASE_Y + 7, bz + 30);
    for (const oz of [-20, 80]) mk(new THREE.CylinderGeometry(0.4, 0.4, 7, 6), mMetal, bx + sx * 115, BASE_Y + 3.5, bz + oz);
    // pier and port buildings
    const px = PORT[team].x, cz = coastZ(px);
    block(px, cz + 50, 14, 3, 150, mConc, -1.5);
    for (let i = 0; i < 6; i++) mk(new THREE.CylinderGeometry(0.6, 0.6, 6, 6), mDark, px + 6, -1, cz + 0 + i * 25);
    block(px - sx * 40, cz - 30, 26, 10, 18, mWall2);
    mk(new THREE.BoxGeometry(2, 22, 2), M(0xc9a23a), px - sx * 18, H(px - sx * 18, cz - 10) + 11, cz - 10);   // crane
    mk(new THREE.BoxGeometry(2, 2, 26), M(0xc9a23a), px - sx * 18, H(px - sx * 18, cz - 10) + 22, cz + 2);
    // ── extra base detail ──
    winBox(bx - sx * 70, bz - 40, 34, 22, BASE_Y + 5.2);
    mk(new THREE.BoxGeometry(3, 4.5, 0.3), mDark, bx - sx * 70, BASE_Y + 2.2, bz - 28.9);                 // HQ door
    for (let i = 0; i < 3; i++) winBox(bx - sx * 150, bz + 80 + i * 38, 14, 30, BASE_Y + 3.4);
    for (const [ox, oz] of [[205, -150], [205, 255], [-225, 10]]) {                                       // watchtowers
      const tx2 = bx + sx * ox, tz2 = bz + oz, ty = H(tx2, tz2);
      for (const [a, b2] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) mk(new THREE.CylinderGeometry(0.18, 0.22, 9, 5), mWood, tx2 + a, ty + 4.5, tz2 + b2);
      mk(new THREE.BoxGeometry(4.4, 0.3, 4.4), mWood, tx2, ty + 9, tz2);
      for (const [a, b2, w2, d2] of [[0, 2.1, 4.4, 0.15], [0, -2.1, 4.4, 0.15], [2.1, 0, 0.15, 4.4], [-2.1, 0, 0.15, 4.4]]) mk(new THREE.BoxGeometry(w2, 1.1, d2), mWood, tx2 + a, ty + 9.7, tz2 + b2);
      mk(new THREE.ConeGeometry(3.6, 1.8, 4), mRoof, tx2, ty + 12.6, tz2, Math.PI / 4);
      for (const [a, b2] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) mk(new THREE.BoxGeometry(0.14, 2.6, 0.14), mWood, tx2 + a, ty + 10.5, tz2 + b2);
      mk(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: 0xfff2b0 }), tx2 + sx * 2.3, ty + 10.6, tz2);   // searchlight
      addBox(tx2, tz2, 2, 2, ty + 12);
    }
    for (let i = 0; i < 12; i++) PR.crate.push([bx - sx * (16 + rand() * 12), BASE_Y + 0.8 + (i > 7 ? 1.6 : 0), bz + 96 + rand() * 10, rand() * 0.6, 0.8 + rand() * 0.3]);
    addBox(bx - sx * 22, bz + 101, 8, 7, BASE_Y + 2);
    for (let i = 0; i < 10; i++) PR.barrel.push([bx - sx * (2 + rand() * 6), BASE_Y + 0.6, bz + 118 + rand() * 6, 0, 1]);
    addBox(bx - sx * 5, bz + 121, 4, 4, BASE_Y + 1.3);
    for (let i = 0; i < 5; i++) { mk(tentGeo, M(0x6f7350), bx - sx * (112 + i * 9), BASE_Y, bz - 120); addBox(bx - sx * (112 + i * 9), bz - 120, 3, 3.5, BASE_Y + 2.4); }
    for (let z = -30; z >= -190; z -= 40) { PR.lamp.push([bx - sx * 60 + 11, BASE_Y + 3.5, z, 0, 1]); PR.bulb.push([bx - sx * 60 + 11, BASE_Y + 7.1, z, 0, 1]); }
    for (const [ox, oz] of [[60, 0], [60, 120], [-30, 60], [-110, 30]]) { PR.lamp.push([bx + sx * ox, BASE_Y + 3.5, bz + oz, 0, 1]); PR.bulb.push([bx + sx * ox, BASE_Y + 7.1, bz + oz, 0, 1]); }
    for (let x = RWY.x0 - 15; x <= RWY.x1 + 15; x += 22) for (const dz of [-RWY.w - 1.5, RWY.w + 1.5]) PR.rl.push([teamX(team, x), BASE_Y + 0.3, RWY.z + dz, 0, 1]);
    mk(new THREE.CylinderGeometry(0.22, 0.4, 34, 6), mMetal, bx - sx * 100, BASE_Y + 17, bz - 78);        // radio mast
    for (let k = 1; k <= 3; k++) mk(new THREE.BoxGeometry(2.4, 0.12, 0.12), mMetal, bx - sx * 100, BASE_Y + 8 + k * 7, bz - 78);
    mk(new THREE.SphereGeometry(0.4, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff3020 }), bx - sx * 100, BASE_Y + 34.3, bz - 78);
    // windsock, fuel truck by the runway
    mk(new THREE.CylinderGeometry(0.08, 0.08, 6, 5), mMetal, teamX(team, -1050), BASE_Y + 3, RWY.z + 45);
    const sock = mk(new THREE.ConeGeometry(0.5, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0xe8642a, roughness: .9 }), teamX(team, -1050) + 1.2, BASE_Y + 5.8, RWY.z + 45); sock.rotation.z = -Math.PI / 2;
    { const fx = teamX(team, -1290), fz = -205;
      mk(new THREE.BoxGeometry(2.4, 1.0, 7), mDark, fx, BASE_Y + 0.9, fz); mk(new THREE.BoxGeometry(2.3, 1.8, 2), M(0x5d6640), fx, BASE_Y + 2.1, fz + 2.4);
      const tk = mk(new THREE.CylinderGeometry(1.1, 1.1, 4.4, 10), mWhite, fx, BASE_Y + 2.4, fz - 1.1); tk.rotation.x = Math.PI / 2; addBox(fx, fz, 1.5, 3.8, BASE_Y + 3.4); }
    // lighthouse at the port
    { const lx = PORT[team].x + sx * 70, lz = coastZ(lx) - 18, ly = H(lx, lz);
      for (let k = 0; k < 5; k++) mk(new THREE.CylinderGeometry(2.6 - k * 0.22, 2.8 - k * 0.22, 4.4, 10), k % 2 ? mRed : mWhite, lx, ly + 2.2 + k * 4.4, lz);
      mk(new THREE.CylinderGeometry(1.5, 1.5, 2.2, 8), mGlass, lx, ly + 23.1, lz); mk(new THREE.ConeGeometry(2, 1.8, 8), mRed, lx, ly + 25.1, lz);
      mk(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff6c8 }), lx, ly + 23.1, lz); addBox(lx, lz, 2.6, 2.6, ly + 24); }
    winBox(PORT[team].x - sx * 40, coastZ(PORT[team].x) - 30, 26, 18, H(PORT[team].x - sx * 40, coastZ(PORT[team].x) - 30) + 5);
    for (let i = 0; i < 8; i++) PR.crate.push([PORT[team].x - 3 + (i % 2) * 2.2, 2.4 + (i > 5 ? 1.7 : 0), coastZ(PORT[team].x) + 20 + (i >> 1) * 2.4, 0, 1]);
    // ПВО sites
    for (const [x0, z0] of SAMS) {
      const x = teamX(team, x0), z = z0, y = H(x, z);
      const g = new THREE.Group(); g.position.set(x, y, z); group.add(g);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(11, 13, 1.6, 10), mConc); pad.receiveShadow = true; g.add(pad);
      const base = new THREE.Mesh(new THREE.BoxGeometry(5, 2, 7.5), M(0x5d6640)); base.position.set(0, 1.8, 0); base.castShadow = true; g.add(base);
      const turn = new THREE.Group(); turn.position.set(0, 3, 0); g.add(turn);
      const rack = new THREE.Group(); rack.rotation.x = -0.7; turn.add(rack);
      for (let k = 0; k < 4; k++) { const tb = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 7), M(0x5d6640)); tb.position.set(k % 2 ? 0.65 : -0.65, (k < 2 ? 0.65 : -0.65) + 1, 1.2); tb.castShadow = true; rack.add(tb); }
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 7, 6), mDark); mast.position.set(6, 3.5, 0); g.add(mast);
      const rad = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2, 0.35), M(0x5d6640)); rad.position.set(6, 7.4, 0); g.add(rad);
      samSites.push({ team, x, z, y, g, turn, rad, top: new THREE.Vector3(x, y + 5, z), lockT: 0, cd: 0, spin: rand() * TAU });
      addBox(x, z, 4, 4, y + 5);
    }
    world_flags.push(flag); world_radars.push(radar);
  }

  // ── village in the middle, farms, forests ──
  { const cx = 30, cz = roadZ(30) - 34, cy = H(cx, cz) - 0.6;                                            // church
    block(cx, cz, 10, 9, 18, mWhite, cy); mk(new THREE.ConeGeometry(8.6, 5, 4), mRoof, cx, cy + 11.5, cz, Math.PI / 4).scale.set(0.62, 1, 1.1);
    block(cx, cz + 11, 5, 17, 5, mWhite, cy); mk(new THREE.ConeGeometry(3.8, 8, 4), mRed, cx, cy + 21, cz + 11, Math.PI / 4);
    winBox(cx, cz, 10, 18, cy + 5); }
  for (let i = 0, tries = 0; i < 30 && tries < 700; tries++) {
    const x = (rand() - .5) * 600, z = (rand() - .5) * 560 - 80;
    const y = H(x, z);
    if (Math.abs(z - roadZ(x)) < 15) continue;
    if (Math.abs(H(x + 8, z) - y) + Math.abs(H(x, z + 8) - y) > 3 || boxes.some(b => Math.abs(b.x - x) < 22 && Math.abs(b.z - z) < 22)) continue;
    const w = 8 + rand() * 6, d = 8 + rand() * 6, hh = 5 + rand() * 4;
    block(x, z, w, hh, d, rand() < .5 ? mWall : mWall2, y - 0.6);
    const roof = mk(new THREE.ConeGeometry(Math.max(w, d) * 0.75, 4, 4), rand() < .4 ? mRed : mRoof, x, y - 0.6 + hh + 2, z, Math.PI / 4);
    roof.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
    winBox(x, z, w, d, y + 2.4);
    mk(new THREE.BoxGeometry(1.4, 2.6, 0.2), mWood, x, y + 0.7, z + d / 2 + 0.05);
    mk(new THREE.BoxGeometry(1, 3, 1), mWall, x + w * 0.22, y + hh + 1.6, z - d * 0.15);
    i++;
  }
  const crownGeo = new THREE.ConeGeometry(2.8, 9, 6); crownGeo.translate(0, 7, 0);
  const trunkGeo = new THREE.CylinderGeometry(.35, .5, 3.4, 5); trunkGeo.translate(0, 1.7, 0);
  const trees = [];
  const clusters = Array.from({ length: 70 }, () => [(rand() * 2 - 1) * (MAP_X - 200), (rand() * 2 - 1) * 700 - 250]);
  for (let i = 0; i < 40000 && trees.length < 4200; i++) {
    const cl = clusters[i % clusters.length];
    const x = cl[0] + (rand() - .5) * 220, z = cl[1] + (rand() - .5) * 220, y = H(x, z);
    if (y < 3 || y > 160) continue;
    if (BASES.some(b => Math.hypot(x - b.x, z - b.z) < BASE_R + 60)) continue;
    if (Math.abs(x) < 1020 && Math.abs(z - roadZ(x)) < 11) continue;
    if (Math.abs(x) > RWY.x0 - 80 && Math.abs(z - RWY.z) < 110) continue;
    if (boxes.some(b => Math.abs(b.x - x) < b.hx + 4 && Math.abs(b.z - z) < b.hz + 4)) continue;
    trees.push({ x, y, z, s: 0.8 + rand() * 0.8, r: rand() * TAU });
  }
  const pineMat = camFade(M(0x4b5e36, { roughness: 1 }), 3, 10), trunkMat = M(0x5a4a3a);
  const tr = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length), cr = new THREE.InstancedMesh(crownGeo, pineMat, trees.length);
  trees.forEach((t, i) => { dummy.position.set(t.x, t.y - .3, t.z); dummy.rotation.set(0, t.r, 0); dummy.scale.setScalar(t.s); dummy.updateMatrix(); tr.setMatrixAt(i, dummy.matrix); cr.setMatrixAt(i, dummy.matrix); });
  cr.castShadow = true; group.add(tr, cr);

  // ── dirt road between the bases, telegraph poles ──
  { const pts = [], idx = []; let n = 0;
    for (let x = -1000; x <= 1000; x += 8) {
      const z = roadZ(x), y = Math.max(H(x, z), H(x, z - 5), H(x, z + 5)) + 0.35;
      pts.push(x, y, z - 5.5, x, y, z + 5.5);
      if (n) idx.push(n * 2 - 2, n * 2 - 1, n * 2, n * 2 - 1, n * 2 + 1, n * 2);
      n++;
    }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); rg.setIndex(idx); rg.computeVertexNormals();
    const road = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ color: 0x86745a, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })); road.receiveShadow = true; group.add(road);
    for (let x = -960; x <= 960; x += 64) { const z = roadZ(x) + 10; PR.pole.push([x, H(x, z) + 4, z, 0, 1]); }
  }
  // ── bushes, boulders, hay bales, clouds ──
  for (let i = 0; i < 9000 && PR.bush.length < 2200; i++) {
    const x = (rand() * 2 - 1) * (MAP_X - 100), z = (rand() * 2 - 1) * 760 - 240, y = H(x, z);
    if (y < 3 || y > 170 || onBasePad(x, z) || Math.abs(z - roadZ(x)) < 8) continue;
    PR.bush.push([x, y + 0.5, z, rand() * 3, 0.6 + rand() * 1.1]);
  }
  for (let i = 0; i < 4000 && PR.rock.length < 700; i++) {
    const x = (rand() * 2 - 1) * (MAP_X - 60), z = (rand() * 2 - 1) * (MAP_Z - 100), y = H(x, z);
    if (y < 1 || onBasePad(x, z) || Math.abs(z - roadZ(x)) < 8) continue;
    PR.rock.push([x, y + 0.2, z, rand() * 6, 0.5 + rand() * rand() * 3.5, rand() * 3]);
  }
  for (let i = 0; i < 600 && PR.hay.length < 40; i++) {
    const x = (rand() - .5) * 900, z = (rand() - .5) * 700 - 60, y = H(x, z);
    if (y < 4 || Math.abs(H(x + 5, z) - y) > 0.8 || Math.abs(z - roadZ(x)) < 9 || boxes.some(b => Math.abs(b.x - x) < b.hx + 3 && Math.abs(b.z - z) < b.hz + 3)) continue;
    PR.hay.push([x, y + 1.0, z, rand() * 3, 1, Math.PI / 2]);
  }
  for (let i = 0; i < 46; i++) { const cx = (rand() * 2 - 1) * (MAP_X + 600), cz = (rand() * 2 - 1) * (MAP_Z + 600), cy = 700 + rand() * 400;
    for (let k = 0; k < 4; k++) PR.cloud.push([cx + (rand() - .5) * 150, cy + (rand() - .5) * 18, cz + (rand() - .5) * 90, 0, 35 + rand() * 45]); }
  const instance = (geo, mat, list, shadow = true, sy = 1) => {
    if (!list.length) return;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((e, i) => { dummy.position.set(e[0], e[1], e[2]); dummy.rotation.set(e[5] || 0, e[3] || 0, 0); const sc = e[4] || 1; dummy.scale.set(sc, sc * sy, sc); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
    m.castShadow = shadow; m.receiveShadow = shadow; group.add(m); return m;
  };
  instance(new THREE.BoxGeometry(1.3, 1.2, 0.14), mGlass, PR.win, false);
  instance(new THREE.BoxGeometry(1.6, 1.6, 1.6), mWood, PR.crate);
  instance(new THREE.CylinderGeometry(0.45, 0.45, 1.2, 8), M(0x4a5a3a), PR.barrel);
  instance(new THREE.CylinderGeometry(0.1, 0.16, 7, 5), mDark, PR.lamp);
  instance(new THREE.SphereGeometry(0.32, 6, 4), new THREE.MeshBasicMaterial({ color: 0xfff0b8 }), PR.bulb, false);
  instance(new THREE.SphereGeometry(0.3, 6, 4), new THREE.MeshBasicMaterial({ color: 0x9fd8ff }), PR.rl, false);
  instance(new THREE.CylinderGeometry(0.14, 0.2, 8, 5), mWood, PR.pole);
  instance(new THREE.BoxGeometry(2.6, 0.14, 0.14), mWood, PR.pole.map(e => [e[0], e[1] + 3.3, e[2], 0, 1]), false);
  instance(new THREE.IcosahedronGeometry(1.5, 0), camFade(M(0x5a6e38, { roughness: 1 }), 3, 9), PR.bush, true, 0.75);
  instance(new THREE.DodecahedronGeometry(1, 0), M(0x7c7a72, { roughness: 1 }), PR.rock, true, 0.7);
  instance(new THREE.CylinderGeometry(1.1, 1.1, 1.5, 10), M(0xc9b060, { roughness: 1 }), PR.hay);
  const cl = instance(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xf3f5f5, fog: false, transparent: true, opacity: .82, depthWrite: false }), PR.cloud, false, 0.3);
  if (cl) cl.frustumCulled = false;

  scene.add(group);
  world = { group, boxes, trees, samSites, seed };
  for (let i = 0; i < GR_N * 2; i++) grC[i] = 1e9;
  buildMinimapBase();
}
const world_flags = [], world_radars = [];
function landY(x, z) { return Math.max(H(x, z), -30); }

// ═══════════ RAYS ═══════════
// terrain + buildings + vehicles. Returns { t, kind, v } or null.
function rayTerrain(o, d, maxT, step = 3) {
  let prev = 0;
  for (let t = step; t <= maxT + step; t += step) {
    const tt = Math.min(t, maxT);
    const x = o[0] + d[0] * tt, y = o[1] + d[1] * tt, z = o[2] + d[2] * tt;
    if (y < H(x, z)) {
      let a = prev, b = tt;
      for (let i = 0; i < 8; i++) { const m = (a + b) / 2; if (o[1] + d[1] * m < H(o[0] + d[0] * m, o[2] + d[2] * m)) b = m; else a = m; }
      return b;
    }
    prev = tt;
    if (tt >= maxT) break;
  }
  return null;
}
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
function rayBox(o, d, b) {
  let tmin = 0, tmax = Infinity;
  const mn = [b.x - b.hx, b.y0, b.z - b.hz], mx = [b.x + b.hx, b.y1, b.z + b.hz];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-8) { if (o[k] < mn[k] || o[k] > mx[k]) return null; continue; }
    let t1 = (mn[k] - o[k]) / d[k], t2 = (mx[k] - o[k]) / d[k];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
function rayVehicle(o, d, v, maxT) {
  // into the vehicle's local frame
  _ro.set(o[0], o[1], o[2]).applyMatrix4(v.inv);
  _rd.set(d[0], d[1], d[2]).transformDirection(v.inv);
  const hb = HITBOX[v.type];
  const t = rayBox([_ro.x, _ro.y, _ro.z], [_rd.x, _rd.y, _rd.z], { x: 0, z: 0, hx: hb[0], hz: hb[3], y0: hb[1], y1: hb[2] });
  return t !== null && t <= maxT ? t : null;
}
function castRay(o, d, maxT, ignoreVid = null, opts = {}) {
  let best = null;
  const tt = rayTerrain(o, d, maxT, opts.step || 3);
  if (tt !== null) best = { t: tt, kind: 'terrain' };
  if (!opts.noWater && d[1] < 0 && o[1] > 0) { const tw = -o[1] / d[1]; if (tw <= maxT && (!best || tw < best.t) && H(o[0] + d[0] * tw, o[2] + d[2] * tw) < 0) best = { t: tw, kind: 'water' }; }
  const lim = best ? best.t : maxT;
  for (const b of world.boxes) { const t = rayBox(o, d, b); if (t !== null && t < (best ? best.t : lim)) best = { t, kind: 'box' }; }
  if (!opts.noVeh) for (const v of vehicles.values()) {
    if (v.vid === ignoreVid || !v.vis.g.visible) continue;
    const dx = v.pos.x - o[0], dy = v.pos.y - o[1], dz = v.pos.z - o[2];
    const along = dx * d[0] + dy * d[1] + dz * d[2];
    if (along < -30 || along > (best ? best.t : maxT) + 30) continue;
    const t = rayVehicle(o, d, v, best ? best.t : maxT);
    if (t !== null && (!best || t < best.t)) best = { t, kind: 'veh', v };
  }
  return best;
}

// ── grass that follows the camera: dense near you, free everywhere else ──
const GR_N = 8000, GR_L = 150;
const grassMesh = (() => {
  const geo = new THREE.ConeGeometry(0.2, 0.9, 3); geo.translate(0, 0.42, 0);
  const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), GR_N);
  const c = new THREE.Color();
  for (let i = 0; i < GR_N; i++) { c.setHSL(0.2 + Math.random() * 0.08, 0.3 + Math.random() * 0.2, 0.3 + Math.random() * 0.14); m.setColorAt(i, c); }
  m.frustumCulled = false; m.receiveShadow = true; scene.add(m); return m;
})();
const grO = new Float32Array(GR_N * 2).map(() => Math.random() * GR_L), grC = new Int32Array(GR_N * 2).fill(1e9);
const _gd = new THREE.Object3D();
function updateGrass() {
  if (!world) return;
  const cx = camera.position.x, cz = camera.position.z;
  const high = camera.position.y - Math.max(0, H(cx, cz)) > 200;
  grassMesh.visible = !high;
  if (high) return;
  let ch = false;
  for (let i = 0; i < GR_N; i++) {
    const ox = grO[i * 2], oz = grO[i * 2 + 1];
    const kx = Math.round((cx - ox) / GR_L), kz = Math.round((cz - oz) / GR_L);
    if (kx === grC[i * 2] && kz === grC[i * 2 + 1]) continue;
    grC[i * 2] = kx; grC[i * 2 + 1] = kz;
    const x = ox + kx * GR_L, z = oz + kz * GR_L, y = H(x, z);
    const ok = y > 2.6 && y < 180 && !onBasePad(x, z) && !(Math.abs(x) < 1010 && Math.abs(z - roadZ(x)) < 6.5);
    _gd.position.set(x, y - 0.05, z); _gd.rotation.set(0, i * 1.7, (i % 5 - 2) * 0.06); _gd.scale.setScalar(ok ? 0.6 + (i % 9) / 9 : 0.0001); _gd.updateMatrix();
    grassMesh.setMatrixAt(i, _gd.matrix); ch = true;
  }
  if (ch) grassMesh.instanceMatrix.needsUpdate = true;
}
// ═══════════ TANK MODEL ═══════════
// shared textures: grey camo (tinted per team via material colour), track tread, turret numbers
const camoTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  c.fillStyle = '#c8c8c8'; c.fillRect(0, 0, 256, 256);
  let s = 11; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (const [shade, n] of [['#9a9a9a', 16], ['#e6e6e6', 12], ['#7c7c7c', 8]]) {
    c.fillStyle = shade;
    for (let i = 0; i < n; i++) {
      c.beginPath(); const x = r() * 256, y = r() * 256, rad = 14 + r() * 26;
      for (let k = 0; k < 9; k++) { const a = k / 9 * Math.PI * 2, rr = rad * (0.6 + r() * 0.6); c.lineTo(x + Math.cos(a) * rr * 1.5, y + Math.sin(a) * rr); }
      c.closePath(); c.fill();
    }
  }
  const img = c.getImageData(0, 0, 256, 256);   // fine grain so plates don't look like plastic
  for (let i = 0; i < img.data.length; i += 4) { const n = (r() - .5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const treadCanvas = (() => {
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 64;
  const c = cv.getContext('2d');
  c.fillStyle = '#3a3a37'; c.fillRect(0, 0, 32, 64);
  for (let y = 0; y < 64; y += 16) { c.fillStyle = '#1e1e1c'; c.fillRect(0, y, 32, 5); c.fillStyle = '#56544e'; c.fillRect(3, y + 7, 26, 3); }
  return cv;
})();
function numberTex(num) {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
  const c = cv.getContext('2d');
  c.font = '900 46px Unbounded, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = 'rgba(240,236,224,.85)'; c.fillText(num, 64, 34);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const TMAT = {
  dark: new THREE.MeshStandardMaterial({ color: 0x2b2c2b, roughness: .9, flatShading: true }),
  metal: new THREE.MeshStandardMaterial({ color: 0x55585b, roughness: .55, metalness: .5, flatShading: true }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x232322, roughness: 1, flatShading: true }),
  lens: new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0x6b5a2a, roughness: .2 }),
  canvas: new THREE.MeshStandardMaterial({ color: 0x6f6a4f, roughness: 1, flatShading: true }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1, flatShading: true })
};
// road wheel: rubber tyre + metal hub, built once and shared
const WHEEL_R = 0.37;
const wheelGeo = (() => {
  const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.26, 14); tyre.rotateZ(Math.PI / 2);
  return tyre;
})();
const hubGeo = (() => { const h = new THREE.CylinderGeometry(0.17, 0.2, 0.3, 8); h.rotateZ(Math.PI / 2); return h; })();
const sprocketGeo = (() => {
  const parts = [];
  const core = new THREE.CylinderGeometry(0.4, 0.4, 0.22, 12); core.rotateZ(Math.PI / 2); parts.push(core.toNonIndexed());
  for (let k = 0; k < 12; k++) {
    const tooth = new THREE.BoxGeometry(0.2, 0.12, 0.1); tooth.translate(0, 0.44, 0); tooth.rotateX(k / 12 * Math.PI * 2); parts.push(tooth.toNonIndexed());
  }
  return mergeGeometries(parts);
})();

// collects transformed part geometries per (group, material) and merges them into one mesh each
function partBuilder() {
  const buckets = new Map();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  function add(group, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(_m);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    const key = group.uuid + mat.uuid;
    if (!buckets.has(key)) buckets.set(key, { group, mat, list: [] });
    buckets.get(key).list.push(g);
  }
  function finish() {
    for (const { group, mat, list } of buckets.values()) {
      const m = new THREE.Mesh(mergeGeometries(list), mat);
      m.castShadow = true; m.receiveShadow = true; group.add(m);
    }
  }
  return { add, finish };
}
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const CYL = (r1, r2, h, s = 10) => new THREE.CylinderGeometry(r1, r2, h, s);

function buildTank(color, num = '000') {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color, map: camoTex, roughness: .82, metalness: .12, flatShading: true });
  const detMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72), roughness: .85, metalness: .15, flatShading: true });
  const trackTexL = new THREE.CanvasTexture(treadCanvas), trackTexR = new THREE.CanvasTexture(treadCanvas);
  for (const t of [trackTexL, trackTexR]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 9); }
  const trackL = new THREE.MeshStandardMaterial({ map: trackTexL, roughness: 1, flatShading: true });
  const trackR = new THREE.MeshStandardMaterial({ map: trackTexR, roughness: 1, flatShading: true });
  const mats = [hullMat, detMat];
  const P = partBuilder(), A = P.add;

  // ── hull: side profile extruded across the width, with chamfered edges ──
  {
    const prof = [[3.15, 0.62], [3.32, 0.95], [2.2, 1.42], [-2.6, 1.48], [-3.05, 1.25], [-3.1, 0.62], [-2.6, 0.38], [2.7, 0.38]];
    const sh = new THREE.Shape(); sh.moveTo(prof[0][0], prof[0][1]); for (const [z, y] of prof.slice(1)) sh.lineTo(z, y); sh.closePath();
    const hg = new THREE.ExtrudeGeometry(sh, { depth: 2.4, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 1 });
    hg.rotateY(-Math.PI / 2); hg.translate(1.2, 0, 0);
    A(g, hg, hullMat);
  }
  for (const sx of [-1, 1]) {
    // fenders, front mudguards, side skirts
    A(g, BOX(0.8, 0.07, 6.3), detMat, sx * 1.62, 1.2, -0.05);
    A(g, BOX(0.8, 0.06, 0.62), detMat, sx * 1.62, 1.08, 3.32, 0.55);
    for (let i = 0; i < 5; i++) A(g, BOX(0.06, 0.6, 1.22), hullMat, sx * 2.0, 0.86, -2.6 + i * 1.3, 0, 0, sx * 0.04);
    // track runs (tread texture scrolls with speed)
    const tm = sx < 0 ? trackL : trackR;
    A(g, BOX(0.7, 0.12, 5.5), tm, sx * 1.62, 1.05, -0.1);
    A(g, BOX(0.7, 0.12, 5.3), tm, sx * 1.62, 0.07, 0);
    A(g, CYL(0.47, 0.47, 0.7, 12), tm, sx * 1.62, 0.55, 2.85, 0, 0, Math.PI / 2);
    A(g, CYL(0.47, 0.47, 0.7, 12), tm, sx * 1.62, 0.58, -2.95, 0, 0, Math.PI / 2);
    // stowage on the fenders, jerrycans at the back
    A(g, BOX(0.6, 0.36, 1.25), detMat, sx * 1.62, 1.41, 0.7);
    A(g, BOX(0.62, 0.04, 1.27), TMAT.dark, sx * 1.62, 1.6, 0.7);
    for (const jz of [-2.35, -2.75]) A(g, BOX(0.22, 0.42, 0.36), TMAT.canvas, sx * 1.62, 1.44, jz);
    // headlights, tow hooks
    A(g, CYL(0.09, 0.11, 0.14, 8), TMAT.dark, sx * 0.85, 1.22, 2.95, Math.PI / 2);
    A(g, CYL(0.075, 0.075, 0.02, 8), TMAT.lens, sx * 0.85, 1.22, 3.03, Math.PI / 2);
    A(g, BOX(0.12, 0.16, 0.22), TMAT.metal, sx * 0.8, 0.72, 3.25);
    // exhausts with mufflers
    A(g, CYL(0.11, 0.11, 0.55, 8), TMAT.metal, sx * 0.7, 1.12, -3.2, Math.PI / 2);
    A(g, BOX(0.36, 0.3, 0.2), TMAT.dark, sx * 0.7, 1.12, -3.0);
  }
  // spare track links on the glacis, hull machine gun, engine deck grilles, shovel
  for (let i = 0; i < 4; i++) A(g, BOX(0.5, 0.06, 0.24), TMAT.dark, -0.85 + i * 0.57, 1.2, 2.72, 0.404);
  A(g, new THREE.SphereGeometry(0.13, 8, 6), detMat, 0.62, 1.2, 2.55);
  A(g, CYL(0.03, 0.03, 0.45, 6), TMAT.dark, 0.62, 1.2, 2.8, Math.PI / 2);
  for (let i = 0; i < 6; i++) A(g, BOX(1.8, 0.05, 0.08), TMAT.dark, 0, 1.52, -1.6 - i * 0.2);
  A(g, BOX(1.9, 0.04, 1.3), detMat, 0, 1.5, -2.15);
  A(g, BOX(0.08, 0.04, 1.1), TMAT.wood, -1.1, 1.52, 1.4); A(g, BOX(0.22, 0.03, 0.28), TMAT.metal, -1.1, 1.52, 2.05);
  A(g, CYL(0.06, 0.06, 1.5, 6), TMAT.dark, 0.95, 1.55, -0.6, Math.PI / 2);   // tow cable drum

  // ── road wheels, sprocket and idler: separate meshes so they can spin ──
  const wheels = [];
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Group(); w.position.set(sx * 1.62, 0.42, -2.1 + i * 0.84); g.add(w);
      const tyre = new THREE.Mesh(wheelGeo, TMAT.rubber), hub = new THREE.Mesh(hubGeo, TMAT.metal);
      tyre.castShadow = true; w.add(tyre, hub); w.userData.r = WHEEL_R; wheels.push(w);
    }
    for (const [z, y, geo, r] of [[-2.95, 0.6, sprocketGeo, 0.44], [2.85, 0.56, wheelGeo, WHEEL_R]]) {
      const w = new THREE.Group(); w.position.set(sx * 1.62, y, z); g.add(w);
      const m = new THREE.Mesh(geo, TMAT.metal); m.castShadow = true; w.add(m); w.userData.r = r; wheels.push(w);
    }
  }

  // ── turret ──
  const turret = new THREE.Group(); turret.position.set(0, 1.62, 0.2); g.add(turret);
  {
    const pts = [[0.55, 1.35], [1.25, 0.6], [1.32, -0.8], [0.92, -1.9], [-0.92, -1.9], [-1.32, -0.8], [-1.25, 0.6], [-0.55, 1.35]];
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], -pts[0][1]); for (const [x, z] of pts.slice(1)) sh.lineTo(x, -z); sh.closePath();
    const tg = new THREE.ExtrudeGeometry(sh, { depth: 0.72, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 1 });
    tg.rotateX(-Math.PI / 2); tg.translate(0, 0.08, 0);
    A(turret, tg, hullMat);
  }
  A(turret, CYL(1.18, 1.25, 0.2, 18), detMat, 0, 0.04, -0.1);
  // commander cupola with periscopes and an open hatch, loader hatch, roof MG
  A(turret, CYL(0.34, 0.38, 0.3, 12), detMat, -0.55, 1.02, -0.45);
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; A(turret, BOX(0.1, 0.09, 0.07), TMAT.lens, -0.55 + Math.sin(a) * 0.33, 1.04, -0.45 + Math.cos(a) * 0.33, 0, a); }
  A(turret, CYL(0.3, 0.3, 0.05, 12), detMat, -0.55, 1.32, -0.82, -1.1);
  A(turret, CYL(0.27, 0.27, 0.05, 12), detMat, 0.55, 0.9, -0.35);
  A(turret, BOX(0.12, 0.22, 0.12), TMAT.dark, 0.55, 1.05, -0.05);
  A(turret, CYL(0.035, 0.035, 0.9, 6), TMAT.dark, 0.55, 1.12, 0.32, Math.PI / 2);
  A(turret, BOX(0.1, 0.16, 0.3), TMAT.dark, 0.55, 1.12, -0.05);
  // smoke dischargers, storage basket, antennas, side bins
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) A(turret, CYL(0.06, 0.06, 0.3, 8), TMAT.dark, sx * (1.12 + k * 0.03), 0.55 + k * 0.12, 0.62, -0.7, 0, -sx * 0.5);
    A(turret, BOX(0.28, 0.42, 0.9), detMat, sx * 1.38, 0.4, -0.75);
  }
  A(turret, BOX(1.9, 0.05, 0.55), TMAT.dark, 0, 0.42, -2.18);
  for (const sx of [-0.95, 0, 0.95]) A(turret, BOX(0.04, 0.35, 0.04), TMAT.dark, sx, 0.6, -2.44);
  A(turret, BOX(1.9, 0.04, 0.04), TMAT.dark, 0, 0.78, -2.44);
  A(turret, CYL(0.17, 0.17, 1.6, 10), TMAT.canvas, 0, 0.62, -2.15, 0, 0, Math.PI / 2);
  for (const sx of [-0.8, 0.8]) { A(turret, CYL(0.025, 0.012, 2.4, 4), TMAT.dark, sx, 1.95, -1.55); A(turret, CYL(0.06, 0.08, 0.12, 6), TMAT.dark, sx, 0.84, -1.55); }

  // ── gun: mantlet, barrel with fume extractor, muzzle brake ──
  const gun = new THREE.Group(); gun.position.set(0, 0.45, 1.35); turret.add(gun);
  A(gun, BOX(1.0, 0.62, 0.42), detMat, 0, 0, 0.12);
  A(gun, CYL(0.31, 0.31, 0.98, 14), hullMat, 0, 0, 0.32, 0, 0, Math.PI / 2);
  A(gun, CYL(0.1, 0.14, 4.3, 12), hullMat, 0, 0, 2.35, Math.PI / 2);
  A(gun, CYL(0.17, 0.17, 0.75, 12), detMat, 0, 0, 2.55, Math.PI / 2);
  A(gun, BOX(0.4, 0.24, 0.52), TMAT.dark, 0, 0, 4.48);
  for (const sx of [-1, 1]) A(gun, BOX(0.03, 0.18, 0.08), TMAT.metal, sx * 0.205, 0, 4.42);
  A(gun, CYL(0.04, 0.04, 0.7, 6), TMAT.dark, 0.45, 0.18, 0.6, Math.PI / 2);   // coaxial MG
  const tip = new THREE.Object3D(); tip.position.set(0, 0, 4.75); gun.add(tip);
  const barrel = new THREE.Object3D(); gun.add(barrel);

  P.finish();
  // turret numbers on both sides
  const nt = numberTex(num);
  for (const sx of [-1, 1]) {
    const n = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.37), new THREE.MeshStandardMaterial({ map: nt, transparent: true, roughness: .9, polygonOffset: true, polygonOffsetFactor: -2 }));
    n.position.set(sx * 1.335, 0.46, -0.35); n.rotation.y = sx * Math.PI / 2 + (sx > 0 ? 0 : 0); n.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    turret.add(n);
  }
  return { g, turret, gun, barrel, tip, mats, color: new THREE.Color(color), wheels, tracks: [trackTexL, trackTexR] };
}
function buildPlane(color) {
  // low-poly fighter jet, ~17 units long (about twice the old prop plane)
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: .6, metalness: .35, flatShading: true, side: THREE.DoubleSide });
  const detMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.68), roughness: .65, metalness: .35, flatShading: true, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2c, roughness: .5, metalness: .6, flatShading: true, side: THREE.DoubleSide });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: .1, metalness: .7, emissive: 0x0a1420 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xdcdcd6, roughness: .5, metalness: .2, flatShading: true });
  const mats = [bodyMat, detMat];
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  // extruded outline lying flat in the x/z plane; pts are [x, z]
  const flat = (pts, depth, mat) => {
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);          // shape y -> world z, extrusion depth -> downward thickness
    geo.translate(0, depth / 2, 0);
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m;
  };
  // fuselage + nose
  const fus = add(new THREE.CylinderGeometry(1.05, 0.95, 11.5, 8), bodyMat, 0, 0, -0.2); fus.rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(1.3, 0.7, 8), bodyMat, 0, 0.75, -1.2);                       // spine
  const nose = add(new THREE.ConeGeometry(1.05, 5, 8), bodyMat, 0, 0, 8.05); nose.rotation.x = Math.PI / 2;
  const tipC = add(new THREE.ConeGeometry(0.32, 1.4, 8), darkMat, 0, 0, 10.2); tipC.rotation.x = Math.PI / 2;
  const canopy = add(new THREE.SphereGeometry(0.8, 12, 8), glassMat, 0, 1.0, 4.4); canopy.scale.set(0.95, 0.85, 2.6);
  for (const sx of [-1, 1]) { const intake = add(new THREE.BoxGeometry(1.0, 1.35, 4.2), detMat, sx * 1.35, -0.25, 1.6); intake.rotation.z = sx * 0.12; }
  const nozzle = add(new THREE.CylinderGeometry(0.95, 0.75, 1.6, 10, 1, true), darkMat, 0, 0, -6.6); nozzle.rotation.x = Math.PI / 2;
  // afterburner flame (scaled by throttle / boost every frame)
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.7, 4, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffa64a, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.rotation.x = -Math.PI / 2; flame.position.z = -9.2; g.add(flame);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.4, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xbfe2ff, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.rotation.x = -Math.PI / 2; core.position.z = -8.2; g.add(core);
  // swept wings, tailplanes, twin canted fins
  for (const sx of [-1, 1]) {
    const w = flat([[sx * 0.9, 3.0], [sx * 7.4, -3.4], [sx * 7.4, -4.6], [sx * 0.9, -4.8]], 0.28, bodyMat); w.position.y = -0.25; g.add(w);
    const st = flat([[sx * 0.8, -5.6], [sx * 4.0, -7.6], [sx * 4.0, -8.3], [sx * 0.8, -8.0]], 0.2, detMat); st.position.y = -0.1; g.add(st);
    // fin: outline in (height, z) drawn flat, then stood up and canted outward
    const fin = flat([[0, -4.4], [3.4, -6.5], [3.4, -8.2], [0, -7.9]], 0.2, detMat);
    fin.rotation.z = Math.PI / 2 - sx * 0.28; fin.position.set(sx * 1.0, 0.55, 0); g.add(fin);
    const rd = add(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 16), new THREE.MeshBasicMaterial({ color: 0xe8e4d8 }), sx * 5.2, 0.05, -2.9); rd.castShadow = false; // roundel
  }
  // missiles on wing pylons (hidden once fired)
  const missiles = [];
  for (const sx of [-1, 1]) {
    const mg = new THREE.Group(); mg.position.set(sx * 4.0, -0.85, -1.4); g.add(mg);
    const tube = add(new THREE.CylinderGeometry(0.2, 0.2, 3.2, 8), whiteMat, 0, 0, 0, mg); tube.rotation.x = Math.PI / 2;
    const mn = add(new THREE.ConeGeometry(0.2, 0.7, 8), whiteMat, 0, 0, 1.95, mg); mn.rotation.x = Math.PI / 2;
    add(new THREE.BoxGeometry(0.9, 0.06, 0.5), darkMat, 0, 0, -1.4, mg);
    add(new THREE.BoxGeometry(0.06, 0.9, 0.5), darkMat, 0, 0, -1.4, mg);
    add(new THREE.BoxGeometry(0.15, 0.5, 1.4), darkMat, 0, 0.42, 0, mg);   // pylon
    missiles.push(mg);
  }
  const gunL = new THREE.Object3D(); gunL.position.set(1.1, 0.35, 5.8); g.add(gunL);
  const gunR = new THREE.Object3D(); gunR.position.set(-1.1, 0.35, 5.8); g.add(gunR);
  return { g, flame, core, guns: [gunL, gunR], missiles, mats, color: new THREE.Color(color) };
}
function buildShip(color) {
  // low-poly cruiser, ~48 units long, bow towards +z
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const hullMat = new THREE.MeshStandardMaterial({ color, roughness: .75, metalness: .25, flatShading: true });
  const detMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0x8c9092), 0.55), roughness: .7, metalness: .25, flatShading: true });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x8b8274, roughness: .95, flatShading: true });
  const redMat = new THREE.MeshStandardMaterial({ color: 0x6b2a22, roughness: .9, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b2d2e, roughness: .6, metalness: .4, flatShading: true });
  const mats = [hullMat, detMat];
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const outline = s => [[0, 24 * s], [3.0 * s, 15], [3.9 * s, 5], [3.9 * s, -15], [3.1 * s, -21.5], [1.6 * s, -23.2], [-1.6 * s, -23.2], [-3.1 * s, -21.5], [-3.9 * s, -15], [-3.9 * s, 5], [-3.0 * s, 15]];
  const prism = (pts, y0, y1, mat) => {   // extrude an x/z outline between heights y0..y1
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false }); geo.rotateX(Math.PI / 2); geo.translate(0, y1, 0);
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  prism(outline(0.97), -2.6, -0.5, redMat);       // anti-fouling below the waterline
  prism(outline(1), -0.5, 3.0, hullMat);           // hull sides
  prism(outline(0.94), 3.0, 3.25, deckMat);        // deck
  // superstructure
  add(new THREE.BoxGeometry(5.2, 3.4, 8), detMat, 0, 4.9, 4.5);           // bridge block
  add(new THREE.BoxGeometry(3.8, 2.6, 4.2), detMat, 0, 7.9, 5.6);          // bridge
  add(new THREE.BoxGeometry(4.4, 0.4, 1.4), darkMat, 0, 8.4, 7.75);        // bridge windows
  const mast = add(new THREE.CylinderGeometry(0.25, 0.35, 12, 6), darkMat, 0, 14, 4.2);
  add(new THREE.BoxGeometry(4.5, 0.25, 0.25), darkMat, 0, 16.5, 4.2);      // yard
  const fun = add(new THREE.CylinderGeometry(1.3, 1.6, 6.5, 10), detMat, 0, 7.2, -2.6); fun.rotation.x = -0.12;
  add(new THREE.CylinderGeometry(1.35, 1.35, 0.6, 10), darkMat, 0, 10.4, -3.0);
  add(new THREE.BoxGeometry(4.6, 2.6, 7), detMat, 0, 4.5, -9.2);           // aft deckhouse
  for (const sx of [-1, 1]) {                                               // torpedo tubes
    const tt = add(new THREE.CylinderGeometry(0.28, 0.28, 4.2, 6), darkMat, sx * 2.6, 3.7, -5.6); tt.rotation.z = Math.PI / 2; tt.rotation.y = sx * 0.3;
    add(new THREE.BoxGeometry(1.4, 0.8, 4.4), darkMat, sx * 1.9, 4.6, 1.2);  // secondary gun mounts
  }
  // main turrets
  const turrets = [];
  for (const T of TURRETS) {
    const tg = new THREE.Group(); tg.position.set(0, T.y, T.z); tg.rotation.y = T.rest; g.add(tg);
    if (T.y > 4) add(new THREE.CylinderGeometry(2.2, 2.4, T.y - 3.2, 10), detMat, 0, -(T.y - 3.2) / 2, 0, tg);   // barbette
    add(new THREE.CylinderGeometry(1.9, 2.1, 0.7, 10), detMat, 0, 0.35, 0, tg);
    const house = add(new THREE.BoxGeometry(3.3, 1.6, 3.8), hullMat, 0, 1.3, 0.2, tg);
    add(new THREE.BoxGeometry(3.0, 1.2, 1.0), hullMat, 0, 1.15, 2.3, tg).rotation.x = 0.35;
    const gun = new THREE.Group(); gun.position.set(0, 1.3, 2.0); tg.add(gun);
    const tips = [];
    for (const bx of [-0.65, 0.65]) {
      const br = add(new THREE.CylinderGeometry(0.17, 0.23, 6.2, 8), darkMat, bx, 0, 3.0, gun); br.rotation.x = Math.PI / 2;
      const tip = new THREE.Object3D(); tip.position.set(bx, 0, 6.2); gun.add(tip); tips.push(tip);
    }
    turrets.push({ g: tg, gun, tips, house });
  }
  const funnelTop = new THREE.Object3D(); funnelTop.position.set(0, 11, -3.1); g.add(funnelTop);
  return { g, turrets, funnelTop, mats, color: new THREE.Color(color) };
}


// ═══════════ JEEP MODEL ═══════════
const TURRETS = [{ z: 14.5, y: 3.4, rest: 0 }, { z: 9.2, y: 4.8, rest: 0 }, { z: -15.5, y: 3.4, rest: Math.PI }];
const ARC = 2.55;
function buildJeep(color) {
  // ~4.6 m long open jeep with a pintle machine gun, front towards +z
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const body = new THREE.MeshStandardMaterial({ color, roughness: .8, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2d2b, roughness: .7, metalness: .3, flatShading: true });
  const tyreM = new THREE.MeshStandardMaterial({ color: 0x1d1e1d, roughness: .95, flatShading: true });
  const seatM = new THREE.MeshStandardMaterial({ color: 0x4a3f30, roughness: 1, flatShading: true });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  add(new THREE.BoxGeometry(1.9, 0.55, 4.2), body, 0, 0.95, 0);              // tub
  add(new THREE.BoxGeometry(1.8, 0.4, 1.5), body, 0, 1.35, 1.35);            // bonnet
  add(new THREE.BoxGeometry(1.95, 0.5, 0.15), dark, 0, 1.05, 2.12);          // grille
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.45, 0.12, 1.1), body, sx * 1.02, 1.32, 1.45); // fenders
    add(new THREE.BoxGeometry(0.45, 0.12, 1.0), body, sx * 1.02, 1.32, -1.45);
    add(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0x554422 }), sx * 0.6, 1.2, 2.18);
    add(new THREE.BoxGeometry(0.5, 0.55, 0.55), seatM, sx * 0.45, 1.45, -0.05);
  }
  const ws = add(new THREE.BoxGeometry(1.8, 0.75, 0.06), dark, 0, 1.85, 0.6); ws.rotation.x = -0.25;   // windscreen frame
  const bar = add(new THREE.BoxGeometry(1.9, 0.09, 0.09), dark, 0, 2.2, -0.75);                       // roll bar
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.09, 1.0, 0.09), dark, sx * 0.92, 1.7, -0.75);
  add(new THREE.CylinderGeometry(0.42, 0.42, 0.25, 12), tyreM, 0, 1.3, -2.2).rotation.x = Math.PI / 2;   // spare wheel
  const wheels = [];
  const tyre = new THREE.CylinderGeometry(0.44, 0.44, 0.32, 12); tyre.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-1.0, 1.4], [1.0, 1.4], [-1.0, -1.4], [1.0, -1.4]]) { const w = add(tyre, tyreM, x, 0.44, z); wheels.push(w); }
  // machine gun on a post
  add(new THREE.CylinderGeometry(0.07, 0.09, 1.1, 6), dark, 0, 1.75, -0.95);
  const turret = new THREE.Group(); turret.position.set(0, 2.3, -0.95); g.add(turret);
  const gun = new THREE.Group(); turret.add(gun);
  add(new THREE.BoxGeometry(0.22, 0.26, 0.9), dark, 0, 0, 0.2, gun);
  add(new THREE.CylinderGeometry(0.05, 0.06, 1.1, 6), dark, 0, 0.03, 1.15, gun).rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(0.5, 0.4, 0.06), dark, 0, 0.15, 0.55, gun);    // gun shield
  add(new THREE.BoxGeometry(0.25, 0.2, 0.35), new THREE.MeshStandardMaterial({ color: 0x5a5a3a, flatShading: true }), 0.22, -0.08, 0.15, gun);   // ammo box
  const tip = new THREE.Object3D(); tip.position.set(0, 0.03, 1.75); gun.add(tip);
  // extra detail: bumper, steering wheel, jerrycan, antenna, mirrors, tow hook, crew
  add(new THREE.BoxGeometry(2.1, 0.18, 0.18), dark, 0, 0.75, 2.25);
  add(new THREE.BoxGeometry(2.0, 0.18, 0.18), dark, 0, 0.75, -2.2);
  const sw = add(new THREE.TorusGeometry(0.2, 0.035, 5, 12), dark, -0.45, 1.75, 0.35); sw.rotation.x = -0.9;
  add(new THREE.BoxGeometry(0.2, 0.5, 0.36), new THREE.MeshStandardMaterial({ color: 0x4f5a34, roughness: .8, flatShading: true }), 1.06, 1.25, -1.8);
  const ant = add(new THREE.CylinderGeometry(0.015, 0.025, 2.6, 4), dark, -0.9, 2.5, -1.9); ant.rotation.x = -0.12;
  for (const sx of [-1, 1]) { add(new THREE.BoxGeometry(0.22, 0.16, 0.04), dark, sx * 1.08, 1.8, 0.62); add(new THREE.BoxGeometry(0.5, 0.06, 4.0), dark, sx * 0.98, 0.72, 0); }
  add(new THREE.BoxGeometry(0.7, 0.35, 0.5), seatM, 0, 1.3, -1.6);   // kit bag
  const drv = makeSoldier(); drv.position.set(-0.45, 0.72, -0.1); drv.scale.setScalar(0.92); g.add(drv);
  const gnr = makeSoldier(); gnr.position.set(0, -1.32, -0.55); turret.add(gnr);
  return { g, turret, gun, tip, wheels, mats: [body], color: new THREE.Color(color) };
}

// simple soldier figure, feet at y = 0, facing +z, arms forward (holding a gun)
const SOLD = {
  uni: new THREE.MeshStandardMaterial({ color: 0x4d5536, roughness: 1, flatShading: true }),
  skin: new THREE.MeshStandardMaterial({ color: 0xc79a78, roughness: 1, flatShading: true }),
  helm: new THREE.MeshStandardMaterial({ color: 0x353b2a, roughness: .8, flatShading: true }),
  boot: new THREE.MeshStandardMaterial({ color: 0x232321, roughness: 1, flatShading: true }),
};
function makeSoldier() {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.2, 0.62, 0.24), SOLD.uni, sx * 0.14, 0.58, 0);
    add(new THREE.BoxGeometry(0.22, 0.28, 0.32), SOLD.boot, sx * 0.14, 0.14, 0.03);
    const arm = add(new THREE.BoxGeometry(0.15, 0.6, 0.17), SOLD.uni, sx * 0.34, 1.28, 0.25); arm.rotation.x = -1.25;
    add(new THREE.BoxGeometry(0.12, 0.12, 0.12), SOLD.skin, sx * 0.3, 1.33, 0.55);
  }
  add(new THREE.BoxGeometry(0.52, 0.62, 0.28), SOLD.uni, 0, 1.2, 0);
  add(new THREE.BoxGeometry(0.56, 0.3, 0.34), SOLD.helm, 0, 1.12, 0.02);        // vest
  add(new THREE.BoxGeometry(0.3, 0.4, 0.16), SOLD.helm, 0, 1.25, -0.2);          // backpack
  add(new THREE.SphereGeometry(0.16, 8, 6), SOLD.skin, 0, 1.68, 0);
  const h = add(new THREE.SphereGeometry(0.2, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), SOLD.helm, 0, 1.7, 0);
  return g;
}
// machine-gun post: sandbag ring, soldier and a heavy MG on a tripod
function buildGunner(color) {
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const bagM = new THREE.MeshStandardMaterial({ color: 0xa8976e, roughness: 1, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x262827, roughness: .6, metalness: .4, flatShading: true });
  const teamM = new THREE.MeshStandardMaterial({ color, roughness: .8, flatShading: true });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const bag = new THREE.CapsuleGeometry(0.22, 0.6, 3, 6); bag.rotateZ(Math.PI / 2);
  for (let row = 0; row < 3; row++) for (let i = 0; i < 12; i++) {
    const a = (i + row * 0.5) / 12 * TAU;
    if (Math.abs(wrap(a - Math.PI)) < 0.5) continue;                       // entrance at the back
    if (row === 2 && Math.abs(wrap(a)) < 0.9) continue;                    // firing slit
    const b = add(bag, bagM, Math.sin(a) * 1.7, 0.2 + row * 0.38, Math.cos(a) * 1.7); b.rotation.y = a;
  }
  add(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 4), dark, -1.5, 1.3, -1.2);
  add(new THREE.BoxGeometry(0.7, 0.45, 0.02), teamM, -1.14, 2.35, -1.2);   // team pennant
  add(new THREE.BoxGeometry(0.5, 0.35, 0.7), new THREE.MeshStandardMaterial({ color: 0x4f5a34, roughness: .9, flatShading: true }), 0.9, 0.2, -0.6);   // ammo crate
  const turret = new THREE.Group(); g.add(turret);
  const man = makeSoldier(); man.position.set(0, 0, -0.35); turret.add(man);
  for (let i = 0; i < 3; i++) { const leg = add(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 4), dark, Math.sin(i / 3 * TAU) * 0.35, 0.6, 0.45 + Math.cos(i / 3 * TAU) * 0.35, turret); leg.rotation.set(Math.cos(i / 3 * TAU) * 0.5, 0, -Math.sin(i / 3 * TAU) * 0.5); }
  const gun = new THREE.Group(); gun.position.set(0, 1.3, 0.45); turret.add(gun);
  add(new THREE.BoxGeometry(0.16, 0.22, 0.9), dark, 0, 0, 0.05, gun);
  add(new THREE.CylinderGeometry(0.035, 0.045, 1.3, 6), dark, 0, 0.02, 1.1, gun).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6), dark, 0, 0.02, 0.75, gun).rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(0.3, 0.26, 0.3), new THREE.MeshStandardMaterial({ color: 0x4f5a34, flatShading: true }), 0.24, -0.05, 0.05, gun);
  const tip = new THREE.Object3D(); tip.position.set(0, 0.02, 1.8); gun.add(tip);
  return { g, turret, gun, tip, mats: [teamM], color: new THREE.Color(color) };
}

// SS-27 «Тополь-М» mobile launcher: 16-wheel truck with a missile canister that erects
function buildIcbm(color) {
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const body = new THREE.MeshStandardMaterial({ color, roughness: .8, flatShading: true });
  const body2 = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.72), roughness: .8, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x232524, roughness: .8, flatShading: true });
  const glass = new THREE.MeshStandardMaterial({ color: 0x22323c, roughness: .2, metalness: .6 });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  add(new THREE.BoxGeometry(3.0, 0.9, 20.5), body2, 0, 1.55, 0);                       // chassis
  add(new THREE.BoxGeometry(3.3, 0.25, 20.8), dark, 0, 1.05, 0);
  const wheels = [];
  const tyre = new THREE.CylinderGeometry(0.82, 0.82, 0.62, 12); tyre.rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.4, 0.4, 0.66, 8); hub.rotateZ(Math.PI / 2);
  for (let i = 0; i < 8; i++) for (const sx of [-1, 1]) {
    const z = 8.6 - i * 2.2 - (i > 3 ? 1.6 : 0);
    const w = add(tyre, dark, sx * 1.55, 0.82, z); add(hub, body2, 0, 0, 0, w); wheels.push(w);
    add(new THREE.BoxGeometry(0.75, 0.1, 1.9), body, sx * 1.55, 1.78, z);                // mudguards
  }
  for (const sx of [-1, 1]) {                                                           // twin cabs beside the canister nose
    add(new THREE.BoxGeometry(1.15, 1.7, 2.6), body, sx * 1.05, 2.85, 9.0);
    add(new THREE.BoxGeometry(1.0, 0.7, 0.08), glass, sx * 1.05, 3.2, 10.32);
    add(new THREE.BoxGeometry(0.08, 0.6, 1.2), glass, sx * 1.64, 3.2, 9.4);
    add(new THREE.SphereGeometry(0.16, 6, 4), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0x554422 }), sx * 1.1, 1.75, 10.3);
    add(new THREE.BoxGeometry(0.5, 1.2, 5), body2, sx * 1.45, 2.6, -3);                  // equipment lockers
    add(new THREE.BoxGeometry(0.5, 1.0, 3), body2, sx * 1.45, 2.5, 3.6);
    add(new THREE.BoxGeometry(0.6, 0.5, 0.6), dark, sx * 1.9, 1.3, -1);                  // jacks
    add(new THREE.BoxGeometry(0.6, 0.5, 0.6), dark, sx * 1.9, 1.3, -9.4);
  }
  add(new THREE.BoxGeometry(3.3, 0.5, 0.3), dark, 0, 1.3, 10.4);                         // bumper
  add(new THREE.BoxGeometry(2.6, 1.3, 2.2), body2, 0, 2.6, -8.8);                         // erector base
  // canister pivots at the rear
  const canister = new THREE.Group(); canister.position.set(0, 2.9, -8.6); g.add(canister);
  const tube = add(new THREE.CylinderGeometry(1.02, 1.02, 19.5, 14), body, 0, 0.55, 9.6, canister); tube.rotation.x = Math.PI / 2;
  for (let k = 0; k < 6; k++) { const r = add(new THREE.CylinderGeometry(1.08, 1.08, 0.3, 14), body2, 0, 0.55, 1 + k * 3.5, canister); r.rotation.x = Math.PI / 2; }
  const cap = add(new THREE.SphereGeometry(1.02, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), body2, 0, 0.55, 19.35, canister); cap.rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.16, 0.16, 6, 6), dark, 0, -0.4, 5, canister).rotation.x = Math.PI / 2 - 0.12;   // hydraulic ram
  const tip = new THREE.Object3D(); tip.position.set(0, 0.55, 20); canister.add(tip);
  return { g, canister, tip, wheels, mats: [body, body2], color: new THREE.Color(color) };
}
// FPV kamikaze quadcopter with a warhead strapped underneath
function buildDrone(color) {
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1d1e, roughness: .6, metalness: .3, flatShading: true });
  const teamM = new THREE.MeshStandardMaterial({ color, roughness: .7, flatShading: true });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  add(new THREE.BoxGeometry(0.34, 0.1, 0.62), dark, 0, 0, 0);
  add(new THREE.BoxGeometry(0.26, 0.12, 0.36), teamM, 0, 0.11, -0.05);                 // battery
  add(new THREE.BoxGeometry(0.12, 0.12, 0.1), dark, 0, 0.08, 0.32).rotation.x = -0.4;    // camera
  const props = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const arm = add(new THREE.BoxGeometry(0.62, 0.05, 0.07), dark, sx * 0.27, 0, sz * 0.27); arm.rotation.y = sx * sz * -Math.PI / 4;
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 6), dark, sx * 0.48, 0.06, sz * 0.48);
    const p = add(new THREE.CylinderGeometry(0.24, 0.24, 0.012, 10), new THREE.MeshBasicMaterial({ color: 0x9aa0a4, transparent: true, opacity: 0.35, depthWrite: false }), sx * 0.48, 0.13, sz * 0.48);
    add(new THREE.BoxGeometry(0.46, 0.014, 0.05), dark, 0, 0, 0, p); props.push(p);
  }
  const wh = add(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x4d5536, flatShading: true }), 0, -0.13, 0.1); wh.rotation.x = Math.PI / 2;
  add(new THREE.ConeGeometry(0.12, 0.34, 8), new THREE.MeshStandardMaterial({ color: 0x4d5536, flatShading: true }), 0, -0.13, 0.52).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 3), dark, 0.1, 0.3, -0.28);         // antenna
  g.scale.setScalar(1.5);
  return { g, props, mats: [teamM], color: new THREE.Color(color) };
}
// ═══════════ PARTICLES ═══════════
const particles = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d'); const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gr; c.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  const N = 1100, pool = [];
  for (let i = 0; i < N; i++) {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
    const s = new THREE.Sprite(m); s.visible = false; scene.add(s);
    pool.push({ s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, a0: 1, drag: 0, grav: 0 });
  }
  let idx = 0;
  function spawn(x, y, z, o) {
    const p = pool[idx]; idx = (idx + 1) % N;
    p.s.position.set(x, y, z); p.s.visible = true;
    p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.life = p.max = o.life || 1; p.s0 = o.s0 || 1; p.s1 = o.s1 ?? p.s0; p.a0 = o.a ?? 1; p.drag = o.drag || 0; p.grav = o.grav || 0;
    p.s.material.color.set(o.color ?? 0xffffff);
    p.s.material.blending = o.add ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.s.material.opacity = p.a0; p.s.scale.setScalar(p.s0);
  }
  function update(dt) {
    for (const p of pool) {
      if (!p.s.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      const k = 1 - p.life / p.max, dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy = p.vy * dr - p.grav * dt; p.vz *= dr;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      p.s.scale.setScalar(lerp(p.s0, p.s1, k));
      p.s.material.opacity = p.a0 * (1 - k) * (k < 0.1 ? k * 10 : 1);
    }
  }
  const R = () => Math.random() - 0.5;
  return {
    update,
    muzzle(pos, dir) {
      spawn(pos.x, pos.y, pos.z, { life: .12, s0: 7, s1: 3, color: 0xffc070, add: true });
      for (let i = 1; i < 4; i++) spawn(pos.x + dir.x * i * 2, pos.y + dir.y * i * 2, pos.z + dir.z * i * 2, { life: .15, s0: 5 - i, s1: 1.5, color: 0xffa04a, add: true });
      for (let i = 0; i < 5; i++) spawn(pos.x, pos.y, pos.z, { vx: dir.x * 14 + R() * 5, vy: dir.y * 14 + R() * 4 + 2, vz: dir.z * 14 + R() * 5, life: 2.2 + Math.random(), s0: 3, s1: 10, color: 0xb9b4aa, a: .55, drag: 1.6 });
    },
    splash(pos, big = 1) {
      for (let i = 0; i < 9; i++) spawn(pos.x + R() * 2 * big, 0.5, pos.z + R() * 2 * big, { vx: R() * 4 * big, vy: (14 + Math.random() * 16) * Math.sqrt(big), vz: R() * 4 * big, life: 1.6, s0: 2.2 * big, s1: 4.5 * big, color: 0xf2f6f6, a: .85, grav: 24, drag: .4 });
      for (let i = 0; i < 5; i++) spawn(pos.x + R() * 6 * big, 0.3, pos.z + R() * 6 * big, { vx: R() * 6, vz: R() * 6, life: 2.4, s0: 3 * big, s1: 9 * big, color: 0xe6eeee, a: .5, drag: 1 });
    },
    wake(pos, s = 1) { spawn(pos.x + R(), 0.25, pos.z + R(), { vx: R() * 1.2, vz: R() * 1.2, life: 3.2, s0: 2 * s, s1: 7 * s, color: 0xf0f4f2, a: .55, drag: .6 }); },
    spark(pos) {
      spawn(pos.x, pos.y, pos.z, { life: .1, s0: 2.2, s1: .6, color: 0xffc070, add: true });
      for (let i = 0; i < 4; i++) spawn(pos.x, pos.y, pos.z, { vx: R() * 30, vy: R() * 30, vz: R() * 30, life: .3, s0: .4, s1: .1, color: 0xffd080, add: true });
      spawn(pos.x, pos.y, pos.z, { vx: R() * 3, vy: R() * 3, vz: R() * 3, life: .8, s0: 1, s1: 3, color: 0x5a5550, a: .5, drag: 1 });
    },
    dirt(pos) {
      for (let i = 0; i < 3; i++) spawn(pos.x, pos.y, pos.z, { vx: R() * 6, vy: Math.random() * 8 + 3, vz: R() * 6, life: .8, s0: 1, s1: 2.6, color: 0x6e604a, a: .6, grav: 10, drag: 1.2 });
    },
    explosion(pos, big = 1) {
      spawn(pos.x, pos.y, pos.z, { life: .4, s0: 14 * big, s1: 6, color: 0xffb050, add: true });
      for (let i = 0; i < 22; i++) spawn(pos.x, pos.y, pos.z, { vx: R() * 40, vy: R() * 40 + 6, vz: R() * 40, life: .7 + Math.random() * .6, s0: 2, s1: .4, color: i % 2 ? 0xff8a3a : 0xffd27a, add: true, grav: 18, drag: 1.4 });
      for (let i = 0; i < 18; i++) spawn(pos.x + R() * 4, pos.y + R() * 4, pos.z + R() * 4, { vx: R() * 10, vy: Math.random() * 6 + 2, vz: R() * 10, life: 2.5 + Math.random() * 1.5, s0: 4 * big, s1: 12 * big, color: 0x3a3632, a: .7, drag: 1.2 });
    },
    smoke(pos, dark) { spawn(pos.x + R(), pos.y + R(), pos.z + R(), { vx: R() * 2, vy: 1.5, vz: R() * 2, life: 2.2 + Math.random(), s0: 1.6, s1: 6.5, color: dark ? 0x2a2826 : 0x6a6660, a: .55, drag: .5 }); },
    fire(pos) { spawn(pos.x + R(), pos.y + R(), pos.z + R(), { vy: 2, life: .45, s0: 2.2, s1: .6, color: 0xff7a2a, add: true }); },
    trail(pos) { spawn(pos.x, pos.y, pos.z, { life: .5, s0: .8, s1: 1.6, color: 0xfff1d0, a: .45 }); },
    mtrail(pos) { spawn(pos.x, pos.y, pos.z, { vx: R() * 1.5, vy: R() * 1.5 + .5, vz: R() * 1.5, life: 1.6, s0: 1.2, s1: 4.5, color: 0xd8d6d0, a: .55, drag: .8 }); },
    mflame(pos) { spawn(pos.x, pos.y, pos.z, { life: .06, s0: 2.2, s1: 1, color: 0xffb860, add: true }); },
    flare(pos, v) { spawn(pos.x, pos.y, pos.z, { vx: v.x, vy: v.y, vz: v.z, life: 2.6, s0: 4.5, s1: 1.8, color: 0xfff0b0, add: true, grav: 9, drag: .6 }); },
    flareSmoke(pos) { spawn(pos.x, pos.y, pos.z, { vy: .5, life: 1.4, s0: 1.2, s1: 4, color: 0xe8e6e0, a: .4, drag: 1 }); },
    bubble(pos, s = 1) { spawn(pos.x + R() * s, pos.y + R() * s, pos.z + R() * s, { vx: R() * 1.5, vy: 2.5 + Math.random() * 3, vz: R() * 1.5, life: 1.6 + Math.random(), s0: 0.35 * s, s1: 0.8 * s, color: 0xdff6ff, a: .7, grav: -2.5, drag: .8 }); },
    burst(pos, big = 1) {   // underwater blast: flash + a ball of bubbles
      spawn(pos.x, pos.y, pos.z, { life: .35, s0: 18 * big, s1: 8, color: 0xfff0c0, add: true });
      for (let i = 0; i < 40; i++) spawn(pos.x + R() * 6 * big, pos.y + R() * 6 * big, pos.z + R() * 6 * big, { vx: R() * 24 * big, vy: R() * 24 * big + 6, vz: R() * 24 * big, life: 2 + Math.random() * 2, s0: .8 + Math.random(), s1: 2.5, color: 0xe6f8ff, a: .8, grav: -6, drag: 1.5 });
      for (let i = 0; i < 12; i++) spawn(pos.x + R() * 5, pos.y + R() * 5, pos.z + R() * 5, { vx: R() * 6, vy: 2, vz: R() * 6, life: 3, s0: 6 * big, s1: 14 * big, color: 0x8fb4b8, a: .45, drag: 1 });
      if (pos.y > -30) for (let i = 0; i < 24; i++) spawn(pos.x + R() * 8 * big, 0.5, pos.z + R() * 8 * big, { vx: R() * 6, vy: 18 + Math.random() * 26 * big, vz: R() * 6, life: 2.2, s0: 3 * big, s1: 7 * big, color: 0xf2f6f6, a: .9, grav: 24, drag: .3 });
    },
    heal(pos) { for (let i = 0; i < 16; i++) spawn(pos.x + R() * 8, pos.y + R() * 6, pos.z + R() * 8, { vx: R() * 6, vy: 4, vz: R() * 6, life: 1, s0: 1, s1: .3, color: 0x9bff7a, add: true }); }
  };
})();



// ═══════════ VEHICLE ENTITIES ═══════════
function buildVis(type, team, n) {
  const col = TEAM_COL[team];
  if (type === 'tank') { const v = buildTank(col, String(team ? 200 + n : 100 + n)); v.g.rotation.order = 'YXZ'; return v; }
  if (type === 'jeep') return buildJeep(col);
  if (type === 'gunner') return buildGunner(col);
  if (type === 'icbm') return buildIcbm(col);
  if (type === 'drone') return buildDrone(col);
  const dk = new THREE.MeshStandardMaterial({ color: 0x2a2c2d, roughness: .6, metalness: .5, flatShading: true });
  const part = (parent, geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  if (type === 'plane') {
    const v = buildPlane(col);
    // landing gear (shown on the ground), 3 bombs, extra detail
    const gear = new THREE.Group(); v.g.add(gear); v.gear = gear;
    for (const [x, z] of [[0, 5.2], [-1.9, -2.2], [1.9, -2.2]]) {
      part(gear, new THREE.CylinderGeometry(0.07, 0.07, 1.1, 5), dk, x, -1.2, z);
      const wh = part(gear, new THREE.CylinderGeometry(0.34, 0.34, 0.22, 10), dk, x, -1.56, z); wh.rotation.z = Math.PI / 2;
      part(gear, new THREE.BoxGeometry(0.5, 0.04, 0.9), v.mats[1] ? new THREE.MeshStandardMaterial({ color: v.color.clone().multiplyScalar(0.6), flatShading: true }) : dk, x + (x ? Math.sign(x) * 0.3 : 0.3), -0.95, z);
    }
    const bm = new THREE.MeshStandardMaterial({ color: 0x3d4630, roughness: .6, flatShading: true });
    v.bombs = [];
    for (const [x, y, z] of [[0, -1.25, 0.2], [-2.4, -0.8, -1.2], [2.4, -0.8, -1.2]]) {
      const b = new THREE.Group(); b.position.set(x, y, z); v.g.add(b);
      part(b, new THREE.CylinderGeometry(0.26, 0.26, 1.5, 8), bm, 0, 0, 0).rotation.x = Math.PI / 2;
      part(b, new THREE.ConeGeometry(0.26, 0.6, 8), bm, 0, 0, 1.05).rotation.x = Math.PI / 2;
      part(b, new THREE.BoxGeometry(0.7, 0.04, 0.4), dk, 0, 0, -0.85); part(b, new THREE.BoxGeometry(0.04, 0.7, 0.4), dk, 0, 0, -0.85);
      part(b, new THREE.BoxGeometry(0.1, 0.25, 0.8), dk, 0, 0.3, 0);
      v.bombs.push(b);
    }
    part(v.g, new THREE.CylinderGeometry(0.03, 0.03, 1.6, 4), dk, 0, 0.1, 11.2).rotation.x = Math.PI / 2;       // pitot
    part(v.g, new THREE.BoxGeometry(0.9, 0.5, 0.9), dk, 0, 0.9, 3.9);                                         // seat / pilot
    part(v.g, new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: .5 }), 0, 1.35, 4.2);   // pilot helmet
    for (const sx of [-1, 1]) {
      part(v.g, new THREE.BoxGeometry(0.08, 0.3, 1.2), dk, sx * 7.4, -0.1, -4.0);                           // wingtip rails
      part(v.g, new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: sx > 0 ? 0x40ff60 : 0xff4030 }), sx * 7.45, -0.1, -3.4);
      part(v.g, new THREE.BoxGeometry(2.6, 0.03, 0.12), dk, sx * 4.2, -0.08, -4.2);                          // flap lines
      part(v.g, new THREE.BoxGeometry(0.9, 1.2, 0.08), dk, sx * 1.35, -0.25, 3.72);                          // intake mouths
    }
    return v;
  }
  const v = buildShip(col);
  // extra detail: rails, lifeboats, radar, AA guns, flag, anchors
  const rail = new THREE.MeshStandardMaterial({ color: 0xcfd2d0, roughness: .7, flatShading: true });
  for (const sx of [-1, 1]) {
    part(v.g, new THREE.BoxGeometry(0.06, 0.06, 20), rail, sx * 3.8, 4.1, -5);
    for (let z = -15; z <= 5; z += 2.5) part(v.g, new THREE.BoxGeometry(0.06, 0.85, 0.06), rail, sx * 3.8, 3.68, z);
    const boat = part(v.g, new THREE.CapsuleGeometry(0.55, 2.2, 3, 6), rail, sx * 2.9, 5.0, -3.5); boat.rotation.x = Math.PI / 2; boat.scale.y = 1;
    part(v.g, new THREE.BoxGeometry(0.1, 1.4, 0.1), dk, sx * 2.9, 4.1, -2.4); part(v.g, new THREE.BoxGeometry(0.1, 1.4, 0.1), dk, sx * 2.9, 4.1, -4.6);
    for (const z of [10.5, -12.5]) {                                                                        // AA guns
      part(v.g, new THREE.CylinderGeometry(0.5, 0.6, 0.6, 8), v.mats[1], sx * 2.6, 3.55, z);
      const br = part(v.g, new THREE.CylinderGeometry(0.05, 0.05, 1.8, 5), dk, sx * 2.6, 4.3, z + 0.5); br.rotation.x = 0.9;
    }
    part(v.g, new THREE.BoxGeometry(0.25, 0.9, 0.7), dk, sx * 2.5, 2.2, 19.5);                              // anchors
    for (let z = -12; z <= 12; z += 3) part(v.g, new THREE.CylinderGeometry(0.16, 0.16, 0.05, 8), dk, sx * 3.92, 1.6, z).rotation.z = Math.PI / 2;   // portholes
  }
  const radar = new THREE.Group(); radar.position.set(0, 18.2, 4.2); v.g.add(radar); v.radar = radar;
  part(radar, new THREE.BoxGeometry(3.4, 1.0, 0.15), dk, 0, 0, 0);
  part(v.g, new THREE.CylinderGeometry(0.04, 0.04, 3.5, 4), dk, 0, 5, -22.6);
  part(v.g, new THREE.BoxGeometry(0.03, 0.9, 1.5), new THREE.MeshStandardMaterial({ color: col, roughness: .9, side: THREE.DoubleSide }), 0, 6.2, -23.4);
  part(v.g, new THREE.BoxGeometry(1.2, 0.5, 1.2), dk, 0, 9.5, 5.6);                                          // rangefinder
  part(v.g, new THREE.BoxGeometry(5.0, 0.3, 0.3), dk, 0, 9.7, 5.6);
  for (let z = 16; z <= 22; z += 1.2) part(v.g, new THREE.BoxGeometry(0.12, 0.12, 0.5), dk, 0, 3.35, z);       // anchor chain
  // rocket launcher on the aft deckhouse
  const lm = new THREE.MeshStandardMaterial({ color: new THREE.Color(col).multiplyScalar(0.75), roughness: .7, flatShading: true });
  const launcher = new THREE.Group(); launcher.position.set(0, 6.2, -9.2); v.g.add(launcher);
  const box = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.8, 4.2), lm); box.position.y = 1; box.rotation.x = -0.45; box.castShadow = true; launcher.add(box);
  for (let i = 0; i < 6; i++) { const c = new THREE.Mesh(new THREE.CircleGeometry(0.42, 8), new THREE.MeshBasicMaterial({ color: 0x1a1a1a })); c.position.set(-1.05 + (i % 3) * 1.05, 1.0 + (i < 3 ? 0.42 : -0.42) + 0.9, 2.1 + 0.4); c.rotation.x = -0.45; launcher.add(c); }
  v.launcher = launcher;
  return v;
}
function makeVehicle(d) {
  const vis = buildVis(d.type, d.team, d.n);
  scene.add(vis.g);
  const v = {
    vid: d.vid, team: d.team, type: d.type, n: d.n, vis, alive: d.alive, hp: d.hp, max: d.max, driver: d.driver,
    pos: new THREE.Vector3(), h: 0, p: 0, r: 0, speed: 0, aimYaw: 0, aimPitch: 0, f1: 0, f2: 0,
    tpos: new THREE.Vector3(), th: 0, tp: 0, tr: 0, tspeed: 0, recv: 0,
    inv: new THREE.Matrix4(), marker: null, dead: null, smokeT: 0, wheelA: 0, seen: false, seenT: 0, fireAcc: 0, mgT: 0
  };
  const mk = document.createElement('div');
  mk.className = 'mk'; mk.innerHTML = '<span></span><div class="bar"><i></i></div>';
  $('markers').appendChild(mk); v.marker = mk;
  vehicles.set(d.vid, v);
  resetVehicle(v, d);
  if (d.st) applyState(v, d.st, true);
  if (!d.alive) { v.vis.g.visible = false; }
  return v;
}
function spawnY(type, x, z) { return type === 'drone' ? Math.max(H(x, z), 0) + 0.35 : type === 'ship' ? 0 : type === 'plane' ? Math.max(H(x, z), 0) + 1.9 : Math.max(H(x, z), 0); }
function resetVehicle(v, d) {
  const sp = d.spawn;
  v.pos.set(sp.x, spawnY(v.type, sp.x, sp.z), sp.z); v.tpos.copy(v.pos);
  v.h = v.th = sp.yaw; v.p = v.r = v.tp = v.tr = 0; v.speed = v.tspeed = 0;
  v.aimYaw = sp.yaw; v.aimPitch = 0; v.f1 = 0; v.f2 = 0; v.dead = null;
  v.air = false; v.thr = 0; v.tel = 1; v.rudder = 0; v.crashSent = false; v.bombs = 3; v.rk = 8; v.loadT = 0; v.bat = 100; v.erect = 0; v.tmode = false; v.mload = 0; v.icbms = 2; v.altPrev = false;
  v.tgt = { x: BASES[1 - v.team].x, z: BASES[1 - v.team].z }; v.tzoom = 500;
  v.alive = true; v.hp = d.max || v.max;
  v.vis.g.visible = true;
  for (const m of v.vis.mats) m.color.copy(v.vis.color);
  updateVis(v, 0);
}
// st: [x, y, z, h, p, r, speed, aimYaw, aimPitch, f1, f2]
function applyState(v, s, snap) {
  v.tpos.set(s[0], s[1], s[2]); v.th = s[3]; v.tp = s[4]; v.tr = s[5]; v.tspeed = s[6];
  v.aimYaw = s[7]; v.aimPitch = s[8]; v.f1 = s[9] || 0; v.f2 = s[10] || 0;
  v.air = (v.type === 'plane' || v.type === 'drone') && !!v.f1;
  if (v.type === 'plane' && s[11] != null) { v.bombs = s[11]; v.rk = s[12] ?? v.rk; }
  v.recv = performance.now();
  if (snap) { v.pos.copy(v.tpos); v.h = v.th; v.p = v.tp; v.r = v.tr; v.speed = v.tspeed; }
}
function stateOf(v) {
  return [+v.pos.x.toFixed(2), +v.pos.y.toFixed(2), +v.pos.z.toFixed(2), +v.h.toFixed(3), +v.p.toFixed(3), +v.r.toFixed(3), +v.speed.toFixed(1), +v.aimYaw.toFixed(3), +v.aimPitch.toFixed(3), v.f1, v.f2, v.bombs, v.rk];
}
socket.on('st', (vid, s) => { const v = vehicles.get(vid); if (v && vid !== myVid) applyState(v, s, false); });
function updateRemote(v, dt, now) {
  if (!v.alive || v.dead) return;
  const driven = v.driver && v.driver !== myId;
  if (!driven) { v.speed *= Math.exp(-2 * dt); return; }
  const ex = Math.min(0.3, (now - v.recv) / 1000);
  const fly = v.type === 'plane' || v.type === 'drone';
  const f = fwd(v.th, fly ? v.tp : 0, _v1);
  const px = v.tpos.x + f.x * v.tspeed * ex, py = v.tpos.y + (fly ? f.y * v.tspeed * ex : 0), pz = v.tpos.z + f.z * v.tspeed * ex;
  const k = 1 - Math.exp(-dt * 10);
  if (v.pos.distanceTo(_v2.set(px, py, pz)) > 80) v.pos.set(px, py, pz);
  else { v.pos.x = lerp(v.pos.x, px, k); v.pos.y = lerp(v.pos.y, py, k); v.pos.z = lerp(v.pos.z, pz, k); }
  v.h = wrap(v.h + wrap(v.th - v.h) * k); v.p += (v.tp - v.p) * k; v.r += (v.tr - v.r) * k; v.speed = v.tspeed;
}
const _q = new THREE.Quaternion();
function updateVis(v, dt) {
  const g = v.vis.g;
  g.position.copy(v.pos);
  if (v.type === 'ship') g.position.y = Math.sin(performance.now() / 900 + v.n) * 0.25;
  g.rotation.set(-v.p, v.h, v.r);
  const rel = wrap(v.aimYaw - v.h);
  if (v.type === 'tank') {
    v.vis.turret.rotation.y = rel;
    v.vis.gun.rotation.x = -(v.aimPitch - v.p * Math.cos(rel));
    v.wheelA += v.speed * dt / 0.37;
    for (const w of v.vis.wheels) w.rotation.x = v.wheelA * 0.37 / (w.userData.r || 0.37);
    for (const t of v.vis.tracks) t.offset.y -= v.speed * dt * 0.6;
  } else if (v.type === 'jeep') {
    v.vis.turret.rotation.y = rel;
    v.vis.gun.rotation.x = -v.aimPitch;
    v.wheelA += v.speed * dt / 0.44;
    for (const w of v.vis.wheels) w.rotation.x = v.wheelA;
  } else if (v.type === 'icbm') {
    v.vis.canister.rotation.x = -v.f2 * 1.5;
    v.wheelA += v.speed * dt / 0.82;
    for (const w of v.vis.wheels) w.rotation.x = v.wheelA;
  } else if (v.type === 'drone') {
    if (v.air) for (const p of v.vis.props) p.rotation.y += dt * 60;
  } else if (v.type === 'gunner') {
    v.vis.turret.rotation.y = rel;
    v.vis.gun.rotation.x = -v.aimPitch;
  } else if (v.type === 'plane') {
    v.vis.gear.visible = !v.air;
    v.vis.bombs.forEach((b, i) => { b.visible = i < v.bombs; });
    v.vis.missiles.forEach((m, i) => { m.visible = v.rk > i * 4; });
    const k = v.air ? 0.4 + v.f2 * 0.8 : v.f2 * 0.5;
    v.vis.flame.scale.set(1, 0.3 + k, 1); v.vis.core.scale.set(1, 0.3 + k, 1);
    v.vis.flame.visible = v.vis.core.visible = v.alive && !v.dead && (v.f2 > 0.05 || v.air);
  } else if (v.type === 'ship') {
    for (let i = 0; i < 3; i++) {
      const T = TURRETS[i];
      let a = wrap(rel - T.rest); a = Math.max(-ARC, Math.min(ARC, a));
      v.vis.turrets[i].g.rotation.y = T.rest + a;
      v.vis.turrets[i].gun.rotation.x = -Math.max(-0.05, Math.min(0.6, v.aimPitch));
    }
    v.vis.radar.rotation.y += dt * 2;
  }
  g.updateMatrixWorld(true);
  v.inv.copy(g.matrixWorld).invert();
}
function syncVehicles() {
  if (!room) return;
  for (const d of room.vehicles) {
    let v = vehicles.get(d.vid);
    if (!v) { v = makeVehicle(d); continue; }
    v.hp = d.hp; v.max = d.max; v.driver = d.driver;
    if (!d.alive && v.alive && !v.dead) { v.alive = false; v.vis.g.visible = false; }
    if (d.alive && !v.alive && !v.dead) { resetVehicle(v, d); if (d.st) applyState(v, d.st, true); }
  }
}
function clearVehicles() { for (const v of vehicles.values()) { scene.remove(v.vis.g); v.marker.remove(); } vehicles.clear(); }
function destroyVis(v) {
  v.alive = false;
  v.dead = { t: 0, vy: v.type === 'plane' && v.air ? Math.min(0, fwd(v.h, v.p, _v1).y * v.speed) : 0, spin: (Math.random() - .5) * 2 };
  for (const m of v.vis.mats) m.color.multiplyScalar(0.3);
  if (v.type === 'plane') v.vis.flame.visible = v.vis.core.visible = false;
  const big = v.type === 'ship' ? 3 : v.type === 'tank' ? 1.6 : 1.2;
  particles.explosion(v.pos.clone().setY(v.pos.y + 2), big);
  audio.boom(v.pos, 1.3);
  if (v.type === 'tank' && v.vis.turret) v.vis.turret.rotation.z = 0.25;
  if (v.type === 'drone') v.vis.g.visible = false;
}
function updateDead(v, dt) {
  const d = v.dead; d.t += dt;
  if (v.type === 'plane' && d.vy !== null) {
    const ground = Math.max(H(v.pos.x, v.pos.z), 0);
    if (v.pos.y > ground + 1.5) {
      d.vy -= 25 * dt; v.pos.y += d.vy * dt;
      v.pos.addScaledVector(fwd(v.h, 0, _v1), v.speed * 0.6 * dt);
      v.r += d.spin * dt; v.p = Math.max(-1, v.p - 0.4 * dt);
      if (v.pos.y <= ground + 1.5) { v.pos.y = ground + 1; particles.explosion(v.pos, 1.3); audio.boom(v.pos, 1); }
    }
  }
  if (v.type === 'ship') { v.pos.y -= 1.2 * dt; v.r += 0.04 * dt; }
  v.smokeT -= dt;
  if (v.smokeT <= 0 && d.t < 20) { v.smokeT = 0.15; particles.smoke(_v1.copy(v.pos).setY(v.pos.y + 2.5), true); if (d.t < 6) particles.fire(_v1.copy(v.pos).setY(v.pos.y + 1.5)); }
  if (d.t > 22 && (v.type === 'ship' || H(v.pos.x, v.pos.z) < 0)) v.vis.g.visible = false;   // wrecks on land stay
}

// ═══════════ PROJECTILES ═══════════
// shells (ballistic), bullets (fast, light drop), rockets (straight or guided to a point), SAM missiles (homing)
const shots = [];
const bulletGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 4); bulletGeo.rotateX(Math.PI / 2);
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
const shellGeo = new THREE.SphereGeometry(0.22, 6, 4);
const shellMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });
const rocketGeo = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 6); rocketGeo.rotateX(Math.PI / 2);
const rocketMat = new THREE.MeshStandardMaterial({ color: 0xd8d6cc, roughness: .5 });
const bombGeo = new THREE.CapsuleGeometry(0.28, 1.4, 3, 8); bombGeo.rotateX(Math.PI / 2);
const bombMat = new THREE.MeshStandardMaterial({ color: 0x3d4630, roughness: .6 });
const icbmGeo = (() => { const g = new THREE.CylinderGeometry(0.85, 0.85, 12, 10); g.rotateX(Math.PI / 2); return g; })();
const icbmMat = new THREE.MeshStandardMaterial({ color: 0x5d6648, roughness: .5, metalness: .3 });
const ICBM_T = 25, ICBM_R = 50;
const GRAV = 9.8;
const SPEC = {
  shell: { speed: 330, grav: 1, life: 6, geo: shellGeo, mat: shellMat, boom: 1.0 },
  navshell: { speed: 300, grav: 1, life: 8, geo: shellGeo, mat: shellMat, boom: 1.1 },
  mg: { speed: 650, grav: 0.3, life: 1.6, geo: bulletGeo, mat: tracerMat, len: 4 },
  cannon: { speed: 900, grav: 0.2, life: 1.4, geo: bulletGeo, mat: tracerMat, len: 7 },
  icbm: { speed: 0, grav: 0, life: 60, geo: icbmGeo, mat: icbmMat, boom: 6, trail: true },
  bomb: { speed: 0, grav: 1.6, life: 25, geo: bombGeo, mat: bombMat, boom: 2.4, splash: 18 },
  rocket: { speed: 230, grav: 0.15, life: 8, geo: rocketGeo, mat: rocketMat, boom: 1.0, splash: 7, trail: true },
  navrocket: { speed: 170, grav: 0, life: 10, geo: rocketGeo, mat: rocketMat, boom: 1.2, splash: 9, trail: true },
};
// spawn a projectile; mine=true means I simulate hits and report them
function spawnShot(k, o, vel, mine, ownerVid, extra = {}) {
  const sp = SPEC[k];
  const mesh = new THREE.Mesh(sp.geo, sp.mat);
  if (sp.len) mesh.scale.z = sp.len;
  mesh.position.copy(o); scene.add(mesh);
  shots.push(Object.assign({ k, pos: o.clone(), vel: vel.clone(), mine, ownerVid, age: 0, mesh, trailT: 0 }, extra));
}
function teamOfVid(vid) { const v = vehicles.get(vid); return v ? v.team : -1; }
function hitVehicle(v, k, pt, scale = 1) {
  const dmg = Math.round((DMG[k][v.type] ?? DMG[k].jeep) * scale);
  if (dmg <= 0) return;
  socket.emit('hit', { vid: v.vid, dmg, k, pt: [+pt.x.toFixed(1), +pt.y.toFixed(1), +pt.z.toFixed(1)] });
}
function impact(s, pt, kind, v) {
  const sp = SPEC[s.k];
  if (kind === 'water') particles.splash(pt, sp.boom ? 1.4 : 0.4);
  else if (kind === 'veh' && !sp.boom) particles.spark(pt);
  else if (!sp.boom) particles.dirt(pt);
  if (sp.boom) { particles.explosion(pt, sp.boom); audio.boom(pt, sp.boom * 0.8); if (s.k === 'bomb') shake = Math.max(shake, Math.max(0, 1 - pt.distanceTo(camera.position) / 300)); }
  else if (kind === 'veh') audio.at('ricochet', pt, 0.35, 1.2, 300);
  if (!s.mine) return;
  const myTeam = teamOfVid(s.ownerVid);
  if (kind === 'veh' && v && v.team !== myTeam) hitVehicle(v, s.k, pt);
  if (sp.splash) for (const o of vehicles.values()) {   // blast damage nearby
    if (!o.alive || o === v || o.team === myTeam) continue;
    const d = o.pos.distanceTo(pt);
    if (d < sp.splash + 3) hitVehicle(o, s.k, pt, 0.55 * (1 - d / (sp.splash + 3)));
  }
}
const _o3 = [0, 0, 0], _d3 = [0, 0, 0];
function updateShots(dt) {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i], sp = SPEC[s.k];
    s.age += dt;
    if (s.k === 'icbm') {   // ballistic arc: up, over the top, down onto the target
      if (!s.o0) s.o0 = s.pos.clone();
      const u = Math.min(1, s.age / ICBM_T), e = u * u * (3 - 2 * u);
      const px = s.pos.x, py = s.pos.y, pz = s.pos.z;
      s.pos.set(lerp(s.o0.x, s.target.x, e), lerp(s.o0.y, s.target.y, u) + 1100 * 4 * u * (1 - u), lerp(s.o0.z, s.target.z, e));
      s.vel.set(s.pos.x - px, s.pos.y - py, s.pos.z - pz); if (s.vel.lengthSq() < 1e-6) s.vel.set(0, 1, 0);
      s.mesh.position.copy(s.pos); s.mesh.lookAt(_v1.copy(s.pos).add(s.vel));
      for (let k = 0; k < 3; k++) { particles.mtrail(_v1.copy(s.pos).addScaledVector(s.vel, -k * 0.3)); particles.mflame(s.pos); }
      if (u >= 1) { icbmImpact(s); scene.remove(s.mesh); shots.splice(i, 1); }
      continue;
    }
    // guided naval rockets: climb, then dive onto the target point
    const tvv = s.tv ? vehicles.get(s.tv) : null;
    if (tvv && tvv.alive && !(s.k === 'rocket' && s.age > 7)) { (s.target || (s.target = new THREE.Vector3())).copy(tvv.pos); s.target.y += tvv.type === 'ship' ? 4 : 1.2; }
    else if (s.tv) { s.tv = null; if (s.k === 'rocket') s.target = null; }
    if (s.target) {
      const want = _v1.copy(s.target).sub(s.pos);
      const dist = want.length();
      if (s.k === 'navrocket') { if (s.age < 0.9) want.set(s.vel.x, Math.abs(s.vel.length()), s.vel.z); else if (dist > 260) want.y += dist * 0.25; }
      want.normalize();
      const dir = _v2.copy(s.vel).normalize();
      const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(want))));
      if (ang > 1e-4) dir.lerp(want, Math.min(1, 1.6 * dt / ang)).normalize();
      const spd = Math.min(sp.speed * 1.5, s.vel.length() + 60 * dt);
      s.vel.copy(dir).multiplyScalar(spd);
    } else s.vel.y -= GRAV * sp.grav * dt;
    const step = s.vel.length() * dt;
    _o3[0] = s.pos.x; _o3[1] = s.pos.y; _o3[2] = s.pos.z;
    _d3[0] = s.vel.x / (step / dt); _d3[1] = s.vel.y / (step / dt); _d3[2] = s.vel.z / (step / dt);
    const hit = castRay(_o3, _d3, step, s.ownerVid, { step: Math.max(2, step / 4) });
    if (hit) {
      const pt = new THREE.Vector3(_o3[0] + _d3[0] * hit.t, _o3[1] + _d3[1] * hit.t, _o3[2] + _d3[2] * hit.t);
      impact(s, pt, hit.kind, hit.v);
      scene.remove(s.mesh); shots.splice(i, 1); continue;
    }
    s.pos.addScaledVector(s.vel, dt);
    if (s.age > sp.life) {
      if (sp.boom && s.target) impact(s, s.pos.clone(), 'air', null);
      scene.remove(s.mesh); shots.splice(i, 1); continue;
    }
    s.mesh.position.copy(s.pos);
    s.mesh.lookAt(_v1.copy(s.pos).add(s.vel));
    if (sp.trail) { s.trailT -= dt; if (s.trailT <= 0) { s.trailT = 0.03; particles.mtrail(s.pos); particles.mflame(s.pos); } }
  }
}
socket.on('shot', (pid, s) => {
  if (!inGame || !s || !SPEC[s.k]) return;
  const o = new THREE.Vector3(...s.o), vel = new THREE.Vector3(...s.v);
  spawnShot(s.k, o, vel, false, s.vid, Object.assign(s.t ? { target: new THREE.Vector3(...s.t) } : {}, s.tv ? { tv: s.tv } : {}));
  if (s.tv && s.tv === myVid) { logMsg('<b style="color:#ff6a50">По вам пущена ракета!</b>'); audio.tone(1300, 0.25, 0.07); }
  if (s.k === 'icbm') { centerMsg('РАКЕТНЫЙ УДАР!', 'цель отмечена на карте · ' + ICBM_T + ' с до удара', 4000, '#ff5a46'); for (let k = 0; k < 6; k++) setTimeout(() => audio.tone(k % 2 ? 620 : 880, 0.3, 0.07), k * 330); audio.at('shoot', o, 2, 0.4, 3000); return; }
  if (s.k === 'mg' || s.k === 'cannon') { if (Math.random() < 0.5) audio.at('shoot', o, 0.25, s.k === 'mg' ? 1.9 : 2.4, 700); }
  else { audio.at('shoot', o, s.k === 'navshell' ? 1.2 : 1, s.k.includes('rocket') ? 0.6 : 0.8); particles.muzzle(o, vel.clone().normalize()); }
});
function icbmImpact(s) {
  const pt = s.target;
  particles.explosion(pt, 7);
  for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; setTimeout(() => particles.explosion(new THREE.Vector3(pt.x + Math.cos(a) * 22, pt.y + 2, pt.z + Math.sin(a) * 22), 3), 80 + k * 60); }
  audio.boom(pt, 2.5); setTimeout(() => audio.boom(pt, 2), 250);
  shake = Math.max(shake, Math.max(0.2, 1.4 - pt.distanceTo(camera.position) / 700));
  if (!s.mine) return;
  const myT = teamOfVid(s.ownerVid);
  for (const o of vehicles.values()) {
    if (!o.alive || o.team === myT) continue;
    const d = Math.hypot(o.pos.x - pt.x, o.pos.z - pt.z);
    if (d > ICBM_R) continue;
    socket.emit('hit', { vid: o.vid, dmg: d < 16 ? 300 : Math.round(150 * (1 - d / ICBM_R)), k: 'icbm', pt: [+o.pos.x.toFixed(1), +o.pos.y.toFixed(1), +o.pos.z.toFixed(1)] });
  }
}
function fireShot(k, o, dir, extra = {}) {
  const vel = dir.clone().multiplyScalar(SPEC[k].speed);
  if (extra.inherit) vel.add(extra.inherit);
  spawnShot(k, o, vel, true, myVid, Object.assign(extra.target ? { target: extra.target.clone() } : {}, extra.tv ? { tv: extra.tv } : {}));
  socket.emit('shot', { k, vid: myVid, o: [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)], v: [+vel.x.toFixed(1), +vel.y.toFixed(1), +vel.z.toFixed(1)], t: extra.target ? [+extra.target.x.toFixed(1), +extra.target.y.toFixed(1), +extra.target.z.toFixed(1)] : null, tv: extra.tv || null });
}
function clearShots() { for (const s of shots) scene.remove(s.mesh); shots.length = 0; for (const m of sams) scene.remove(m.mesh); sams.length = 0; }

// ═══════════ ПВО ═══════════
// each client runs the enemy SAM sites against its own plane only
const SAM_RANGE = 1500, SAM_LOCK = 2, SAM_CD = 6, SAM_HOME = 6, SAM_SPEED = 300, SAM_TURN = 1.6;
const sams = [];      // SAM missiles in flight
let samLock = 0, samSeq = 0, flares = 3, flareCd = 0;
const samGeo = new THREE.CylinderGeometry(0.25, 0.25, 3.2, 6); samGeo.rotateX(Math.PI / 2);
function updateSamSites(dt, now) {
  if (!world) return;
  const me_ = myVehicle();
  const target = me_ && me_.type === 'plane' && me_.air && me_.alive ? me_ : null;
  let lvl = 0;
  for (const s of world.samSites) {
    s.spin += dt * (s.lockT > 0 ? 4 : 1);
    s.rad.rotation.y = s.spin;
    s.cd -= dt;
    let sees = false;
    if (target && s.team !== target.team && now > matchStartAt) {
      const d = s.top.distanceTo(target.pos);
      if (d < SAM_RANGE) {
        _o3[0] = s.top.x; _o3[1] = s.top.y + 3; _o3[2] = s.top.z;
        const dx = target.pos.x - _o3[0], dy = target.pos.y - _o3[1], dz = target.pos.z - _o3[2];
        _d3[0] = dx / d; _d3[1] = dy / d; _d3[2] = dz / d;
        sees = rayTerrain(_o3, _d3, d - 5, 8) === null;
      }
    }
    if (sees) { s.lockT += dt; s.turn.rotation.y += (Math.atan2(target.pos.x - s.x, target.pos.z - s.z) - s.turn.rotation.y) * Math.min(1, dt * 3); }
    else s.lockT = Math.max(0, s.lockT - dt);
    if (s.lockT > 0) lvl = Math.max(lvl, s.lockT > SAM_LOCK * 0.5 ? 2 : 1);
    if (sees && s.lockT >= SAM_LOCK && s.cd <= 0) {
      s.cd = SAM_CD; s.lockT = SAM_LOCK * 0.5;
      const o = s.top.clone().add(_v1.set(0, 3, 0));
      const vel = new THREE.Vector3(Math.sin(s.turn.rotation.y) * 40, 80, Math.cos(s.turn.rotation.y) * 40);
      const id = myId + ':s' + samSeq++;
      launchSam({ id, pos: o, vel, target: myVid, mine: true });
      socket.emit('missile', { id, o: [o.x, o.y, o.z], v: [vel.x, vel.y, vel.z], t: myVid });
    }
  }
  samLock = lvl;
}
function launchSam(m) {
  m.age = 0; m.decoy = null; m.mesh = new THREE.Mesh(samGeo, rocketMat); m.mesh.position.copy(m.pos); scene.add(m.mesh);
  sams.push(m);
  audio.at('shoot', m.pos, 1.6, 0.5); particles.explosion(m.pos, 0.3);
}
socket.on('missile', (pid, m) => { if (inGame && m) launchSam({ id: m.id, pos: new THREE.Vector3(...m.o), vel: new THREE.Vector3(...m.v), target: m.t, mine: false }); });
socket.on('mboom', (pid, m) => { const i = sams.findIndex(x => x.id === m.id); if (i >= 0) { particles.explosion(sams[i].pos, 0.8); audio.boom(sams[i].pos, 0.7); scene.remove(sams[i].mesh); sams.splice(i, 1); } });
socket.on('flare', pid => {
  const p = room && room.players.find(q => q.id === pid); const v = p && vehicles.get(p.vid);
  if (!v) return;
  for (let i = 0; i < 6; i++) particles.flare(v.pos, _v1.set((Math.random() - .5) * 30, -6 - Math.random() * 8, (Math.random() - .5) * 30));
  for (const m of sams) if (m.target === v.vid && !m.decoy && Math.random() < 0.75) m.decoy = { pos: v.pos.clone().add(_v2.set(0, -30, 0)) };
  for (const s of shots) if (s.tv === v.vid && s.k === 'rocket' && Math.random() < 0.7) { s.tv = null; s.target = null; }
});
function updateSams(dt) {
  for (let i = sams.length - 1; i >= 0; i--) {
    const m = sams[i];
    m.age += dt;
    const tv = vehicles.get(m.target);
    let want = null;
    if (m.age > 0.6 && m.age < SAM_HOME) {
      if (m.decoy) want = _v1.copy(m.decoy.pos).sub(m.pos).normalize();
      else if (tv && tv.alive) want = _v1.copy(tv.pos).sub(m.pos).normalize();
    }
    const dir = _v2.copy(m.vel).normalize();
    if (want) { const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(want)))); if (ang > 1e-4) dir.lerp(want, Math.min(1, SAM_TURN * dt / ang)).normalize(); }
    const mspd = Math.min(SAM_SPEED, m.vel.length() + 160 * dt);
    m.vel.copy(dir).multiplyScalar(mspd);
    m.pos.addScaledVector(m.vel, dt);
    m.mesh.position.copy(m.pos); m.mesh.lookAt(_v3.copy(m.pos).add(m.vel));
    particles.mtrail(m.pos);
    let boom = m.age > 9 || m.pos.y < H(m.pos.x, m.pos.z);
    if (m.decoy && m.pos.distanceTo(m.decoy.pos) < 10) boom = true;
    if (m.mine && tv && tv.alive && m.pos.distanceTo(tv.pos) < 9) { boom = true; socket.emit('samhit'); }
    if (boom) {
      particles.explosion(m.pos, 0.8); audio.boom(m.pos, 0.8);
      if (m.mine) socket.emit('mboom', { id: m.id });
      scene.remove(m.mesh); sams.splice(i, 1);
    }
  }
}

// ═══════════ INPUT ═══════════
const keys = {};
let camYaw = 0, camPitch = -0.1, camDist = 14, zoom = false, mouseFire = false, mouseAlt = false, locked = false, chatOpen = false, quietUnlock = false;
const CAM = { tank: [9, 34, 15], jeep: [7, 28, 11], plane: [16, 60, 26], ship: [40, 140, 70], gunner: [3, 12, 6], icbm: [16, 55, 26], drone: [0, 0, 0] };   // min, max, default distance
addEventListener('keydown', e => {
  if (chatOpen) {
    if (e.key === 'Enter') { const t = $('chatin').value.trim(); if (t) socket.emit('chat', t); closeChat(); }
    if (e.key === 'Escape') closeChat();
    return;
  }
  if (!inGame) return;
  if (keys[e.code]) return;
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); $('board').classList.add('on'); renderBoard(); }
  if (e.code === 'KeyM') audio.toggle();
  if (e.code === 'Enter') { e.preventDefault(); openChat(); }
  if (e.code === 'Escape' && mode === 'cmd') { $('pLobbyBtn').style.display = isHost() ? '' : 'none'; showScreen($('pause').classList.contains('on') ? null : 'pause'); }
  const v = myVehicle();
  if (mode === 'drive' && v && v.alive) {
    if (e.code === 'KeyX') leaveVehicle(true);
    if (v.type === 'ship') {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') v.tel = Math.min(SHIP_TEL.length - 1, v.tel + 1);
      if (e.code === 'KeyS' || e.code === 'ArrowDown') v.tel = Math.max(0, v.tel - 1);
    }
    if (e.code === 'KeyQ') mouseAlt = true;
    if (e.code === 'KeyF' && v.type === 'plane') dropFlares();
    if ((e.code === 'Space' || e.code === 'KeyB') && v.type === 'plane') { e.preventDefault(); dropBomb(); }
  }
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') $('board').classList.remove('on'); if (e.code === 'KeyQ') mouseAlt = false; });
function openChat() { chatOpen = true; const c = $('chatin'); c.style.display = 'block'; c.value = ''; quietUnlock = true; document.exitPointerLock && document.exitPointerLock(); setTimeout(() => c.focus(), 0); }
function closeChat() { chatOpen = false; const c = $('chatin'); c.style.display = 'none'; c.blur(); if (mode === 'drive') lockPointer(); }
function lockPointer() { if (inGame && canvas.requestPointerLock) { try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {} } }
canvas.addEventListener('mousedown', e => {
  if (!inGame) return;
  audio.unlock();
  if (mode === 'cmd') return cmdMouseDown(e);
  if (!locked) { lockPointer(); return; }
  if (e.button === 0) mouseFire = true;
  if (e.button === 2) mouseAlt = true;
});
addEventListener('mouseup', e => { if (e.button === 0) mouseFire = false; if (e.button === 2) { mouseAlt = false; cmdDrag = null; } });
canvas.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked) { mouseFire = false; mouseAlt = false; }
  if (!locked && inGame && mode === 'drive' && !quietUnlock && !chatOpen && !$('result').classList.contains('on')) { $('pLobbyBtn').style.display = isHost() ? '' : 'none'; showScreen('pause'); }
  quietUnlock = false;
  if (locked) showScreen(null);
});
addEventListener('mousemove', e => {
  if (mode === 'cmd') return cmdMouseMove(e);
  if (!locked) return;
  const tv0 = myVehicle();
  if (tv0 && tv0.tmode) { const k = tv0.tzoom / innerHeight * 1.5; tv0.tgt.x = Math.max(-MAP_X, Math.min(MAP_X, tv0.tgt.x + e.movementX * k)); tv0.tgt.z = Math.max(-MAP_Z, Math.min(MAP_Z + 300, tv0.tgt.z + e.movementY * k)); return; }
  const s = zoom ? 0.0006 : 0.0021;
  camYaw -= e.movementX * s;
  camPitch = Math.max(-1.2, Math.min(1.2, camPitch - e.movementY * s));
});
addEventListener('wheel', e => {
  if (!inGame) return;
  if (mode === 'cmd') return cmdWheel(e);
  const v = myVehicle(); if (!v) return;
  const c = CAM[v.type];
  if (v.tmode) { v.tzoom = Math.max(200, Math.min(1400, v.tzoom * (e.deltaY > 0 ? 1.15 : 0.87))); return; }
  if (e.deltaY > 0 && camDist >= c[1] - 0.01) {
    // scrolled out past the farthest view: rise to the commander view
    if ((v.type === 'plane' || v.type === 'drone') && v.air) { logMsg('В воздухе: <b>X</b> — бросить управление (аппарат разобьётся)'); return; }
    leaveVehicle(false);
    return;
  }
  camDist = Math.max(c[0], Math.min(c[1], camDist * (e.deltaY > 0 ? 1.15 : 0.87)));
}, { passive: true });

// ═══════════ DRIVING ═══════════
const myVehicle = () => myVid ? vehicles.get(myVid) : null;
const SHIP_TEL = [-0.4, 0, 0.33, 0.66, 1];
const SHIP_TEL_TXT = ['НАЗАД', 'СТОП', '1/3', '2/3', 'ПОЛНЫЙ'];
let sendT = 0, shake = 0, warnText = '', repairT = 0, reload = 0, reload2 = 0, rockets = 6, bombCd = 0, lockVid = null, lockT = 0, lockBeep = 0;
const LOCK_TIME = 1.5, LOCK_RANGE = 1500, LOCK_CONE = 0.3;
const aimPt = new THREE.Vector3();
let aimHit = null;
function resetWeaponsFor(type) { reload = 0; reload2 = 0; rockets = 6; flares = 3; flareCd = 0; lockVid = null; lockT = 0; }
function inOwnBase(v) {
  if (v.type === 'ship') return Math.hypot(v.pos.x - PORT[v.team].x, v.pos.z - PORT[v.team].z) < 220;
  if (v.type === 'plane' && v.air) return false;
  const b = BASES[v.team];
  return Math.hypot(v.pos.x - b.x, v.pos.z - b.z) < BASE_R || (Math.abs(v.pos.x) > RWY.x0 - 40 && Math.sign(v.pos.x) === (v.team ? 1 : -1) && Math.abs(v.pos.z - RWY.z) < 80);
}
// where the camera is looking: the point the weapons aim at
function updateAim(v) {
  const d = fwd(camYaw, camPitch, _v1);
  _o3[0] = camera.position.x; _o3[1] = camera.position.y; _o3[2] = camera.position.z;
  _d3[0] = d.x; _d3[1] = d.y; _d3[2] = d.z;
  const h = castRay(_o3, _d3, 2500, myVid, { step: 6 });
  const t = h ? h.t : 2500;
  aimPt.set(_o3[0] + d.x * t, _o3[1] + d.y * t, _o3[2] + d.z * t);
  aimHit = h;
}
// aim at the middle of a vehicle under the crosshair, a little above the ground otherwise
function aimTargetY() {
  if (aimHit && aimHit.kind === 'veh') return Math.max(aimPt.y, aimHit.v.pos.y + (aimHit.v.type === 'ship' ? 5 : 1.4));
  return aimPt.y + 0.4;
}
// elevation that drops a shell of speed V onto a point dist away and dy higher
function ballisticElev(dist, dy, V, g) {
  const v2 = V * V, root = v2 * v2 - g * (g * dist * dist + 2 * dy * v2);
  if (root < 0) return 0.6;
  return Math.atan((v2 - Math.sqrt(root)) / (g * dist));
}
function groundFollow(v, x, z, len, wid) {
  const ch = Math.cos(v.h), sh = Math.sin(v.h);
  const hf = H(x + sh * len, z + ch * len), hb = H(x - sh * len, z - ch * len);
  const hl = H(x + ch * wid, z - sh * wid), hr = H(x - ch * wid, z + sh * wid);
  return { y: Math.max(H(x, z), (hf + hb) / 2, (hl + hr) / 2), p: Math.atan2(hf - hb, len * 2), r: Math.atan2(hl - hr, wid * 2) };
}
function blocked(x, z, r, self) {
  for (const b of world.boxes) if (Math.abs(x - b.x) < b.hx + r && Math.abs(z - b.z) < b.hz + r && b.y1 > H(x, z) + 0.5) return true;
  for (const o of vehicles.values()) {
    if (o === self || !o.vis.g.visible || o.type === 'plane' && o.air) continue;
    const rr = o.type === 'ship' ? 0 : o.type === 'tank' ? 3.2 : o.type === 'plane' ? 6 : o.type === 'gunner' ? 2 : o.type === 'drone' ? 0 : o.type === 'icbm' ? 6 : 2.4;
    if (rr && Math.hypot(x - o.pos.x, z - o.pos.z) < r + rr) return true;
  }
  return Math.abs(x) > MAP_X - 60 || z < -MAP_Z + 60 || z > MAP_Z;
}
function driveGround(v, dt, frozen) {
  const tank = v.type === 'tank';
  const thr = chatOpen ? 0 : (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const steer = chatOpen ? 0 : (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
  const maxF = tank ? 12 : 26, maxR = tank ? 5 : 9, acc = tank ? 5 : 9;
  const target = thr > 0 ? maxF : thr < 0 ? -maxR : 0;
  v.speed += Math.max(-acc * 1.5 * dt, Math.min(acc * dt, target - v.speed));
  const turn = tank ? steer * 0.75 * (v.speed < -0.5 ? -1 : 1) : steer * 0.85 * Math.max(-1, Math.min(1, v.speed / 7));
  if (frozen) return;
  const nh = wrap(v.h + turn * dt);
  const nx = v.pos.x + Math.sin(nh) * v.speed * dt, nz = v.pos.z + Math.cos(nh) * v.speed * dt;
  const r = tank ? 3 : 2.2;
  if (H(nx, nz) < -1.4) { v.speed = 0; warnText = 'ВОДА — ДАЛЬШЕ НЕ ПРОЕХАТЬ'; v.h = nh; }
  else if (blocked(nx, nz, r, v)) { v.speed *= -0.2; v.h = nh; }
  else { v.pos.x = nx; v.pos.z = nz; v.h = nh; }
  const gf = groundFollow(v, v.pos.x, v.pos.z, tank ? 3 : 1.6, tank ? 1.6 : 1);
  v.pos.y = gf.y; v.p += (gf.p - v.p) * Math.min(1, dt * 8); v.r += (gf.r - v.r) * Math.min(1, dt * 8);
  if (Math.abs(gf.p) > 0.6) v.speed *= Math.exp(-3 * dt);
  // turret: turn towards the aim point; gun elevates to land the shell there
  const tp = _v3.set(v.pos.x, v.pos.y + (tank ? 2.4 : 2.3), v.pos.z);
  const want = Math.atan2(aimPt.x - tp.x, aimPt.z - tp.z);
  const rate = tank ? 0.9 : 3.5;
  v.aimYaw = wrap(v.aimYaw + Math.max(-rate * dt, Math.min(rate * dt, wrap(want - v.aimYaw))));
  const dist = Math.hypot(aimPt.x - tp.x, aimPt.z - tp.z), dy = aimTargetY() - tp.y;
  const el = tank ? ballisticElev(dist, dy, SPEC.shell.speed, GRAV) : Math.atan2(dy, dist) + 0.5 * GRAV * 0.3 * dist / (SPEC.mg.speed * SPEC.mg.speed);
  v.aimPitch += (Math.max(-0.2, Math.min(tank ? 0.35 : 0.9, el)) - v.aimPitch) * Math.min(1, dt * (tank ? 4 : 12));
  // weapons
  reload = Math.max(0, reload - dt);
  if (tank) {
    if (mouseFire && reload <= 0 && !chatOpen) {
      reload = 4;
      v.vis.g.updateMatrixWorld(true);
      const o = v.vis.tip.getWorldPosition(new THREE.Vector3());
      const dir = fwd(v.aimYaw, v.aimPitch, new THREE.Vector3());
      fireShot('shell', o, dir);
      particles.muzzle(o, dir); audio.play('shoot', 1.3, 0, 0.75); shake = Math.max(shake, 0.45);
      v.speed -= 0.8;
    }
  } else {
    v.f1 = mouseFire && !chatOpen ? 1 : 0;
    if (v.f1) {
      v.fireAcc += dt;
      while (v.fireAcc > 0.09) {
        v.fireAcc -= 0.09;
        v.vis.g.updateMatrixWorld(true);
        const o = v.vis.tip.getWorldPosition(new THREE.Vector3());
        const dir = fwd(v.aimYaw + (Math.random() - .5) * 0.02, v.aimPitch + (Math.random() - .5) * 0.02, new THREE.Vector3());
        fireShot('mg', o, dir);
        particles.muzzle(o, dir); audio.play('shoot', 0.35, 0, 1.9);
      }
    } else v.fireAcc = Math.min(v.fireAcc, 0.09);
  }
  audio.engine(v.type, Math.abs(thr), Math.abs(v.speed) / maxF);
}
function drivePlane(v, dt, frozen) {
  if (!chatOpen) {
    if (keys.KeyW || keys.ArrowUp) v.thr = Math.min(1, v.thr + 0.6 * dt);
    if (keys.KeyS || keys.ArrowDown) v.thr = Math.max(0, v.thr - 0.6 * dt);
  }
  v.f2 = v.thr;
  const TAKEOFF = 55;
  if (!v.air) {
    // on wheels: taxi, take-off roll
    const steer = chatOpen ? 0 : (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    const braking = (keys.KeyS || keys.ArrowDown) && v.thr <= 0.01;
    v.speed += (v.thr * 16 - v.speed * 0.04 - (braking ? 14 : 0.8) * Math.sign(v.speed)) * dt;
    if (Math.abs(v.speed) < 0.3 && v.thr < 0.01) v.speed = 0;
    v.speed = Math.max(-3, v.speed);
    if (!frozen) {
      v.h = wrap(v.h + steer * (0.25 + 0.5 * Math.min(1, Math.abs(v.speed) / 12)) * dt * (v.speed > 25 ? 0.3 : 1));
      const nx = v.pos.x + Math.sin(v.h) * v.speed * dt, nz = v.pos.z + Math.cos(v.h) * v.speed * dt;
      if (blocked(nx, nz, 3, v)) { if (v.speed > 15) return crashMine(v, 'crash'); v.speed = 0; }
      else { v.pos.x = nx; v.pos.z = nz; }
    }
    const gy = H(v.pos.x, v.pos.z);
    if (gy < -0.5) return crashMine(v, 'water');
    v.pos.y = Math.max(gy, 0) + 1.9;
    const gf = groundFollow(v, v.pos.x, v.pos.z, 5, 3);
    if (Math.abs(gf.p) > 0.12 && v.speed > 25) return crashMine(v, 'crash');
    v.p = gf.p * 0.5 + (v.speed > TAKEOFF * 0.8 ? 0.05 : 0); v.r = gf.r * 0.5;
    if (v.speed > TAKEOFF && camPitch > 0.06 && !frozen) {
      v.air = true; v.p = 0.12; logMsg('Взлёт! Самолёт летит за мышью');
    } else if (v.speed > TAKEOFF) warnText = 'МЫШЬ ВВЕРХ — ВЗЛЁТ';
    else if (v.thr > 0.05 && v.speed > 5) warnText = 'РАЗБЕГ ' + Math.round(v.speed * 3.6) + ' / ' + Math.round(TAKEOFF * 3.6) + ' КМ/Ч';
  } else {
    // flying: chase the mouse-aim direction
    const desH = camYaw, desP = Math.max(-1.2, Math.min(1.2, camPitch));
    const turnK = Math.max(0.35, Math.min(1, (v.speed - 40) / 70));
    const dh = wrap(desH - v.h), dp = desP - v.p;
    let yawRate = Math.max(-1.1 * turnK, Math.min(1.1 * turnK, dh * 2.2));
    const rud = chatOpen ? 0 : (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    yawRate += rud * 0.4;
    let pitchRate = Math.max(-1 * turnK, Math.min(1 * turnK, dp * 2.2));
    if (v.speed < 48) { pitchRate -= (48 - v.speed) / 10 * 0.8; warnText = 'СВАЛИВАНИЕ — ТЯГУ!'; }
    if (!frozen) { v.h = wrap(v.h + yawRate * dt); v.p = Math.max(-1.25, Math.min(1.25, v.p + pitchRate * dt)); }
    const wantBank = Math.max(-1.2, Math.min(1.2, -yawRate * 1.1 - rud * 0.25));
    v.r += (wantBank - v.r) * (1 - Math.exp(-4 * dt));
    const target = 55 + v.thr * 105;
    v.speed += (target - v.speed) * 0.45 * dt - 28 * Math.sin(v.p) * dt;
    v.speed = Math.max(30, Math.min(230, v.speed));
    if (!frozen) v.pos.addScaledVector(fwd(v.h, v.p, _v1), v.speed * dt);
    if (v.pos.y > 1400) v.p = Math.min(v.p, -0.05);
    if (Math.abs(v.pos.x) > MAP_X + 200 || v.pos.z < -MAP_Z - 200 || v.pos.z > MAP_Z + 300) { warnText = 'ВЕРНИТЕСЬ В ЗОНУ БОЯ'; }
    const ground = Math.max(H(v.pos.x, v.pos.z), 0);
    const agl = v.pos.y - ground;
    if (agl < 80 && v.p < -0.12) warnText = 'ТЯНИ ВВЕРХ!';
    if (agl < 70 && v.speed < 85 && v.p > -0.2) warnText = 'ПОСАДКА: РОВНО И МЕДЛЕННО · S — ТОРМОЗ';
    // buildings
    let hitObj = false;
    if (v.pos.y < 80) for (const b of world.boxes) if (Math.abs(v.pos.x - b.x) < b.hx + 2 && Math.abs(v.pos.z - b.z) < b.hz + 2 && v.pos.y < b.y1) { hitObj = true; break; }
    if (hitObj) return crashMine(v, 'crash');
    // touching down
    if (agl < 1.9) {
      const gf = groundFollow(v, v.pos.x, v.pos.z, 5, 3);
      const ok = H(v.pos.x, v.pos.z) > 0 && v.speed < 82 && v.p > -0.22 && v.p < 0.3 && Math.abs(v.r) < 0.35 && Math.abs(gf.p) < 0.08 && Math.abs(gf.r) < 0.08;
      if (!ok) return crashMine(v, H(v.pos.x, v.pos.z) < 0 ? 'water' : 'crash');
      v.air = false; v.p = 0; v.r = 0; v.pos.y = ground + 1.9; v.thr = Math.min(v.thr, 0.2);
      logMsg('Посадка! <b>S</b> — тормоз');
    }
  }
  v.f1 = v.air ? 1 : 0;
  // guns: along the nose
  reload2 = Math.max(0, reload2 - dt);
  if (mouseFire && !chatOpen && !frozen) {
    v.fireAcc += dt;
    while (v.fireAcc > 0.075) {
      v.fireAcc -= 0.075;
      v.vis.g.updateMatrixWorld(true);
      const gun = v.vis.guns[(v.mgT++) % 2];
      const o = gun.getWorldPosition(new THREE.Vector3());
      const dir = fwd(v.h + (Math.random() - .5) * 0.012, v.p + (Math.random() - .5) * 0.012, new THREE.Vector3());
      fireShot('cannon', o, dir);
      audio.play('shoot', 0.28, 0, 2.3);
    }
  } else v.fireAcc = Math.min(v.fireAcc, 0.075);
  // lock-on: keep an enemy inside the cone ahead for 1.5 s, then right-click / Q sends homing rockets
  let best = null, bs = Infinity;
  if (v.air) {
    const nose = fwd(v.h, v.p, _v1);
    for (const o of vehicles.values()) {
      if (!o.alive || o.team === v.team || o.dead) continue;
      const dx = o.pos.x - v.pos.x, dy = o.pos.y - v.pos.y, dz = o.pos.z - v.pos.z, d = Math.hypot(dx, dy, dz);
      if (d > LOCK_RANGE || d < 40) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * nose.x + dy * nose.y + dz * nose.z) / d)));
      if (ang > LOCK_CONE) continue;
      const sc = ang + d / 6000 - (o.vid === lockVid ? 0.08 : 0);
      if (sc < bs) { bs = sc; best = o; }
    }
    if (best) {   // not through a hill
      _o3[0] = v.pos.x; _o3[1] = v.pos.y; _o3[2] = v.pos.z;
      const dx = best.pos.x - v.pos.x, dy = best.pos.y + 2 - v.pos.y, dz = best.pos.z - v.pos.z, d = Math.hypot(dx, dy, dz);
      _d3[0] = dx / d; _d3[1] = dy / d; _d3[2] = dz / d;
      if (rayTerrain(_o3, _d3, d - 6, 12) !== null) best = null;
    }
  }
  if (best && best.vid === lockVid) lockT += dt; else { lockVid = best ? best.vid : null; lockT = 0; }
  const lockedOn = lockVid && lockT >= LOCK_TIME;
  lockBeep -= dt;
  if (lockVid && lockBeep <= 0 && v.rk > 0) { audio.tone(lockedOn ? 1250 : 760, lockedOn ? 0.12 : 0.05, 0.035); lockBeep = lockedOn ? 0.16 : 0.32; }
  if (mouseAlt && reload2 <= 0 && v.rk > 0 && !chatOpen && !frozen) {
    reload2 = 0.5;
    v.vis.g.updateMatrixWorld(true);
    for (const sx of [-1, 1]) {
      if (v.rk <= 0) break;
      v.rk--;
      const o = _v2.set(sx * 4, -1, 1).applyMatrix4(v.vis.g.matrixWorld).clone();
      const dir = fwd(v.h, v.p, new THREE.Vector3());
      fireShot('rocket', o, dir, { inherit: dir.clone().multiplyScalar(v.speed * 0.6), tv: lockedOn ? lockVid : null });
    }
    audio.whoosh(0.8); audio.play('shoot', 0.6, 0, 0.6);
    logMsg(lockedOn ? 'Ракеты с наведением: <b style="color:#ff7a68">' + vName(vehicles.get(lockVid)) + '</b>' : 'Ракеты без захвата — летят прямо');
  }
  bombCd = Math.max(0, bombCd - dt);
  // rearm: parked at the home base for 30 s
  if (!v.air && Math.abs(v.speed) < 1 && inOwnBase(v) && (v.bombs < 3 || v.rk < 8 || flares < 3)) {
    v.loadT += dt;
    warnText = 'ЗАГРУЗКА БОМБ И РАКЕТ: ' + Math.ceil(30 - v.loadT) + ' с';
    if (v.loadT >= 30) { v.bombs = 3; v.rk = 8; flares = 3; v.loadT = 0; audio.play('energy', 0.7); centerMsg('ВООРУЖЕНИЕ ЗАГРУЖЕНО', '3 бомбы · 8 ракет', 1800, '#9bff7a'); }
  } else v.loadT = 0;
  flareCd = Math.max(0, flareCd - dt);
  audio.engine('plane', v.thr, Math.min(1, Math.abs(v.speed) / 160));
}
function dropBomb() {
  const v = myVehicle();
  if (!v || v.type !== 'plane' || !v.alive || chatOpen) return;
  if (!v.air) { logMsg('Бомбы сбрасываются только в воздухе'); return; }
  if (v.bombs <= 0) { logMsg('Бомб нет — сядьте на своей базе и подождите 30 с'); audio.tone(220, 0.1, 0.05); return; }
  if (bombCd > 0) return;
  bombCd = 0.6; v.bombs--;
  const o = v.pos.clone(); o.y -= 1.6;
  fireShot('bomb', o, new THREE.Vector3(0, -1, 0), { inherit: fwd(v.h, v.p, new THREE.Vector3()).multiplyScalar(v.speed) });
  audio.tone(420, 0.08, 0.05);
  logMsg('Бомба сброшена · осталось ' + v.bombs);
}
// where a bomb dropped right now would land
function bombImpact(v, out) {
  const f = fwd(v.h, v.p, _v1), g = GRAV * SPEC.bomb.grav;
  const vx = f.x * v.speed, vy = f.y * v.speed, vz = f.z * v.speed;
  let t = 3, gy = 0;
  for (let i = 0; i < 3; i++) {
    gy = Math.max(H(v.pos.x + vx * t, v.pos.z + vz * t), 0);
    const hh = Math.max(1, v.pos.y - 1.6 - gy);
    t = (vy + Math.sqrt(vy * vy + 2 * g * hh)) / g;
  }
  return out.set(v.pos.x + vx * t, gy, v.pos.z + vz * t);
}
function driveGunner(v, dt, frozen) {
  const want = Math.atan2(aimPt.x - v.pos.x, aimPt.z - v.pos.z);
  v.aimYaw = wrap(v.aimYaw + Math.max(-5 * dt, Math.min(5 * dt, wrap(want - v.aimYaw))));
  const dist = Math.hypot(aimPt.x - v.pos.x, aimPt.z - v.pos.z), dy = aimTargetY() - (v.pos.y + 1.3);
  const el = Math.atan2(dy, dist) + 0.5 * GRAV * 0.3 * dist / (SPEC.mg.speed * SPEC.mg.speed);
  v.aimPitch += (Math.max(-0.3, Math.min(1.0, el)) - v.aimPitch) * Math.min(1, dt * 14);
  v.f1 = mouseFire && !chatOpen && !frozen ? 1 : 0;
  if (v.f1) {
    v.fireAcc += dt;
    while (v.fireAcc > 0.075) {
      v.fireAcc -= 0.075;
      v.vis.g.updateMatrixWorld(true);
      const o = v.vis.tip.getWorldPosition(new THREE.Vector3());
      const dir = fwd(v.aimYaw + (Math.random() - .5) * 0.016, v.aimPitch + (Math.random() - .5) * 0.016, new THREE.Vector3());
      fireShot('mg', o, dir);
      particles.muzzle(o, dir); audio.play('shoot', 0.4, 0, 1.7); shake = Math.max(shake, 0.12);
    }
  } else v.fireAcc = Math.min(v.fireAcc, 0.075);
  audio.engineOff();
}
function driveIcbm(v, dt, frozen) {
  v.mload = Math.max(0, v.mload - dt);
  const thr = chatOpen ? 0 : (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const steer = chatOpen ? 0 : (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
  const stowed = !v.tmode && v.erect <= 0.01;
  const target = stowed ? (thr > 0 ? 10 : thr < 0 ? -4 : 0) : 0;
  v.speed += Math.max(-5 * dt, Math.min(2.2 * dt, target - v.speed));
  if (!stowed && thr) warnText = 'РАКЕТА ПОДНЯТА — ПКМ, ЧТОБЫ ОПУСТИТЬ И ЕХАТЬ';
  if (!frozen && Math.abs(v.speed) > 0.01) {
    const nh = wrap(v.h + steer * 0.3 * Math.max(-1, Math.min(1, v.speed / 5)) * dt);
    const nx = v.pos.x + Math.sin(nh) * v.speed * dt, nz = v.pos.z + Math.cos(nh) * v.speed * dt;
    let bad = H(nx, nz) < -1;
    for (const off of [8, 0, -8]) if (blocked(nx + Math.sin(nh) * off, nz + Math.cos(nh) * off, 2.2, v)) bad = true;
    if (bad) v.speed *= -0.2; else { v.pos.x = nx; v.pos.z = nz; v.h = nh; }
  }
  const gf = groundFollow(v, v.pos.x, v.pos.z, 8, 1.6);
  v.pos.y = gf.y; v.p += (gf.p - v.p) * Math.min(1, dt * 5); v.r += (gf.r - v.r) * Math.min(1, dt * 5);
  // right-click / Q: raise the missile and open the targeting view
  if (mouseAlt && !v.altPrev) {
    if (!v.tmode && Math.abs(v.speed) > 1) logMsg('Сначала остановитесь');
    else if (!v.tmode && v.icbms <= 0) logMsg('Ракет больше нет');
    else { v.tmode = !v.tmode; audio.tone(v.tmode ? 520 : 380, 0.1, 0.05); }
  }
  v.altPrev = mouseAlt;
  v.erect = Math.max(0, Math.min(1, v.erect + (v.tmode ? dt / 7 : -dt / 5)));
  if (v.tmode) {
    const far = Math.hypot(v.tgt.x - v.pos.x, v.tgt.z - v.pos.z);
    warnText = v.erect < 1 ? 'ПОДЪЁМ РАКЕТЫ ' + Math.round(v.erect * 100) + '%' : v.mload > 0 ? 'ПЕРЕЗАРЯДКА ' + Math.ceil(v.mload) + ' с' : far < 350 ? 'ЦЕЛЬ СЛИШКОМ БЛИЗКО' : 'КЛИК — ПУСК · ПКМ — ОТМЕНА';
    if (mouseFire && v.erect >= 1 && v.mload <= 0 && far >= 350 && v.icbms > 0 && !frozen && !chatOpen) {
      mouseFire = false; v.icbms--; v.mload = 90;
      v.vis.g.updateMatrixWorld(true);
      const o = v.vis.tip.getWorldPosition(new THREE.Vector3());
      const tgt = new THREE.Vector3(v.tgt.x, Math.max(H(v.tgt.x, v.tgt.z), 0), v.tgt.z);
      fireShot('icbm', o, new THREE.Vector3(0, 1, 0), { target: tgt });
      particles.explosion(o, 1.5); audio.play('shoot', 1.6, 0, 0.4); audio.whoosh(1.2); shake = 1;
      centerMsg('ПУСК!', 'удар через ' + ICBM_T + ' с · осталось ракет: ' + v.icbms, 3000, '#ffb03a');
      if (v.icbms <= 0) v.tmode = false;
    }
  }
  v.f1 = v.tmode ? 1 : 0; v.f2 = +v.erect.toFixed(2);
  v.aimYaw = v.h;
  audio.engine('tank', Math.abs(thr) * (stowed ? 1 : 0), Math.abs(v.speed) / 10);
}
function droneBoom(v, pt, hit) {
  if (v.crashSent) return;
  particles.explosion(pt, 1.3); audio.boom(pt, 1.1);
  if (hit && hit.kind === 'veh' && hit.v.team !== v.team && hit.v.alive) hitVehicle(hit.v, 'fpv', pt);
  for (const o of vehicles.values()) {
    if (!o.alive || o.team === v.team || o === v || (hit && hit.v === o)) continue;
    const d = o.pos.distanceTo(pt);
    if (d < 8) hitVehicle(o, 'fpv', pt, 0.5 * (1 - d / 8));
  }
  crashMine(v, 'fpv');
}
function driveDrone(v, dt, frozen) {
  if (!chatOpen) {
    if (keys.KeyW || keys.ArrowUp) v.thr = Math.min(1, v.thr + 1.2 * dt);
    if (keys.KeyS || keys.ArrowDown) v.thr = Math.max(0, v.thr - 1.6 * dt);
  }
  v.f2 = v.thr;
  if (!v.air) {
    v.f1 = 0; v.speed = 0;
    warnText = 'W — ВЗЛЁТ';
    if (v.thr > 0.05 && !frozen) { v.air = true; v.pos.y += 0.8; v.h = camYaw; logMsg('FPV в воздухе: летит туда, куда смотрите · W/S — скорость'); }
    audio.engine('jeep', v.thr, 0);
    return;
  }
  v.bat -= dt;
  const dh = wrap(camYaw - v.h);
  v.h = wrap(v.h + Math.max(-3.5, Math.min(3.5, dh * 7)) * dt);
  v.p += Math.max(-3, Math.min(3, (camPitch - v.p) * 7)) * dt;
  v.r += (Math.max(-0.9, Math.min(0.9, -dh * 2.5)) - v.r) * (1 - Math.exp(-6 * dt));
  v.speed += (v.thr * 42 - v.speed) * Math.min(1, 2.5 * dt);
  if (v.bat <= 0) { warnText = 'БАТАРЕЯ РАЗРЯЖЕНА'; v.p = Math.max(-1.3, v.p - 2 * dt); v.speed = Math.max(v.speed, 18); }
  else if (v.bat < 20) warnText = 'БАТАРЕЯ ' + Math.ceil(v.bat) + ' с';
  if (!frozen) {
    const f = fwd(v.h, v.p, _v1), step = v.speed * dt;
    if (step > 0.001) {
      _o3[0] = v.pos.x; _o3[1] = v.pos.y; _o3[2] = v.pos.z; _d3[0] = f.x; _d3[1] = f.y; _d3[2] = f.z;
      const hit = castRay(_o3, _d3, step + 0.9, v.vid, { step: 1 });
      if (hit) return droneBoom(v, new THREE.Vector3(_o3[0] + f.x * hit.t, _o3[1] + f.y * hit.t, _o3[2] + f.z * hit.t), hit);
      v.pos.addScaledVector(f, step);
    }
    if (v.pos.y < Math.max(H(v.pos.x, v.pos.z), 0) + 0.3) return droneBoom(v, v.pos.clone(), null);
    if (v.pos.y > 500) v.pos.y = 500;
  }
  v.f1 = 1; v.aimYaw = v.h; v.aimPitch = v.p;
  audio.engine('jeep', 0.5 + v.thr * 0.5, 0.4 + v.speed / 70);
}
function dropFlares() {
  const v = myVehicle();
  if (!v || !v.air || flares <= 0 || flareCd > 0) return;
  flares--; flareCd = 2;
  socket.emit('flare');
}
function driveShip(v, dt, frozen) {
  const rud = chatOpen ? 0 : (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
  v.rudder += Math.max(-dt, Math.min(dt, rud - v.rudder));
  const target = SHIP_TEL[v.tel] * 15;
  v.speed += Math.max(-1.2 * dt, Math.min(0.8 * dt, target - v.speed));
  const yawRate = v.rudder * 0.13 * Math.min(1, Math.abs(v.speed) / 5 + 0.1) * Math.sign(v.speed || 1);
  v.r += ((-yawRate * Math.abs(v.speed) * 0.05) - v.r) * (1 - Math.exp(-1.5 * dt));
  v.f1 = +v.rudder.toFixed(2);
  if (!frozen) {
    const nh = wrap(v.h + yawRate * dt);
    const nx = v.pos.x + Math.sin(nh) * v.speed * dt, nz = v.pos.z + Math.cos(nh) * v.speed * dt;
    let ok = true;
    for (const off of [22, 0, -22]) if (H(nx + Math.sin(nh) * off, nz + Math.cos(nh) * off) > -3.5) ok = false;
    for (const o of vehicles.values()) if (o !== v && o.type === 'ship' && o.vis.g.visible && Math.hypot(nx - o.pos.x, nz - o.pos.z) < 26) ok = false;
    if (Math.abs(nx) > MAP_X || nz > MAP_Z) ok = false;
    for (const b of world.boxes) if (b.y0 < 0 && Math.abs(nx - b.x) < b.hx + 5 && Math.abs(nz - b.z) < b.hz + 5) ok = false;
    if (ok) { v.pos.x = nx; v.pos.z = nz; v.h = nh; }
    else { v.speed *= Math.exp(-4 * dt); v.h = nh; warnText = 'МЕЛЬ / ПРЕПЯТСТВИЕ'; }
  }
  v.pos.y = 0;
  // turrets follow the aim; elevation for the arcing shells
  const want = Math.atan2(aimPt.x - v.pos.x, aimPt.z - v.pos.z);
  v.aimYaw = wrap(v.aimYaw + Math.max(-0.7 * dt, Math.min(0.7 * dt, wrap(want - v.aimYaw))));
  const dist = Math.hypot(aimPt.x - v.pos.x, aimPt.z - v.pos.z);
  v.aimPitch += (Math.min(0.6, ballisticElev(dist, aimTargetY() - 5, SPEC.navshell.speed, GRAV)) - v.aimPitch) * Math.min(1, dt * 3);
  reload = Math.max(0, reload - dt); reload2 = Math.max(0, reload2 - dt);
  if (mouseFire && reload <= 0 && !chatOpen && !frozen) {
    v.vis.g.updateMatrixWorld(true);
    let fired = 0;
    for (let i = 0; i < 3; i++) {
      const rel = wrap(v.aimYaw - v.h - TURRETS[i].rest);
      if (Math.abs(rel) > ARC) continue;
      for (const tip of v.vis.turrets[i].tips) {
        const o = tip.getWorldPosition(new THREE.Vector3());
        const dir = fwd(v.aimYaw + (Math.random() - .5) * 0.01, v.aimPitch + (Math.random() - .5) * 0.008, new THREE.Vector3());
        fireShot('navshell', o, dir); particles.muzzle(o, dir); fired++;
      }
    }
    if (fired) { reload = 5; audio.play('shoot', 1.5, 0, 0.6); shake = Math.max(shake, 0.35); }
    else logMsg('Орудия не достают — поверните корабль');
  }
  if (mouseAlt && reload2 <= 0 && !chatOpen && !frozen) {
    reload2 = 18;
    const shipTv = aimHit && aimHit.kind === 'veh' && aimHit.v.team !== v.team && aimHit.v.alive ? aimHit.v.vid : null;
    logMsg(shipTv ? 'Ракетный залп с наведением: <b style="color:#ff7a68">' + vName(aimHit.v) + '</b>' : 'Ракетный залп по точке');
    v.vis.g.updateMatrixWorld(true);
    for (let i = 0; i < 6; i++) setTimeout(() => {
      if (!v.alive || myVid !== v.vid) return;
      const o = _v2.set(-1.05 + (i % 3) * 1.05, 8.3, -7).applyMatrix4(v.vis.g.matrixWorld).clone();
      const tgt = aimPt.clone().add(new THREE.Vector3((Math.random() - .5) * 14, 0, (Math.random() - .5) * 14));
      fireShot('navrocket', o, new THREE.Vector3(Math.sin(v.h) * -0.3, 1, Math.cos(v.h) * -0.3).normalize(), { target: tgt, tv: shipTv });
      audio.whoosh(0.7);
    }, i * 180);
  }
  audio.engine('ship', Math.abs(SHIP_TEL[v.tel]), Math.abs(v.speed) / 15);
}
function crashMine(v, how) {
  if (v.crashSent) return;
  v.crashSent = true;
  socket.emit('crash', how);
  shake = 1;
}
function updateMe(dt, now) {
  const v = myVehicle();
  warnText = '';
  if (mode !== 'drive' || !v || !v.alive) { audio.engineOff(); return; }
  const frozen = now < matchStartAt;
  zoom = !!(keys.ShiftLeft || keys.ShiftRight) && v.type !== 'plane' && v.type !== 'drone';
  if (v.type === 'tank' || v.type === 'jeep') driveGround(v, dt, frozen);
  else if (v.type === 'plane') drivePlane(v, dt, frozen);
  else if (v.type === 'gunner') driveGunner(v, dt, frozen);
  else if (v.type === 'icbm') driveIcbm(v, dt, frozen);
  else if (v.type === 'drone') driveDrone(v, dt, frozen);
  else driveShip(v, dt, frozen);
  if (v.type === 'plane') { v.aimYaw = v.h; v.aimPitch = v.p; }
  // repair at home
  repairT -= dt;
  if (repairT <= 0 && inOwnBase(v) && v.hp < v.max) { repairT = 1; socket.emit('repair'); }
  sendT -= dt;
  if (sendT <= 0) { sendT = 0.05; socket.emit('st', stateOf(v)); }
}

// ═══════════ COMMANDER VIEW ═══════════
const cmd = { x: -1200, z: 60, h: 520, tx: -1200, tz: 60, th: 520 };
let cmdDrag = null, cmdHover = null, camTrans = 0, camTransAt = 0, mouseX = 0, mouseY = 0;
const _camFrom = new THREE.Vector3(), _camFromQ = new THREE.Quaternion();
function cmdCenterOn(x, z, h) { cmd.tx = x; cmd.tz = z; if (h) cmd.th = h; }
function cmdMouseMove(e) {
  mouseX = e.clientX; mouseY = e.clientY;
  if (cmdDrag) {
    const k = cmd.h / innerHeight * 1.6;
    cmd.tx -= (e.clientX - cmdDrag.x) * k; cmd.tz -= (e.clientY - cmdDrag.y) * k;
    cmdDrag = { x: e.clientX, y: e.clientY };
  }
}
function cmdMouseDown(e) {
  if (e.button === 2) { cmdDrag = { x: e.clientX, y: e.clientY }; return; }
  if (e.button === 0 && cmdHover) requestEnter(cmdHover.vid);
}
function cmdWheel(e) { cmd.th = Math.max(180, Math.min(1500, cmd.th * (e.deltaY > 0 ? 1.15 : 0.87))); }
function updateCmd(dt) {
  const s = cmd.h * 1.1 * dt;
  if (!chatOpen) {
    if (keys.KeyW || keys.ArrowUp) cmd.tz -= s;
    if (keys.KeyS || keys.ArrowDown) cmd.tz += s;
    if (keys.KeyA || keys.ArrowLeft) cmd.tx -= s;
    if (keys.KeyD || keys.ArrowRight) cmd.tx += s;
  }
  cmd.tx = Math.max(-MAP_X, Math.min(MAP_X, cmd.tx)); cmd.tz = Math.max(-MAP_Z, Math.min(MAP_Z + 200, cmd.tz));
  const k = 1 - Math.exp(-dt * 6);
  cmd.x += (cmd.tx - cmd.x) * k; cmd.z += (cmd.tz - cmd.z) * k; cmd.h += (cmd.th - cmd.h) * k;
  const gy = Math.max(0, H(cmd.x, cmd.z));
  _v1.set(cmd.x, gy + cmd.h, cmd.z + cmd.h * 0.62);
  camera.fov = 50;
  camera.updateProjectionMatrix();
  if (camTrans > 0) {   // smooth hand-over from the last vehicle camera
    camTrans = Math.max(0, 1 - (performance.now() - camTransAt) / 650);
    const t = 1 - camTrans * camTrans;
    camera.position.lerpVectors(_camFrom, _v1, t);
    _v2.set(cmd.x, gy, cmd.z);
    const q = _q.copy(camera.quaternion);
    camera.lookAt(_v2); const qt = camera.quaternion.clone();
    camera.quaternion.copy(_camFromQ).slerp(qt, t);
  } else { camera.position.copy(_v1); camera.lookAt(cmd.x, gy, cmd.z); }
  setShadowSize(Math.min(600, cmd.h * 0.9));
  placeSun(cmd.x, gy, cmd.z);
  // hover: own vehicle closest to the cursor
  cmdHover = null;
  let best = 46;
  if (room) for (const v of vehicles.values()) {
    if (!v.alive || !v.vis.g.visible || v.team !== myTeam()) continue;
    const p = project(_v3.copy(v.pos).setY(v.pos.y + 2));
    if (!p) continue;
    const d = Math.hypot(p[0] - mouseX, p[1] - mouseY);
    if (d < best) { best = d; cmdHover = v; }
  }
  const tip = $('cmdtip');
  if (cmdHover && !$('pause').classList.contains('on')) {
    tip.style.display = 'block'; tip.style.left = mouseX + 'px'; tip.style.top = mouseY + 'px';
    tip.textContent = vName(cmdHover) + ' · ' + (cmdHover.driver ? (cmdHover.driver === myId ? 'вы' : 'занят: ' + nameOf(cmdHover.driver)) : 'свободен — клик, чтобы сесть') + ' · ' + cmdHover.hp + '/' + cmdHover.max;
    canvas.style.cursor = cmdHover.driver && cmdHover.driver !== myId ? 'not-allowed' : 'pointer';
  } else { tip.style.display = 'none'; canvas.style.cursor = cmdDrag ? 'grabbing' : 'default'; }
}
const myTeam = () => { const p = me(); return p ? p.team : 0; };
const vName = v => TYPE_NAME[v.type] + ' ' + v.n;
function requestEnter(vid) {
  const v = vehicles.get(vid);
  if (!v || !v.alive) return;
  if (v.driver && v.driver !== myId) { logMsg('Эта техника занята'); audio.tone(220, 0.1, 0.05); return; }
  socket.emit('enter', vid, r => {
    if (!r || !r.ok) { logMsg(r && r.err ? r.err : 'Не удалось сесть'); return; }
    takeControl(v);
  });
}
function takeControl(v) {
  _camFrom.copy(camera.position); _camFromQ.copy(camera.quaternion);
  myVid = v.vid; mode = 'drive'; v.driver = myId; v.crashSent = false;
  v.tpos.copy(v.pos);
  if (v.type === 'ship') v.tel = 1;
  if (v.type === 'plane') v.thr = 0;
  resetWeaponsFor(v.type);
  camYaw = v.h; camPitch = v.type === 'plane' ? -0.08 : -0.12; camDist = CAM[v.type][2];
  camTrans = 1; camTransAt = performance.now();
  document.body.classList.remove('cmdv');
  $('cmdtip').style.display = 'none'; canvas.style.cursor = '';
  centerMsg(vName(v).toUpperCase(), v.type === 'plane' ? 'W — тяга · разгон и мышь вверх' : v.type === 'gunner' ? 'Мышь — прицел · клик — огонь · колесо вниз — выйти' : v.type === 'icbm' ? 'WASD — ехать · остановитесь и ПКМ — наведение ракеты' : v.type === 'drone' ? 'W — взлёт · летит за мышью · взрывается при ударе' : 'Колесо вниз — наверх, к выбору техники', 1500);
  lockPointer();
}
function leaveVehicle(force) {
  const v = myVehicle();
  if (v && (v.type === 'plane' || v.type === 'drone') && v.air && v.alive) { if (!force) return; crashMine(v, 'abandon'); }
  if (v) v.tmode = false;
  socket.emit('exit');
  goCommander(v);
}
function goCommander(v) {
  _camFrom.copy(camera.position); _camFromQ.copy(camera.quaternion);
  if (v) { v.driver = null; cmdCenterOn(v.pos.x, v.pos.z + 40, 360); cmd.x = cmd.tx; cmd.z = cmd.tz; cmd.h = 360; camTrans = 1; camTransAt = performance.now(); }
  myVid = null; mode = 'cmd';
  audio.engineOff();
  document.body.classList.add('cmdv');
  mouseFire = mouseAlt = false;
  quietUnlock = true;
  if (document.pointerLockElement) document.exitPointerLock(); else quietUnlock = false;
  renderCmdList();
}
let cmdListT = 0;
function renderCmdList() {
  if (!room) return;
  const team = myTeam();
  const rows = room.vehicles.filter(d => d.team === team).map(d => {
    const v = vehicles.get(d.vid);
    const st = !d.alive ? 'уничтожен' : d.driver ? (d.driver === myId ? 'вы' : nameOf(d.driver)) : 'свободен';
    const off = !d.alive || (d.driver && d.driver !== myId);
    return `<div class="vr ${off ? 'off' : ''} ${d.driver === myId ? 'mine' : ''}" data-v="${d.vid}"><span class="ic">${TYPE_ICON[d.type]}</span><span class="nm">${TYPE_NAME[d.type]} ${d.n}<br><span class="st">${st}</span></span><span class="hb"><i style="width:${Math.round(d.hp / d.max * 100)}%"></i></span></div>`;
  }).join('');
  $('cmdlist').innerHTML = rows;
  $('cmdlist').querySelectorAll('.vr').forEach(el => {
    el.onclick = () => requestEnter(el.dataset.v);
    el.onmouseenter = () => { const v = vehicles.get(el.dataset.v); if (v && v.alive) cmdCenterOn(v.pos.x, v.pos.z + 40); };
  });
}

// ═══════════ VEHICLE CAMERA ═══════════
function updateDriveCam(dt) {
  const v = myVehicle(); if (!v) return;
  if (v.type === 'drone') {   // first-person view through the drone's camera
    camera.fov = lerp(camera.fov, 100, 1 - Math.exp(-10 * dt)); camera.updateProjectionMatrix();
    const f = v.air ? fwd(v.h, v.p, _v1) : fwd(camYaw, camPitch, _v1);
    camera.position.copy(v.pos).addScaledVector(f, 0.5); camera.position.y += 0.15;
    camera.lookAt(_v2.copy(camera.position).add(f));
    camera.rotateZ(-v.r * 0.8);
    camTrans = 0; setShadowSize(120); placeSun(v.pos.x, Math.max(0, H(v.pos.x, v.pos.z)), v.pos.z);
    return;
  }
  if (v.tmode) {              // SS-27 targeting: top view over the target point
    const gy = Math.max(0, H(v.tgt.x, v.tgt.z));
    camera.fov = 50; camera.updateProjectionMatrix();
    camera.position.set(v.tgt.x, gy + v.tzoom, v.tgt.z + v.tzoom * 0.45); camera.lookAt(v.tgt.x, gy, v.tgt.z);
    camTrans = 0; setShadowSize(Math.min(600, v.tzoom)); placeSun(v.tgt.x, gy, v.tgt.z);
    return;
  }
  const d = fwd(camYaw, camPitch, _v1);
  const base = _v4.copy(v.pos); base.y += v.type === 'ship' ? 10 : v.type === 'plane' ? 2.5 : v.type === 'gunner' ? 2.3 : 2.6;
  const cp = _v3.copy(base).addScaledVector(d, -camDist);
  cp.y += camDist * (v.type === 'plane' ? 0.16 : 0.12);
  cp.y = Math.max(cp.y, Math.max(H(cp.x, cp.z), 0) + 1.2);
  camera.fov = lerp(camera.fov, zoom ? 24 : (v.type === 'plane' ? 68 : 62), 1 - Math.exp(-10 * dt));
  camera.updateProjectionMatrix();
  shake = Math.max(0, shake - dt * 1.4);
  const sk = shake * shake * 0.6;
  cp.x += (Math.random() - .5) * sk; cp.y += (Math.random() - .5) * sk; cp.z += (Math.random() - .5) * sk;
  if (camTrans > 0) {
    camTrans = Math.max(0, 1 - (performance.now() - camTransAt) / 650);
    const t = 1 - camTrans * camTrans;
    camera.position.lerpVectors(_camFrom, cp, t);
    camera.lookAt(_v2.copy(cp).add(d));
    const qt = camera.quaternion.clone();
    camera.quaternion.copy(_camFromQ).slerp(qt, t);
  } else { camera.position.copy(cp); camera.lookAt(_v2.copy(cp).add(d)); }
  setShadowSize(v.type === 'ship' ? 220 : v.type === 'plane' && v.air ? 260 : 120);
  placeSun(v.pos.x, Math.max(0, v.pos.y - (v.type === 'plane' ? v.pos.y - Math.max(0, H(v.pos.x, v.pos.z)) : 0)), v.pos.z);
}

// ═══════════ HUD ═══════════
function project(p) {
  _v5.copy(p).project(camera);
  if (_v5.z > 1) return null;
  return [(_v5.x * .5 + .5) * innerWidth, (-_v5.y * .5 + .5) * innerHeight];
}
function ring(c, x, y, r, col, lw = 2) { c.lineWidth = lw + 2; c.strokeStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke(); c.lineWidth = lw; c.strokeStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke(); }
function drawHud(now, dt) {
  const w = innerWidth, h = innerHeight, c = hctx;
  c.clearRect(0, 0, w, h);
  if (!inGame) return;
  if (mode === 'cmd') return drawCmdHud(c, w, h, now);
  const v = myVehicle(); if (!v || !v.alive) return;
  if (v.type === 'drone') {
    // FPV goggles: OSD text, crosshair, scan lines
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2; c.beginPath(); c.moveTo(w / 2 - 22, h / 2); c.lineTo(w / 2 - 7, h / 2); c.moveTo(w / 2 + 7, h / 2); c.lineTo(w / 2 + 22, h / 2); c.moveTo(w / 2, h / 2 + 7); c.lineTo(w / 2, h / 2 + 18); c.stroke();
    c.fillStyle = 'rgba(0,0,0,.07)'; for (let y = (now / 30) % 4; y < h; y += 4) c.fillRect(0, y, w, 1);
    const gr = c.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.55)'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
    c.font = '700 13px monospace'; c.fillStyle = '#f3f1e8'; c.textAlign = 'left';
    c.fillText('FPV · ' + (v.air ? 'ARMED' : 'ON GROUND'), 24, 96);
    c.fillText('BAT ' + Math.max(0, Math.ceil(v.bat)) + 's', 24, 116); c.fillText('SPD ' + Math.round(v.speed * 3.6) + ' km/h', 24, 136);
    c.fillText('ALT ' + Math.round(v.pos.y - Math.max(0, H(v.pos.x, v.pos.z))) + ' m', 24, 156); c.fillText('THR ' + Math.round(v.thr * 100) + '%', 24, 176);
    c.fillStyle = v.bat < 20 ? '#ff5a46' : '#9bdc6a'; c.fillRect(24, 184, Math.max(0, v.bat) * 1.2, 5);
    if (Math.random() < 0.04) { c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(0, Math.random() * h, w, 6 + Math.random() * 20); }
  } else if (v.type === 'icbm') {
    if (v.tmode) {
      const p = project(_v1.set(v.tgt.x, Math.max(0, H(v.tgt.x, v.tgt.z)), v.tgt.z));
      if (p) {
        const e = project(_v2.set(v.tgt.x + ICBM_R, _v1.y, v.tgt.z)); const r = e ? Math.abs(e[0] - p[0]) : 60;
        c.strokeStyle = '#ff4a36'; c.lineWidth = 2.5; c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.stroke();
        c.setLineDash([6, 6]); c.beginPath(); c.arc(p[0], p[1], r * 0.32, 0, TAU); c.stroke(); c.setLineDash([]);
        c.beginPath(); c.moveTo(p[0] - r - 14, p[1]); c.lineTo(p[0] + r + 14, p[1]); c.moveTo(p[0], p[1] - r - 14); c.lineTo(p[0], p[1] + r + 14); c.stroke();
        c.fillStyle = '#ff4a36'; c.font = '800 12px Unbounded'; c.textAlign = 'center';
        c.fillText('ЦЕЛЬ · ' + Math.round(Math.hypot(v.tgt.x - v.pos.x, v.tgt.z - v.pos.z)) + ' м · ракет: ' + v.icbms, p[0], p[1] - r - 22);
      }
      c.fillStyle = 'rgba(243,241,232,.8)'; c.font = '700 10px Unbounded'; c.textAlign = 'center'; c.fillText('Мышь — двигать цель · колесо — масштаб · клик — пуск · ПКМ — выйти', w / 2, h - 130);
    } else { c.fillStyle = 'rgba(243,241,232,.8)'; c.font = '700 10px Unbounded'; c.textAlign = 'center'; c.fillText(v.icbms > 0 ? 'Остановитесь и нажмите ПКМ — наведение ракеты' : 'Ракеты израсходованы', w / 2, h * 0.3); }
  } else if (v.type === 'plane') {
    // mouse-aim circle + where the guns point
    const pa = project(_v1.copy(camera.position).addScaledVector(fwd(camYaw, camPitch, _v2), 600));
    if (pa) ring(c, pa[0], pa[1], 11, 'rgba(255,255,255,.85)', 1.5);
    const pg = project(_v1.copy(v.pos).addScaledVector(fwd(v.h, v.p, _v2), 420));
    if (pg) { c.strokeStyle = '#f3f1e8'; c.lineWidth = 2; c.beginPath(); c.moveTo(pg[0] - 14, pg[1]); c.lineTo(pg[0] - 5, pg[1]); c.moveTo(pg[0] + 5, pg[1]); c.lineTo(pg[0] + 14, pg[1]); c.moveTo(pg[0], pg[1] - 14); c.lineTo(pg[0], pg[1] - 5); c.moveTo(pg[0], pg[1] + 5); c.lineTo(pg[0], pg[1] + 14); c.stroke(); }
    // rocket impact preview (where the nose line meets the ground)
    _o3[0] = v.pos.x; _o3[1] = v.pos.y; _o3[2] = v.pos.z; const fd = fwd(v.h, v.p, _v2); _d3[0] = fd.x; _d3[1] = fd.y; _d3[2] = fd.z;
    const gh = v.air ? castRay(_o3, _d3, 1500, myVid, { step: 8 }) : null;
    if (gh && !lockVid) { const pr = project(_v1.set(_o3[0] + fd.x * gh.t, _o3[1] + fd.y * gh.t, _o3[2] + fd.z * gh.t)); if (pr) { c.strokeStyle = '#ffb03a'; c.lineWidth = 2; c.beginPath(); c.rect(pr[0] - 7, pr[1] - 7, 14, 14); c.stroke(); } }
    // lock-on marker
    const lt = lockVid && vehicles.get(lockVid);
    if (lt) {
      const pl = project(_v1.copy(lt.pos).setY(lt.pos.y + 1.5));
      if (pl) {
        const k = Math.min(1, lockT / LOCK_TIME), r = 34 - 16 * k, col = k >= 1 ? '#ff4a36' : '#ffd24a';
        c.strokeStyle = col; c.lineWidth = 2.5; c.setLineDash(k >= 1 ? [] : [7, 6]);
        c.beginPath(); c.moveTo(pl[0], pl[1] - r); c.lineTo(pl[0] + r, pl[1]); c.lineTo(pl[0], pl[1] + r); c.lineTo(pl[0] - r, pl[1]); c.closePath(); c.stroke(); c.setLineDash([]);
        c.fillStyle = col; c.font = '800 11px Unbounded'; c.textAlign = 'center';
        c.fillText((k >= 1 ? 'ЗАХВАТ · ПКМ — ПУСК · ' : 'НАВЕДЕНИЕ ' + Math.round(k * 100) + '% · ') + vName(lt).toUpperCase() + ' · ' + Math.round(lt.pos.distanceTo(v.pos)) + ' м', pl[0], pl[1] - r - 8);
      }
    }
    // bomb sight
    if (v.air && v.bombs > 0) {
      const pb = project(bombImpact(v, _v3));
      if (pb) { c.strokeStyle = '#9bff7a'; c.lineWidth = 2; c.beginPath(); c.arc(pb[0], pb[1], 12, 0, TAU); c.moveTo(pb[0] - 18, pb[1]); c.lineTo(pb[0] + 18, pb[1]); c.moveTo(pb[0], pb[1] - 18); c.lineTo(pb[0], pb[1] + 18); c.stroke(); c.fillStyle = '#9bff7a'; c.font = '800 9px Unbounded'; c.textAlign = 'center'; c.fillText('БОМБА', pb[0], pb[1] + 30); }
    }
  } else {
    c.fillStyle = 'rgba(255,255,255,.75)'; c.fillRect(w / 2 - 1.5, h / 2 - 1.5, 3, 3);
    // where the gun will actually hit
    const ready = reload <= 0;
    const light = v.type === 'jeep' || v.type === 'gunner';
    const tp = v.type === 'ship' ? v.pos.clone().setY(8) : v.pos.clone().setY(v.pos.y + 2.4);
    const dist = Math.hypot(aimPt.x - tp.x, aimPt.z - tp.z);
    const gp = _v1.copy(tp).add(_v2.set(Math.sin(v.aimYaw) * dist, 0, Math.cos(v.aimYaw) * dist)); gp.y = aimPt.y;
    const p = project(gp);
    if (p) {
      const col = light ? '#f3f1e8' : ready ? '#9bdc6a' : '#e3a53c';
      ring(c, p[0], p[1], light ? 9 : 14, col);
      if (!light && !ready) { const tot = v.type === 'tank' ? 4 : 5; c.lineWidth = 3; c.strokeStyle = '#e3a53c'; c.beginPath(); c.arc(p[0], p[1], 20, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - reload / tot)); c.stroke(); }
      if (aimHit && aimHit.kind === 'veh' && aimHit.v.team !== v.team) { c.fillStyle = '#ff5a46'; c.font = '800 11px Unbounded'; c.textAlign = 'center'; c.fillText(vName(aimHit.v).toUpperCase() + ' · ' + Math.round(aimHit.t) + ' м', p[0], p[1] - 24); }
    }
    if (v.type === 'ship') {   // rocket target
      const pr = project(aimPt);
      if (pr) { c.strokeStyle = reload2 <= 0 ? '#ffb03a' : 'rgba(255,176,58,.35)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(pr[0] - 18, pr[1]); c.lineTo(pr[0] + 18, pr[1]); c.moveTo(pr[0], pr[1] - 18); c.lineTo(pr[0], pr[1] + 18); c.stroke(); }
    }
  }
  drawThreats(c, w, h, dt);
  if (!locked) { c.font = '700 12px Unbounded'; c.textAlign = 'center'; c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(w / 2 - 170, h * 0.66 - 20, 340, 32); c.fillStyle = '#e3a53c'; c.fillText('КЛИКНИТЕ, ЧТОБЫ УПРАВЛЯТЬ', w / 2, h * 0.66); }
  if (now < matchStartAt) centerMsg(String(Math.ceil((matchStartAt - now) / 1000)), 'К БОЮ', 400);
  const wEl = $('warn');
  wEl.style.display = warnText ? 'block' : 'none';
  if (warnText) wEl.textContent = warnText;
}
let warnBeepT = 0;
function drawThreats(c, w, h, dt) {
  const el = $('mwarn'), v = myVehicle();
  warnBeepT -= dt;
  const incoming = sams.filter(m => m.target === myVid && !m.decoy && m.age < SAM_HOME);
  const rk = shots.find(s => s.tv === myVid && !s.mine);
  const nuke = shots.find(s => s.k === 'icbm' && v && Math.hypot(s.target.x - v.pos.x, s.target.z - v.pos.z) < ICBM_R + 30);
  if (nuke) {
    el.style.display = 'block'; el.className = ''; el.textContent = 'РАКЕТНЫЙ УДАР ПО ВАМ! ' + Math.max(0, Math.ceil(ICBM_T - nuke.age)) + ' с — УХОДИТЕ';
    if (warnBeepT <= 0) { audio.tone(700, 0.15, 0.06); warnBeepT = 0.35; }
  } else if (rk) {
    el.style.display = 'block'; el.className = ''; el.textContent = 'РАКЕТА! ' + Math.round(rk.pos.distanceTo(v.pos)) + ' м' + (v.type === 'plane' ? ' · F — ЛОВУШКИ (' + flares + ')' : '');
    if (warnBeepT <= 0) { audio.tone(1200, 0.08, 0.06); warnBeepT = 0.14; }
  } else if (incoming.length) {
    el.style.display = 'block'; el.className = ''; el.textContent = 'РАКЕТА ПВО! F — ЛОВУШКИ (' + flares + ')';
    if (warnBeepT <= 0) { audio.tone(1100, 0.08, 0.06); warnBeepT = 0.15; }
  } else if (samLock) {
    el.style.display = 'block'; el.className = 'lock'; el.textContent = samLock === 2 ? 'ПВО: ЗАХВАТ!' : 'ПВО: РАДАР';
    if (warnBeepT <= 0) { audio.tone(samLock === 2 ? 900 : 560, 0.07, 0.04); warnBeepT = samLock === 2 ? 0.2 : 0.6; }
  } else el.style.display = 'none';
}
// commander view overlay: icons over every vehicle of my team, spotted enemies in red
function drawCmdHud(c, w, h, now) {
  $('warn').style.display = 'none'; $('mwarn').style.display = 'none';
  const team = myTeam();
  for (const v of vehicles.values()) {
    if (!v.alive || !v.vis.g.visible) continue;
    const mine = v.team === team;
    if (!mine && !v.seen) continue;
    const p = project(_v1.copy(v.pos).setY(v.pos.y + (v.type === 'ship' ? 14 : 4)));
    if (!p) continue;
    const hov = cmdHover === v;
    const r = hov ? 17 : 13;
    c.fillStyle = mine ? (v.driver ? 'rgba(30,34,30,.85)' : 'rgba(20,24,20,.75)') : 'rgba(80,20,15,.8)';
    c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); c.fill();
    c.lineWidth = hov ? 3 : 2; c.strokeStyle = !mine ? '#ff5a46' : v.driver === myId ? '#e3a53c' : v.driver ? '#9aa39a' : TEAM_CSS[team]; c.stroke();
    c.fillStyle = '#f3f1e8'; c.font = `${hov ? 15 : 12}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(TYPE_ICON[v.type], p[0], p[1] + 1);
    c.textBaseline = 'alphabetic';
    // hp arc
    c.lineWidth = 3; c.strokeStyle = v.hp / v.max > .5 ? '#9bcf5a' : v.hp / v.max > .25 ? '#e3a53c' : '#e0503f';
    c.beginPath(); c.arc(p[0], p[1], r + 4, -Math.PI / 2, -Math.PI / 2 + TAU * v.hp / v.max); c.stroke();
    if (mine) { c.font = '700 9px Unbounded'; c.fillStyle = v.driver ? '#cfd5cc' : '#f3f1e8'; c.fillText(v.driver ? (v.driver === myId ? 'ВЫ' : nameOf(v.driver)) : TYPE_NAME[v.type].toUpperCase() + ' ' + v.n, p[0], p[1] + r + 16); }
  }
  // own SAM sites
  for (const s of world.samSites) { if (s.team !== team) continue; const p = project(s.top); if (!p) continue; c.fillStyle = TEAM_CSS[team]; c.font = '800 9px Unbounded'; c.textAlign = 'center'; c.fillText('ПВО', p[0], p[1] - 8); }
  if (now < matchStartAt) centerMsg(String(Math.ceil((matchStartAt - now) / 1000)), 'ВЫБЕРИТЕ ТЕХНИКУ', 400);
}
// spotting: enemies near any of my team's vehicles (or under my plane) are visible on map/HUD
let spotT = 0;
function updateSpotting(dt) {
  spotT -= dt; if (spotT > 0) return; spotT = 0.3;
  const team = myTeam();
  const mine = [...vehicles.values()].filter(v => v.team === team && v.alive && v.vis.g.visible);
  for (const e of vehicles.values()) {
    if (e.team === team) { e.seen = true; continue; }
    e.seen = false;
    if (!e.alive || !e.vis.g.visible) continue;
    for (const m of mine) {
      const d = m.pos.distanceTo(e.pos);
      const R = (m.type === 'plane' && m.air) || (e.type === 'plane' && e.air) ? 1100 : e.type === 'ship' ? 900 : 550;
      if (d < R) { e.seen = true; break; }
    }
  }
  for (const s of world.samSites) if (s.team === team) for (const e of vehicles.values()) if (e.team !== team && e.alive && s.top.distanceTo(e.pos) < SAM_RANGE) e.seen = true;
}
function updateMarkers() {
  const v = myVehicle();
  for (const o of vehicles.values()) {
    const mk = o.marker;
    if (!inGame || mode !== 'drive' || o === v || !o.alive || !o.vis.g.visible || !o.seen) { mk.style.display = 'none'; continue; }
    const enemy = o.team !== myTeam();
    const dist = v ? o.pos.distanceTo(v.pos) : 0;
    if (dist > (enemy ? 900 : 1400)) { mk.style.display = 'none'; continue; }
    const p = project(_v1.copy(o.pos).setY(o.pos.y + (o.type === 'ship' ? 18 : o.type === 'plane' ? 5 : 4.5)));
    if (!p) { mk.style.display = 'none'; continue; }
    mk.style.display = 'block'; mk.className = 'mk ' + (enemy ? 'en' : 'al');
    mk.style.left = p[0] + 'px'; mk.style.top = p[1] + 'px';
    mk.firstChild.textContent = (o.driver ? nameOf(o.driver) + ' · ' : '') + TYPE_NAME[o.type] + (dist > 150 ? ' · ' + Math.round(dist) + ' м' : '');
    mk.querySelector('i').style.width = Math.round(o.hp / o.max * 100) + '%';
  }
}
function updateBottom() {
  const v = myVehicle(), p = me();
  if (!v) return;
  $('myname').textContent = vName(v).toUpperCase() + (p ? ' · ' + p.name.toUpperCase() : '');
  $('hptxt').textContent = Math.max(0, v.hp);
  const k = v.hp / v.max;
  $('hpfill').style.width = Math.max(0, k * 100) + '%';
  $('hpfill').style.background = k > .5 ? 'linear-gradient(90deg,#8fbf55,#b6d35f)' : k > .25 ? 'linear-gradient(90deg,#d29a35,#e3b54a)' : 'linear-gradient(90deg,#c9432f,#e0503f)';
  const set = (i, l, val) => { $('g' + i + 'l').textContent = l; $('g' + i).textContent = val; };
  const bar = (i, l, frac, col) => { $('g' + i + 'l').textContent = l; $('g' + i).style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; $('g' + i).style.background = col; };
  set(1, 'КМ/Ч', Math.round(Math.abs(v.speed) * 3.6));
  if (v.type === 'tank') { set(2, 'ПРИЦЕЛ', aimHit ? Math.round(aimHit.t) + ' м' : '—'); bar(3, 'ПУШКА', 1 - reload / 4, reload > 0 ? '#e3a53c' : '#9bdc6a'); bar(4, 'БРОНЯ', k, '#9aa39a'); set(5, 'SHIFT', 'ПРИЦЕЛ'); }
  else if (v.type === 'jeep') { set(2, 'ПРИЦЕЛ', aimHit ? Math.round(aimHit.t) + ' м' : '—'); bar(3, 'ПУЛЕМЁТ', 1, '#9bdc6a'); bar(4, 'КОРПУС', k, '#9aa39a'); set(5, 'КЛИК', 'ОГОНЬ'); }
  else if (v.type === 'plane') { set(2, 'ВЫСОТА', Math.round(v.pos.y - Math.max(0, H(v.pos.x, v.pos.z))) + ' м'); bar(3, 'ТЯГА', v.thr, '#8fc3e8'); bar(4, 'РАКЕТЫ ' + v.rk + ' · ПКМ', v.rk / 8, '#ffb03a'); set(5, 'БОМБЫ · ПРОБЕЛ', v.bombs + ' / 3'); }
  else if (v.type === 'icbm') { set(2, 'РАКЕТЫ', v.icbms + ' / 2'); bar(3, 'ПОДЪЁМ', v.erect, '#ffb03a'); bar(4, 'ПЕРЕЗАРЯДКА', 1 - v.mload / 90, v.mload > 0 ? '#e3a53c' : '#9bdc6a'); set(5, 'ПКМ', v.tmode ? 'ОТМЕНА' : 'НАВЕДЕНИЕ'); }
  else if (v.type === 'drone') { set(2, 'БАТАРЕЯ', Math.max(0, Math.ceil(v.bat)) + ' с'); bar(3, 'ТЯГА', v.thr, '#8fc3e8'); bar(4, 'ЗАРЯД', v.bat / 100, '#9bdc6a'); set(5, 'УДАР', 'ВЗРЫВ'); }
  else if (v.type === 'gunner') { set(1, 'ПОСТ', 'ПУЛЕМЁТ'); set(2, 'ПРИЦЕЛ', aimHit ? Math.round(aimHit.t) + ' м' : '—'); bar(3, 'ПУЛЕМЁТ', 1, '#9bdc6a'); bar(4, 'УКРЫТИЕ', k, '#9aa39a'); set(5, 'КЛИК', 'ОГОНЬ'); }
  else { set(2, 'ХОД', SHIP_TEL_TXT[v.tel]); bar(3, 'ОРУДИЯ', 1 - reload / 5, reload > 0 ? '#e3a53c' : '#9bdc6a'); bar(4, 'РАКЕТЫ · ПКМ', 1 - reload2 / 18, reload2 > 0 ? '#e3a53c' : '#ffb03a'); set(5, 'КОРПУС', Math.round(k * 100) + '%'); }
}
function updateTopBar() {
  if (!room) return;
  const left = room.timeLeft != null ? Math.max(0, Math.round((room.timeLeft - (performance.now() - roomRecv)) / 1000)) : 0;
  const mm2 = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
  $('top').innerHTML = `<span class="sc tA">${room.tickets[0]}</span><div class="mid">АЛЬФА · БРАВО<br><span style="color:var(--txt)">осталось машин</span></div><span class="sc tB">${room.tickets[1]}</span>`;
}

// ── minimap: the whole battlefield ──
const mm = $('minimap'), mctx = mm.getContext('2d');
let mmBase = null;
const MMW = 520, MMH = 360, MMX = MAP_X + 60, MMZ = MAP_Z + 60;
const mmP = (x, z) => [(x + MMX) / (2 * MMX) * MMW, (z + MMZ) / (2 * MMZ) * MMH];
function buildMinimapBase() {
  mmBase = document.createElement('canvas'); mmBase.width = MMW; mmBase.height = MMH;
  const c = mmBase.getContext('2d'); const img = c.createImageData(MMW, MMH);
  for (let y = 0; y < MMH; y++) for (let x = 0; x < MMW; x++) {
    const wx = x / MMW * 2 * MMX - MMX, wz = y / MMH * 2 * MMZ - MMZ, hh = H(wx, wz), i = (y * MMW + x) * 4;
    if (hh < 0) { img.data[i] = 50; img.data[i + 1] = 92; img.data[i + 2] = 104; }
    else { const k = Math.min(1, hh / 160); img.data[i] = 95 + k * 70; img.data[i + 1] = 108 + k * 50; img.data[i + 2] = 62 + k * 60; }
    img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  for (const team of [0, 1]) {
    const [bx, by] = mmP(BASES[team].x, BASES[team].z);
    c.strokeStyle = TEAM_CSS[team]; c.lineWidth = 2; c.beginPath(); c.arc(bx, by, BASE_R / (2 * MMX) * MMW, 0, TAU); c.stroke();
    const [r0x, ry] = mmP(teamX(team, RWY.x0), RWY.z), [r1x] = mmP(teamX(team, RWY.x1), RWY.z);
    c.strokeStyle = '#3a3c3d'; c.lineWidth = 4; c.beginPath(); c.moveTo(r0x, ry); c.lineTo(r1x, ry); c.stroke();
  }
}
function drawMinimap() {
  if (!mmBase || !inGame) return;
  const c = mctx; c.drawImage(mmBase, 0, 0);
  const team = myTeam();
  for (const s of world.samSites) { const [x, y] = mmP(s.x, s.z); c.fillStyle = TEAM_CSS[s.team]; c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 5, y + 4); c.lineTo(x - 5, y + 4); c.closePath(); c.fill(); }
  for (const v of vehicles.values()) {
    if (!v.alive || !v.vis.g.visible) continue;
    if (v.team !== team && !v.seen) continue;
    const [x, y] = mmP(v.pos.x, v.pos.z);
    c.save(); c.translate(x, y); c.rotate(-v.h + Math.PI);
    c.fillStyle = v.vid === myVid ? '#fff' : v.team === team ? (v.team ? '#8fb8e0' : '#c2d27a') : '#ff5a46';
    if (v.type === 'plane') { c.beginPath(); c.moveTo(0, -8); c.lineTo(6, 6); c.lineTo(-6, 6); c.closePath(); c.fill(); }
    else if (v.type === 'ship') c.fillRect(-3, -9, 6, 18);
    else if (v.type === 'tank') c.fillRect(-4, -5, 8, 10);
    else { c.beginPath(); c.moveTo(0, -5); c.lineTo(4, 0); c.lineTo(0, 5); c.lineTo(-4, 0); c.closePath(); c.fill(); }
    if (v.vid === myVid) { c.strokeStyle = '#111'; c.lineWidth = 1.5; c.stroke(); }
    c.restore();
  }
  for (const s of shots) if (s.k === 'icbm') { const [x, y] = mmP(s.target.x, s.target.z), [mx, my] = mmP(s.pos.x, s.pos.z); const pr = 8 + (performance.now() / 120) % 14;
    c.strokeStyle = '#ff3a26'; c.lineWidth = 3; c.beginPath(); c.arc(x, y, pr, 0, TAU); c.stroke(); c.fillStyle = '#ff3a26'; c.beginPath(); c.arc(x, y, 4, 0, TAU); c.fill(); c.fillStyle = '#fff'; c.fillRect(mx - 3, my - 3, 6, 6); }
  const tv = myVehicle(); if (tv && tv.tmode) { const [x, y] = mmP(tv.tgt.x, tv.tgt.z); c.strokeStyle = '#ffb03a'; c.lineWidth = 2; c.beginPath(); c.moveTo(x - 9, y); c.lineTo(x + 9, y); c.moveTo(x, y - 9); c.lineTo(x, y + 9); c.stroke(); }
  if (mode === 'cmd') { const [x, y] = mmP(cmd.x, cmd.z); const ww = cmd.h * 1.2 / (2 * MMX) * MMW; c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1.5; c.strokeRect(x - ww, y - ww * 0.7, ww * 2, ww * 1.4); }
}
mm.addEventListener('mousedown', e => {
  if (!inGame || mode !== 'cmd') return;
  const r = mm.getBoundingClientRect();
  cmdCenterOn((e.clientX - r.left) / r.width * 2 * MMX - MMX, (e.clientY - r.top) / r.height * 2 * MMZ - MMZ);
});

// ── messages ──
let centerTimer = 0;
function centerMsg(big, small = '', ms = 1800, color = '') {
  const c = $('center');
  c.innerHTML = `<span style="color:${color}">${esc(big)}</span>${small ? `<small>${esc(small)}</small>` : ''}`;
  c.style.opacity = 1;
  clearTimeout(centerTimer); centerTimer = setTimeout(() => c.style.opacity = 0, ms);
}
function feed(html) { const d = document.createElement('div'); d.innerHTML = html; $('feed').prepend(d); setTimeout(() => d.remove(), 6000); while ($('feed').children.length > 6) $('feed').lastChild.remove(); }
function logMsg(html) { const d = document.createElement('div'); d.innerHTML = html; $('log').prepend(d); setTimeout(() => d.remove(), 5000); while ($('log').children.length > 5) $('log').lastChild.remove(); }
function nameOf(id) { const p = room && room.players.find(q => q.id === id); return p ? esc(p.name) : '???'; }
function floatText(pos, text) {
  const p = project(pos); if (!p) return;
  const d = document.createElement('div'); d.className = 'dmgnum'; d.textContent = text;
  d.style.left = p[0] + 'px'; d.style.top = p[1] + 'px';
  $('markers').appendChild(d); setTimeout(() => d.remove(), 1100);
}
function renderBoard() {
  if (!room) return;
  const head = '<tr><th>БОЕЦ</th><th class="n">УНИЧТОЖИЛ</th><th class="n">УРОН</th><th class="n">ПОТЕРЬ</th></tr>';
  const rows = ps => ps.sort((a, b) => b.kills - a.kills || b.dmg - a.dmg).map(p => `<tr class="${p.id === myId ? 'me' : ''}"><td>${esc(p.name)}${p.vid ? ' <span style="color:var(--dim);font-size:9px">' + TYPE_ICON[(vehicles.get(p.vid) || {}).type] + '</span>' : ''}</td><td class="n">${p.kills}</td><td class="n">${p.dmg}</td><td class="n">${p.deaths}</td></tr>`).join('');
  $('board').innerHTML = [0, 1].map(tm => `<div style="font-size:10px;letter-spacing:.25em;color:${tm ? 'var(--b)' : 'var(--a)'};margin:${tm ? 14 : 0}px 0 4px">${tm ? 'БРАВО' : 'АЛЬФА'} · ${room.tickets[tm]}</div><table>${head}${rows(room.players.filter(p => p.team === tm))}</table>`).join('');
}

// ═══════════ NETWORK EVENTS ═══════════
let roomRecv = 0;
socket.on('room', r => {
  room = r;
  roomRecv = performance.now();
  if (r.state === 'lobby' && !inGame && !$('result').classList.contains('on')) showScreen(myId ? 'lobby' : 'menu');
  if (!myId) return;
  renderLobby();
  if (inGame) {
    syncVehicles();
    // the server dropped me out of my vehicle (e.g. it was destroyed)
    const p = me();
    if (mode === 'drive' && p && p.vid !== myVid && !(vehicles.get(myVid) || {}).dead) goCommander(myVehicle());
    if (mode === 'cmd') renderCmdList();
  }
  if ($('board').classList.contains('on')) renderBoard();
});
function startPlaying(fromStart) {
  if (worldSeed !== room.seed) { buildWorld(room.seed); worldSeed = room.seed; }
  inGame = true;
  showScreen(null);
  $('ui').classList.add('on');
  clearVehicles(); clearShots();
  syncVehicles();
  myVid = null; mode = 'cmd';
  document.body.classList.add('cmdv');
  const b = BASES[myTeam()];
  cmdCenterOn(b.x, b.z - 60, 560); cmd.x = cmd.tx; cmd.z = cmd.tz; cmd.h = 560;
  audio.setMusicVol(0.1);
  renderCmdList();
  centerMsg(fromStart ? 'ВЫБЕРИТЕ ТЕХНИКУ' : 'ВЫ В БОЮ', 'клик по своей технике — сесть в неё', 2600);
}
socket.on('matchStart', d => { matchStartAt = performance.now() + d.startAt; startPlaying(true); });
socket.on('lateJoin', () => { matchStartAt = 0; startPlaying(false); });
socket.on('vspawn', d => {
  const v = vehicles.get(d.vid); if (!v) return;
  const rv = room.vehicles.find(x => x.vid === d.vid);
  resetVehicle(v, rv || { spawn: { x: v.pos.x, z: v.pos.z, yaw: v.h }, max: v.max });
  v.driver = null; v.crashSent = false;
  if (v.team === myTeam()) logMsg(`${TYPE_ICON[v.type]} ${vName(v)} снова на базе`);
});
const dmgAcc = new Map();
socket.on('dmg', d => {
  const v = vehicles.get(d.vid); if (!v) return;
  v.hp = d.hp;
  const rv = room && room.vehicles.find(x => x.vid === d.vid); if (rv) rv.hp = d.hp;
  if (d.kind === 'repair') { if (d.vid === myVid && Math.random() < 0.3) particles.heal(v.pos); return; }
  const pt = d.pt ? new THREE.Vector3(...d.pt) : v.pos.clone();
  if (d.vid === myVid) {
    shake = Math.max(shake, d.dmg > 10 ? 0.8 : 0.2);
    if (d.dmg > 4) { audio.play('hit', 0.9, 0, 0.8); const f = $('flash'); f.style.transition = 'none'; f.style.boxShadow = 'inset 0 0 160px rgba(220,40,30,.55)'; requestAnimationFrame(() => { f.style.transition = 'box-shadow .5s'; f.style.boxShadow = 'inset 0 0 160px rgba(220,40,30,0)'; }); }
  }
  if (d.by === myId) { const a = dmgAcc.get(d.vid) || { n: 0, pt, t: performance.now() }; a.n += d.dmg; a.pt = pt; dmgAcc.set(d.vid, a); }
});
function flushDamage(now) {
  for (const [vid, a] of dmgAcc) {
    if (now - a.t < 300) continue;
    const v = vehicles.get(vid);
    floatText(a.pt, '−' + a.n);
    if (a.n >= 5 && v) logMsg(`Попадание: <b style="color:#ff7a68">${vName(v)}</b> <span style="color:#ffcf6a">−${a.n}</span>`);
    dmgAcc.delete(vid);
  }
}
socket.on('vdead', d => {
  const v = vehicles.get(d.vid); if (!v) return;
  destroyVis(v);
  const mine = d.vid === myVid;
  v.driver = null;
  const how = d.how === 'water' ? 'утонул' : d.how === 'abandon' ? 'брошен' : d.how === 'crash' ? 'разбился' : d.how === 'sam' ? 'сбит ПВО' : d.how === 'fpv' ? 'взорвался' : d.how === 'icbm' ? 'ракетный удар' : '';
  const vic = `<b style="color:${TEAM_CSS[v.team]}">${TYPE_ICON[v.type]} ${d.driver ? nameOf(d.driver) : vName(v)}</b>`;
  feed(d.by ? `<b style="color:${TEAM_CSS[1 - v.team]}">${nameOf(d.by)}</b><span class="x">✕</span>${vic}` : `${vic}<span class="x">${how || '✕'}</span>`);
  if (d.by === myId) centerMsg('УНИЧТОЖЕН', vName(v).toUpperCase(), 1500, '#ff7a68');
  if (mine) {
    centerMsg(vName(v).toUpperCase() + ' ПОТЕРЯН', d.by ? 'уничтожил ' + nameOf(d.by) : how, 2500, '#ff7a68');
    audio.engineOff();
    setTimeout(() => { if (myVid === d.vid) goCommander(v); }, 2800);
  }
});
socket.on('matchEnd', d => {
  const won = d.winner === myTeam();
  if (won) audio.play('victory', 0.9);
  setTimeout(() => {
    document.exitPointerLock && document.exitPointerLock();
    $('resTitle').textContent = d.winner === -1 ? 'НИЧЬЯ' : won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'; $('resTitle').style.color = won ? 'var(--acc)' : '#e0503f';
    $('resSub').textContent = `Осталось машин: АЛЬФА ${d.tickets[0]} · БРАВО ${d.tickets[1]}`;
    const head = '<tr><th>БОЕЦ</th><th class="n">УНИЧТОЖИЛ</th><th class="n">УРОН</th><th class="n">ПОТЕРЬ</th></tr>';
    const rows = [...room.players].sort((a, b) => b.kills - a.kills || b.dmg - a.dmg).map(p => `<tr class="${p.id === myId ? 'me' : ''}"><td style="text-align:left">${esc(p.name)} <span style="color:${p.team ? 'var(--b)' : 'var(--a)'};font-size:9px">${p.team ? 'БРАВО' : 'АЛЬФА'}</span></td><td class="n">${p.kills}</td><td class="n">${p.dmg}</td><td class="n">${p.deaths}</td></tr>`).join('');
    $('resTable').innerHTML = `<table>${head}${rows}</table>`;
    $('resAgain').style.display = $('resLobby').style.display = isHost() ? '' : 'none';
    $('resWait').textContent = isHost() ? '' : 'Ожидание хоста…';
    showScreen('result');
  }, 1500);
});
socket.on('lobby', () => { leaveGame(); showScreen('lobby'); renderLobby(); });
socket.on('left', d => { if (inGame) feed(`<span style="color:var(--dim)">${esc(d.name)} вышел</span>`); });
socket.on('chat', d => {
  const el = document.createElement('div');
  el.innerHTML = `<b style="color:${TEAM_CSS[d.team] || 'var(--acc)'}">${esc(d.name)}:</b> ${esc(d.text)}`;
  $('chatlog').appendChild(el);
  while ($('chatlog').children.length > 6) $('chatlog').firstChild.remove();
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 1000); }, 9000);
});
socket.on('disconnect', () => { if (myId) centerMsg('СОЕДИНЕНИЕ ПОТЕРЯНО', 'Обновите страницу, чтобы вернуться', 99999, '#ff7a68'); });
function leaveGame() {
  inGame = false; myVid = null; mode = 'cmd';
  $('ui').classList.remove('on'); $('warn').style.display = 'none'; document.body.classList.remove('cmdv');
  clearVehicles(); clearShots();
  audio.engineOff(); audio.setMusicVol(0.3);
  quietUnlock = true; document.exitPointerLock && document.exitPointerLock();
}

// ═══════════ MAIN LOOP ═══════════
let last = performance.now(), menuAngle = 0, listT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  waterUniforms.uTime.value = now / 1000;
  if (inGame && world) {
    for (const v of vehicles.values()) if (v.vid !== myVid) updateRemote(v, dt, now);
    if (mode === 'drive') { const v = myVehicle(); if (v && v.alive) updateAim(v); }
    updateMe(dt, now);
    for (const v of vehicles.values()) {
      if (!v.vis.g.visible) continue;
      if (v.dead) updateDead(v, dt);
      else if (v.alive && v.hp / v.max < 0.35) { v.smokeT -= dt; if (v.smokeT <= 0) { v.smokeT = 0.25; particles.smoke(_v1.copy(v.pos).setY(v.pos.y + 2.5), true); } }
      if (v.alive && v.type === 'ship' && Math.abs(v.speed) > 2 && Math.random() < 0.4) particles.wake(_v1.copy(v.pos).addScaledVector(fwd(v.h, 0, _v2), -22), 1.4);
      if (v.alive && (v.type === 'jeep' || v.type === 'gunner') && v.f1 && v.vid !== myVid && Math.random() < 0.5) { v.vis.g.updateMatrixWorld(true); particles.muzzle(v.vis.tip.getWorldPosition(_v1), fwd(v.aimYaw, v.aimPitch, _v2)); }
      updateVis(v, dt);
    }
    updateSamSites(dt, now);
    updateSams(dt);
    updateShots(dt);
    updateSpotting(dt);
    updateGrass();
    for (const r of world_radars) r.rotation.y += dt * 1.5;
    if (mode === 'drive') updateDriveCam(dt); else updateCmd(dt);
    updateMarkers();
    flushDamage(now);
    updateTopBar(); drawMinimap();
    if (mode === 'drive') updateBottom();
    listT -= dt; if (listT <= 0 && mode === 'cmd') { listT = 1; renderCmdList(); }
  } else {
    menuAngle += dt * 0.04;
    if (!world) { buildWorld(1); worldSeed = null; }
    camera.position.set(-1200 + Math.sin(menuAngle) * 420, 160, 60 + Math.cos(menuAngle) * 420);
    camera.lookAt(-1200, 10, 60);
    setShadowSize(450); placeSun(-1200, 0, 60);
    updateGrass();
  }
  particles.update(dt);
  drawHud(now, dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

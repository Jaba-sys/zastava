// main.js — сам матч: сцена, цикл, стрельба, сеть.
//
// Порядок кадра всегда один и тот же и менять его нельзя:
//   1. посчитать своё движение и столкновения;
//   2. подтянуть чужих бойцов к их последним известным местам;
//   3. посчитать выстрел — уже по подтянутым позициям, чтобы стрелять туда,
//      где люди нарисованы, а не туда, где они были в момент прихода пакета;
//   4. отрисовать.
//
// Пункт 3 после пункта 2 — не мелочь: если поменять их местами, на глаз будет
// казаться, что пули проходят сквозь людей.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

import { hasRealtimeDb } from "../firebase.js";
import { resolvePlayer } from "../mypeal-auth.js";
import { ensurePlayer, addMatchResult } from "../profile.js";
import { buildMap, mapMeta } from "./maps/index.js";
import { PLAYER, movePlayer, onGround, raycast } from "./physics.js";
import { Controls } from "./controls.js";
import { Arsenal, damageAt, scatter } from "./weapons.js";
import { RemotePlayer } from "./remote.js";
import { Hud } from "./hud.js";
import * as net from "../net/live.js";

const MATCH_SECONDS = 8 * 60;
const GOAL = { dm: 25, team: 40 };
const RESPAWN_DELAY = 3;
const SEND_HZ = 12;

const params = new URLSearchParams(location.search);
const roomId = params.get("room");

const hud = new Hud();
const canvas = document.getElementById("view");

let me = null;               // { sessionUid, uid, name, tag, team }
let room = null;             // meta комнаты
let map = null;
let scene, camera, renderer, clock;
let controls, arsenal;
let remotes = new Map();     // sessionUid -> RemotePlayer
let tracers = [];
let stopWatchers = [];
let leaveRoom = null;
let matchOver = false;
let localStats = { kills: 0, deaths: 0 };

const self = {
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  height: PLAYER.height,
  hp: 100,
  alive: true,
  respawnAt: 0,
  fell: false
};

start().catch(error => {
  document.getElementById("loading").innerHTML =
    `<b>Не получилось начать матч.</b><span>${error.message}</span>
     <a class="btn btn-ghost" href="lobby.html">Вернуться в лобби</a>`;
});

async function start(){
  if (!hasRealtimeDb) throw new Error("Realtime Database не создана — смотри подсказку в лобби.");
  if (!roomId) throw new Error("Не указана комната. Заходи в матч из лобби.");

  const resolved = await resolvePlayer();
  if (!resolved.uid) { location.href = "index.html"; return; }

  const profile = await ensurePlayer(resolved.uid, resolved.fresh || {});
  me = {
    sessionUid: resolved.sessionUid,
    uid: resolved.uid,
    name: profile.name,
    tag: profile.tag,
    team: "free"
  };

  room = await waitForMeta();
  if (!room) throw new Error("Комната закрылась.");

  map = buildMap(room.map);
  buildScene();
  // Управление создаём до первого возрождения: spawn() ставит controls.yaw.
  controls = new Controls(canvas);
  arsenal = new Arsenal();

  // Команду выбираем по чётности числа уже вошедших: так две стороны
  // наполняются поровну без отдельного распорядителя.
  if (room.mode === "team"){
    me.team = (room.count || 0) % 2 === 0 ? "a" : "b";
  }

  leaveRoom = await net.joinRoom(roomId, me.sessionUid, {
    uid: me.uid, name: me.name, tag: me.tag || null, team: me.team
  });

  spawn();
  wireNetwork();
  wireInput();
  // Табло рисуем сразу, не дожидаясь чужих: в одиночной комнате обработчик
  // "пришёл игрок" не сработает ни разу, и по Tab открывалась пустота.
  refreshBoard();

  document.getElementById("loading").classList.add("gone");
  hud.say(mapMeta(room.map).hint);
  hud.banner(mapMeta(room.map).name, mapMeta(room.map).subtitle, 3200);

  clock = new THREE.Clock();
  renderer.setAnimationLoop(frame);
}

function waitForMeta(){
  return new Promise(resolve => {
    const stop = net.watchMeta(roomId, meta => { stop(); resolve(meta); });
  });
}

// ---------------------------------------------------------------------------
// Сцена
// ---------------------------------------------------------------------------

function buildScene(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(map.sky);
  scene.fog = new THREE.Fog(map.fog.color, map.fog.near, map.fog.far);
  scene.add(map.group);

  camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.08, 600);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Оружие в руках — отдельная маленькая сцена поверх основной. Так ствол
  // никогда не влезает в стену и не обрезается ближней плоскостью, что иначе
  // случается в каждом втором самодельном шутере.
  viewModel.init();
}

// ---------------------------------------------------------------------------
// Модель оружия в руках
// ---------------------------------------------------------------------------

const viewModel = {
  init(){
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 4);
    this.group = new THREE.Group();

    const metal = new THREE.MeshStandardMaterial({ color: 0x2f3336, roughness: 0.55, metalness: 0.65 });
    const wood  = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.85 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.46), metal);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.3), metal);
    barrel.position.z = -0.35;
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.2), wood);
    stock.position.z = 0.3;
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.08), metal);
    mag.position.set(0, -0.11, -0.02);

    this.group.add(body, barrel, stock, mag);
    this.group.position.set(0.17, -0.15, -0.42);
    this.scene.add(this.group);

    this.flash = new THREE.PointLight(0xffd9a0, 0, 2.2);
    this.flash.position.set(0.17, -0.12, -0.8);
    this.scene.add(this.flash);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));

    this.recoil = 0;
    this.bob = 0;

    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  },

  update(dt, speed, weapon){
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.bob += dt * speed * 1.5;

    const sway = Math.sin(this.bob) * 0.006 * Math.min(1, speed / 7);
    const lift = Math.abs(Math.cos(this.bob)) * 0.004 * Math.min(1, speed / 7);

    this.group.position.set(
      0.17 + sway,
      -0.15 + lift - this.recoil * 0.02,
      -0.42 + this.recoil * 0.06
    );
    this.group.rotation.x = this.recoil * 0.25;
    // Дробовик короче и толще — заметно даже краем глаза.
    this.group.scale.set(weapon === "shotgun" ? 1.25 : 1, 1, weapon === "shotgun" ? 0.8 : 1);
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 30);
  },

  kick(strength){
    this.recoil = Math.min(1, this.recoil + strength);
    this.flash.intensity = 6;
  },

  render(renderer){
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
};

// ---------------------------------------------------------------------------
// Возрождение
// ---------------------------------------------------------------------------

function spawn(){
  const points = room.mode === "team" && map.teamSpawns?.[me.team]?.length
    ? map.teamSpawns[me.team]
    : map.spawns;

  // Из подходящих точек выбираем ту, что дальше всех от живых чужих: появиться
  // лицом к лицу с противником — самый обидный способ умереть.
  let best = points[0], bestScore = -Infinity;
  for (const point of points){
    const here = new THREE.Vector3(...point.pos);
    let nearest = Infinity;
    for (const other of remotes.values()){
      if (other.hp <= 0) continue;
      if (room.mode === "team" && other.team === me.team) continue;
      nearest = Math.min(nearest, here.distanceTo(other.shown));
    }
    const score = nearest === Infinity ? Math.random() * 10 : nearest;
    if (score > bestScore){ bestScore = score; best = point; }
  }

  self.pos.set(...best.pos);
  self.vel.set(0, 0, 0);
  self.hp = 100;
  self.alive = true;
  self.fell = false;
  self.height = PLAYER.height;
  controls.yaw = best.yaw;
  controls.pitch = 0;
  hud.health(self.hp);
  hud.hideBanner();
  net.pushScore(roomId, me.sessionUid, { hp: 100 });
}

// ---------------------------------------------------------------------------
// Сеть
// ---------------------------------------------------------------------------

function wireNetwork(){
  stopWatchers.push(net.watchPlayers(roomId, {
    onJoin(id, data){
      if (id === me.sessionUid) return;
      const remote = new RemotePlayer(id, data);
      remotes.set(id, remote);
      scene.add(remote.group);
      refreshBoard();
    },
    onUpdate(id, data){
      if (id === me.sessionUid) return;
      remotes.get(id)?.apply(data);
      refreshBoard();
    },
    onLeave(id){
      const remote = remotes.get(id);
      if (remote){ remote.dispose(scene); remotes.delete(id); refreshBoard(); }
    }
  }));

  stopWatchers.push(net.watchEvents(roomId, event => {
    if (event.type === "shot" && event.from !== me.sessionUid){
      drawTracer(
        new THREE.Vector3(event.ox, event.oy, event.oz),
        new THREE.Vector3(event.hx, event.hy, event.hz)
      );
    }

    if (event.type === "hit" && event.to === me.sessionUid && self.alive){
      takeDamage(event.dmg, event.from, event.byName);
    }

    if (event.type === "kill"){
      const killer = event.killerName || "Кто-то";
      const victim = event.victimName || "боец";
      hud.kill(killer, victim, event.killer === me.sessionUid || event.victim === me.sessionUid);
      if (event.killer === me.sessionUid){
        localStats.kills++;
        net.pushScore(roomId, me.sessionUid, { kills: localStats.kills });
        checkGoal();
      }
    }
  }));

  stopWatchers.push(net.watchChat(roomId, message => {
    hud.chat(message, message.uid === me.uid);
  }));

  stopWatchers.push(net.watchMeta(roomId, meta => {
    if (!meta){ endMatch("Комната закрылась"); return; }
    room = meta;
    if (meta.state === net.ROOM_STATE.OVER && !matchOver) endMatch(meta.winner || "Матч окончен");
  }));

  // Отправка своего состояния идёт по таймеру, а не каждый кадр: шестьдесят
  // записей в секунду на игрока не нужны никому, а трафик съедят.
  const sender = setInterval(() => {
    if (!self.alive) return;
    net.pushState(roomId, me.sessionUid, {
      x: round(self.pos.x), y: round(self.pos.y), z: round(self.pos.z),
      yaw: round(controls.yaw), hp: Math.round(self.hp)
    });
  }, 1000 / SEND_HZ);
  stopWatchers.push(() => clearInterval(sender));

  // Обязанности хозяина комнаты: подавать признаки жизни (иначе комната
  // пропадёт из списка) и подчищать старые события, чтобы ветка не росла
  // вечно. Хозяин определяется по сессии, а не по uid: правила базы сверяют
  // именно её.
  if (room.hostSession === me.sessionUid){
    stopWatchers.push(net.hostHeartbeat(roomId));
    const pruner = setInterval(() => net.pruneEvents(roomId), 12_000);
    stopWatchers.push(() => clearInterval(pruner));
  }

  addEventListener("beforeunload", () => { leaveRoom?.(); });
}

const round = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Управление
// ---------------------------------------------------------------------------

function wireInput(){

  controls.onChat = () => {
    controls.blocked = true;
    controls.releaseLock();
    hud.openChat();
  };

  hud.onSend = text => {
    net.sendChat(roomId, { uid: me.uid, name: me.name, tag: me.tag, text });
    controls.blocked = false;
    controls.requestLock();
  };

  document.addEventListener("keydown", e => {
    if (controls.blocked) return;
    if (e.code === "KeyR") arsenal?.startReload();
    if (e.code === "Digit1") arsenal?.select(0);
    if (e.code === "Digit2") arsenal?.select(1);
    if (e.code === "Tab"){ e.preventDefault(); hud.showBoard(true); }
  });
  document.addEventListener("keyup", e => {
    if (e.code === "Tab") hud.showBoard(false);
  });
  addEventListener("wheel", () => { if (!controls.blocked) arsenal?.next(); }, { passive: true });

  const start = document.getElementById("start");
  start.addEventListener("click", () => {
    controls.blocked = false;
    controls.requestLock();
  });
  controls.onLockChange = locked => {
    start.classList.toggle("gone", locked);
    if (!locked && !hud.chatOpen) start.querySelector("span").textContent =
      "Пауза. Нажми, чтобы вернуться в бой";
  };
}

// ---------------------------------------------------------------------------
// Кадр
// ---------------------------------------------------------------------------

function frame(){
  const dt = Math.min(clock.getDelta(), 0.05);   // после сворачивания вкладки
                                                 // dt бывает огромным — тогда
                                                 // игрок телепортируется сквозь
                                                 // стены. Ограничиваем.
  if (matchOver){ renderer.render(scene, camera); return; }

  arsenal.tick();
  stepSelf(dt);
  for (const remote of remotes.values()) remote.update(dt);
  stepShooting(dt);
  stepTracers(dt);

  camera.position.set(self.pos.x, self.pos.y + (self.height - PLAYER.height + PLAYER.eye), self.pos.z);
  camera.rotation.set(controls.pitch, controls.yaw, 0, "YXZ");

  const speed = Math.hypot(self.vel.x, self.vel.z);
  viewModel.update(dt, speed, arsenal.current.id);

  hud.ammo(arsenal);
  hud.timer(secondsLeft());

  renderer.render(scene, camera);
  viewModel.render(renderer);

  if (secondsLeft() <= 0 && !matchOver) endMatch("Время вышло");
}

function stepSelf(dt){
  if (!self.alive){
    if (performance.now() / 1000 >= self.respawnAt) spawn();
    return;
  }

  const grounded = onGround(self, map.colliders);
  const crouching = !!controls.keys.crouch;

  // Приседание: меняем высоту коробки, а не только камеру — иначе под вагоном
  // можно было бы пройти, только если смотреть в пол.
  const wanted = crouching ? PLAYER.crouchHeight : PLAYER.height;
  self.height += (wanted - self.height) * Math.min(1, dt * 12);

  const forward = (controls.keys.fwd ? 1 : 0) - (controls.keys.back ? 1 : 0);
  const strafe  = (controls.keys.right ? 1 : 0) - (controls.keys.left ? 1 : 0);

  const dir = new THREE.Vector3(strafe, 0, -forward);
  if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), controls.yaw);

  const maxSpeed = crouching ? PLAYER.crouchSpeed
    : (controls.keys.sprint && forward > 0 ? PLAYER.sprint : PLAYER.speed);

  // В воздухе управление резко слабее — иначе прыжок превращается в полёт.
  const control = grounded ? 1 : PLAYER.airControl;
  const accel = grounded ? 52 : 52 * PLAYER.airControl;

  self.vel.x += (dir.x * maxSpeed - self.vel.x) * Math.min(1, dt * accel * control / 6);
  self.vel.z += (dir.z * maxSpeed - self.vel.z) * Math.min(1, dt * accel * control / 6);

  if (grounded && dir.lengthSq() === 0){
    const friction = Math.max(0, 1 - dt * 12);
    self.vel.x *= friction;
    self.vel.z *= friction;
  }

  if (controls.keys.jump && grounded && !crouching) self.vel.y = PLAYER.jump;
  self.vel.y -= PLAYER.gravity * dt;

  movePlayer(self, self.vel.clone().multiplyScalar(dt), map.colliders);

  if (self.fell){ self.fell = false; takeDamage(1000, null, "Пропасть"); }
}

function stepShooting(dt){
  if (!self.alive || !controls.locked || controls.blocked) return;
  if (!controls.firing) return;

  const weapon = arsenal.current;
  if (!arsenal.canFire()) return;
  arsenal.consume();

  const origin = camera.position.clone();
  const base = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const moving = Math.hypot(self.vel.x, self.vel.z) > 1.4;
  const spread = moving ? weapon.spreadMoving : weapon.spread;

  const targets = [...remotes.values()]
    .filter(r => r.hp > 0 && (room.mode !== "team" || r.team !== me.team));

  let farthest = origin.clone().addScaledVector(base, 60);
  let anyHit = false;

  for (let i = 0; i < weapon.pellets; i++){
    const dir = scatter(base, spread, THREE);
    const hit = raycast(origin, dir, map.colliders, targets);
    const point = hit?.point || origin.clone().addScaledVector(dir, 120);
    if (i === 0) farthest = point;

    if (hit?.target){
      anyHit = true;
      const dmg = damageAt(weapon, hit.distance);
      net.sendEvent(roomId, {
        type: "hit", to: hit.target.id, from: me.sessionUid,
        byName: me.name, dmg: Math.round(dmg), weapon: weapon.id
      });
    }
  }

  if (anyHit) hud.hitMark();

  drawTracer(origin.clone().addScaledVector(base, 0.6), farthest);
  viewModel.kick(weapon.recoil * 26);
  controls.pitch = Math.min(Math.PI / 2 - 0.02, controls.pitch + weapon.recoil);

  net.sendEvent(roomId, {
    type: "shot", from: me.sessionUid,
    ox: round(origin.x), oy: round(origin.y), oz: round(origin.z),
    hx: round(farthest.x), hy: round(farthest.y), hz: round(farthest.z)
  });
}

// ---------------------------------------------------------------------------
// Урон и смерть
// ---------------------------------------------------------------------------

function takeDamage(amount, fromSession, fromName){
  if (!self.alive) return;
  self.hp -= amount;
  hud.health(self.hp);
  hud.damageFlash();

  if (self.hp > 0){
    net.pushScore(roomId, me.sessionUid, { hp: Math.round(self.hp) });
    return;
  }

  self.alive = false;
  self.hp = 0;
  localStats.deaths++;
  self.respawnAt = performance.now() / 1000 + RESPAWN_DELAY;

  net.pushScore(roomId, me.sessionUid, { hp: 0, deaths: localStats.deaths });
  net.sendEvent(roomId, {
    type: "kill",
    killer: fromSession || null,
    killerName: fromName || "Пропасть",
    victim: me.sessionUid,
    victimName: me.name
  });

  hud.banner("Вас убил " + (fromName || "никто"), `Возрождение через ${RESPAWN_DELAY} с`, RESPAWN_DELAY * 1000);
  controls.firing = false;
}

function checkGoal(){
  const goal = GOAL[room.mode] || GOAL.dm;
  const mine = room.mode === "team" ? teamScore(me.team) : localStats.kills;
  hud.score(mine, goal, room.mode);
  if (mine >= goal && room.hostSession === me.sessionUid){
    net.setRoomState(roomId, net.ROOM_STATE.OVER, { winner: room.mode === "team"
      ? `Победила команда ${me.team === "a" ? "песочных" : "синих"}`
      : `Победил ${me.name}` });
  }
}

function teamScore(team){
  let total = team === me.team ? localStats.kills : 0;
  for (const remote of remotes.values()) if (remote.team === team) total += remote.kills || 0;
  return total;
}

function secondsLeft(){
  return MATCH_SECONDS - (Date.now() - (room.startedAt || room.createdAt || Date.now())) / 1000;
}

async function endMatch(reason){
  if (matchOver) return;
  matchOver = true;
  controls.releaseLock();
  hud.banner("Матч окончен", reason, 0);
  document.getElementById("start").classList.add("gone");
  document.getElementById("finish").classList.add("show");
  document.getElementById("finishKills").textContent = localStats.kills;
  document.getElementById("finishDeaths").textContent = localStats.deaths;

  // Итог пишем в Firestore ОДНОЙ записью в самом конце. Начислять очки по ходу
  // боя — это и лишний расход бесплатного лимита, и задержка ровно тогда,
  // когда она мешает больше всего.
  try {
    await addMatchResult(me.uid, {
      points: localStats.kills * 10,
      kills: localStats.kills,
      deaths: localStats.deaths
    });
  } catch { /* не записалось — матч это не портит */ }
}

// ---------------------------------------------------------------------------
// Трассеры
// ---------------------------------------------------------------------------

function drawTracer(from, to){
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85 });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  tracers.push({ line, life: 0.09 });
}

function stepTracers(dt){
  for (let i = tracers.length - 1; i >= 0; i--){
    const tracer = tracers[i];
    tracer.life -= dt;
    tracer.line.material.opacity = Math.max(0, tracer.life / 0.09) * 0.85;
    if (tracer.life <= 0){
      scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
      tracers.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Табло
// ---------------------------------------------------------------------------

function refreshBoard(){
  const rows = [{
    name: me.name, tag: me.tag, team: me.team,
    kills: localStats.kills, deaths: localStats.deaths, me: true
  }];
  for (const remote of remotes.values()){
    rows.push({
      name: remote.name, tag: remote.tag, team: remote.team,
      kills: remote.kills || 0, deaths: remote.deaths || 0, me: false
    });
  }
  hud.scoreboard(rows, room.mode);
  checkGoal();
}

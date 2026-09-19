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
import { ensurePlayer, addMatchResult, displayName } from "../profile.js";
import { buildMap, mapMeta } from "./maps/index.js";
import { PLAYER, movePlayer, onGround, raycast } from "./physics.js";
import { Controls } from "./controls.js";
import { Arsenal, damageAt, scatter, COINS_PER_KILL, COINS_PER_MATCH } from "./weapons.js";
import { RemotePlayer } from "./remote.js";
import { Hud } from "./hud.js";
import { TouchControls, isTouchDevice } from "./touch.js";
import {
  wakeSound, setVolume, getVolume, playShot, playRemoteShot, playHit, playHurt,
  playReloadOut, playReloadIn, playSwitch, playDeath, playSpawn, playKill,
  playMatchEnd, playStep, playChat, playClick
} from "./sound.js";
import * as net from "../net/live.js";
import { registerServiceWorker } from "../pwa.js";
import {
  setupRenderer, dressMap, detailMaterial, readQuality, saveQuality, QUALITY, QUALITY_ORDER
} from "./render.js";

const MATCH_SECONDS = 8 * 60;
const GOAL = { dm: 25, team: 40 };
const RESPAWN_DELAY = 3;
const SEND_HZ = 12;

const params = new URLSearchParams(location.search);
const roomId = params.get("room");

const hud = new Hud();
const canvas = document.getElementById("view");

// Служебный работник — чтобы игра, открытая как приложение, стартовала из кэша.
registerServiceWorker();

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
let touch = null;
let stepAt = 0;
let leaving = false;
let saved = false;
let aimNow = 1;          // текущее приближение, плавно едет к целевому
let scopeShown = false;
let stopAnnounce = null;
let quality = readQuality();
let presence = [];       // кто сейчас в игре — для панели в паузе
let roomList = [];       // открытые комнаты — туда можно перейти
const BASE_FOV = 78;

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
    // В бою человека зовут его игровым позывным, а не именем из мессенджера:
    // имя там пишут для переписки, а над головой нужно короткое.
    name: displayName(profile),
    tag: profile.tag,
    team: "free"
  };

  room = await waitForMeta();
  if (!room) throw new Error("Комната закрылась.");

  // Мест может не остаться, пока человек шёл сюда из лобби. Правила базы такого
  // всё равно не пустят, но отказ от базы выглядит как поломка — скажем прямо.
  const seats = await net.roomCapacity(roomId);
  if (!seats.ok) throw new Error(seats.reason);

  map = buildMap(room.map);
  buildScene();
  // Управление создаём до первого возрождения: spawn() ставит controls.yaw.
  controls = new Controls(canvas);
  // В бой идём с тем набором, который собран в оружейной. Если он пуст или
  // в нём оружие, которого уже нет, Arsenal сам подставит автомат.
  arsenal = new Arsenal(profile.loadout);

  // Команду выбираем по чётности числа уже вошедших: так две стороны
  // наполняются поровну без отдельного распорядителя.
  if (room.mode === "team"){
    me.team = (room.count || 0) % 2 === 0 ? "a" : "b";
  }

  leaveRoom = await net.joinRoom(roomId, me.sessionUid, {
    uid: me.uid, name: me.name, tag: me.tag || null, team: me.team,
    w: arsenal.current.id
  });

  // Объявляем, где мы: по этому и видно в лобби и в паузе, кто сейчас играет,
  // и по этому же друг заходит к другу одной кнопкой.
  stopAnnounce = await net.announce(me.sessionUid, {
    uid: me.uid, nick: me.name, tag: me.tag || null,
    room: roomId, map: room.map, mode: room.mode, team: me.team
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
  scene.add(map.group);

  camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.08, 600);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setSize(innerWidth, innerHeight);

  // Свет, поверхность и воздух — всё в render.js. Здесь только зовём: небо
  // куполом, карта окружения под цвет этой карты, шум в шероховатости и
  // нормали, разрешение теней. Качество берётся из настроек или угадывается
  // по устройству.
  setupRenderer(renderer, quality);
  dressMap(renderer, scene, map, quality);

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

    const metal = new THREE.MeshStandardMaterial({ color: 0x5b6469, roughness: 0.45, metalness: 0.55 });
    const wood  = new THREE.MeshStandardMaterial({ color: 0x6d4f31, roughness: 0.85 });

    // РАССТОЯНИЯ ЗДЕСЬ — САМОЕ ВАЖНОЕ. Камера смотрит вдоль -Z, и всё, что
    // ближе примерно четверти метра, раздувается на пол-экрана; а то, что
    // заехало за нулевую отметку, камера показывает изнутри — чёрным пятном.
    // В первой версии приклад торчал назад до z = -0.02, то есть стоял
    // вплотную к объективу, и правый нижний угол экрана заливало чёрным.
    // Теперь ближняя точка модели — затылок приклада — в 41 см от камеры,
    // дальняя — срез ствола — в 128 см.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.095, 0.4), metal);
    body.position.z = -0.05;
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.32), metal);
    barrel.position.z = -0.4;
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.03), metal);
    sight.position.set(0, 0.065, -0.22);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.16), wood);
    stock.position.z = 0.23;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.13, 0.07), wood);
    grip.position.set(0, -0.09, 0.1);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.075), metal);
    mag.position.set(0, -0.1, -0.05);

    // Ствол в руках — ближайший к глазу предмет на экране, и если он остался
    // гладким пластиком, вся работа над картой пропадает зря: глаз сравнивает
    // именно с ним. Поэтому тот же шум и то же окружение, что и у карты, но
    // масштаб мельче — предмет-то маленький.
    const q = QUALITY[quality];
    for (const material of [metal, wood]){
      if (q.detail) detailMaterial(material, { bump: q.bump * 0.5, scale: 9, tint: 0.12 });
      material.envMap = scene.environment || null;
      material.envMapIntensity = 0.5 + material.metalness * 0.6;
    }

    this.group.add(body, barrel, sight, stock, grip, mag);
    this.base = new THREE.Vector3(0.21, -0.15, -0.72);
    this.group.position.copy(this.base);
    this.group.rotation.set(0.02, -0.07, 0.03);
    this.scene.add(this.group);

    this.flash = new THREE.PointLight(0xffd9a0, 0, 2.2);
    this.flash.position.set(0.2, -0.1, -0.95);
    this.scene.add(this.flash);

    // Свет на оружии — три источника, как ставят предмет в студии, и заливка
    // нарочно слабая. Раньше тут была почти ровная засветка со всех сторон, и
    // после тональной компрессии ствол превращался в плоский силуэт: грани
    // переставали отличаться друг от друга, и самый близкий к глазу предмет на
    // экране выглядел вырезанным из бумаги.
    //
    //   ключевой  — тёплый, сверху-слева: он и лепит форму;
    //   заполняющий — холодный, снизу-справа и втрое слабее: он не даёт тени
    //                 провалиться в чёрное, но формы не портит;
    //   контровой — сзади: тонкая светлая кромка по верхнему ребру, от которой
    //               предмет отделяется от карты за ним.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.28));

    const key = new THREE.DirectionalLight(0xfff0dc, 2.0);
    key.position.set(-0.7, 1, 0.45);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xbcd2e8, 0.7);
    fill.position.set(0.8, -0.5, 0.3);
    this.scene.add(fill);

    // Контровой слабее ключевого втрое: его задача — тонкая кромка, а не
    // второй блик. На единице верхняя грань ствола уходила в чистый белый.
    const rim = new THREE.DirectionalLight(0xffffff, 0.62);
    rim.position.set(0.2, 0.55, -1);
    this.scene.add(rim);

    this.recoil = 0;
    this.bob = 0;
    this.fit = 1;
    this._measure();

    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this._measure();
    });
  },

  /**
   * На телефоне в горизонтальном положении экран низкий и широкий, и ствол при
   * той же геометрии занимает половину высоты. Ужимаем его по высоте экрана,
   * а не по ширине — от ширины он не зависит.
   */
  _measure(){
    this.fit = Math.max(0.62, Math.min(1, innerHeight / 620));
  },

  update(dt, speed, weapon){
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.bob += dt * speed * 1.5;

    const sway = Math.sin(this.bob) * 0.007 * Math.min(1, speed / 7);
    const lift = Math.abs(Math.cos(this.bob)) * 0.005 * Math.min(1, speed / 7);

    this.group.position.set(
      this.base.x + sway,
      this.base.y + lift - this.recoil * 0.02,
      this.base.z + this.recoil * 0.05
    );
    this.group.rotation.x = 0.02 + this.recoil * 0.22;
    // Дробовик короче и толще — заметно даже краем глаза.
    const fat = weapon === "shotgun";
    const k = this.fit;
    this.group.scale.set(k * (fat ? 1.3 : 1), k * (fat ? 1.15 : 1), k * (fat ? 0.82 : 1));
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
  playSpawn();
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
      const from = new THREE.Vector3(event.ox, event.oy, event.oz);
      drawTracer(from, new THREE.Vector3(event.hx, event.hy, event.hz));
      // Чужой выстрел слышно тише и глуше — по этому звуку и понимаешь,
      // далеко стреляют или уже за спиной.
      playRemoteShot(event.weapon, from.distanceTo(camera.position));
      remotes.get(event.from)?.kick();
    }

    if (event.type === "hit" && event.to === me.sessionUid && self.alive){
      takeDamage(event.dmg, event.from, event.byName);
    }

    if (event.type === "kill"){
      const killer = event.killerName || "Кто-то";
      const victim = event.victimName || "боец";
      hud.kill(killer, victim, event.killer === me.sessionUid || event.victim === me.sessionUid);
      if (event.killer === me.sessionUid){
        playKill();
        localStats.kills++;
        net.pushScore(roomId, me.sessionUid, { kills: localStats.kills });
        // Счёт раунда на общем сервере прибавляется ИМЕННО ЗДЕСЬ, в момент
        // убийства, и нигде больше. checkGoal() зовётся ещё и при каждом
        // обновлении табло — поставь начисление туда, и счёт команды рос бы от
        // любого шевеления в комнате.
        if (room.permanent) net.addRoundKill(me.team);
        checkGoal();
      }
    }
  }));

  // Кто сейчас играет — для панели в паузе. Держим подписку всё время, а не
  // заводим её по Escape: подписка дешёвая, а пауза должна открываться сразу,
  // а не «сейчас посмотрим».
  stopWatchers.push(net.watchPresence(rows => { presence = rows; renderWhoNow(); }));
  stopWatchers.push(net.watchRooms(rows => { roomList = rows; renderWhoNow(); }));

  // Связь. На плохом интернете чужие бойцы просто перестают двигаться, и без
  // подсказки это неотличимо от «в комнате никого». Говорим прямо.
  let wasOnline = true;
  stopWatchers.push(net.watchConnection(online => {
    document.getElementById("netlost").classList.toggle("show", !online);
    if (online && !wasOnline) hud.say("Связь вернулась.");
    wasOnline = online;
  }));

  stopWatchers.push(net.watchChat(roomId, message => {
    hud.chat(message, message.uid === me.uid);
    if (message.uid !== me.uid) playChat();
  }));

  stopWatchers.push(net.watchMeta(roomId, meta => {
    if (!meta){ endMatch("Комната закрылась"); return; }
    const wasRound = roundNow;
    room = meta;
    if (meta.permanent){
      // Общий сервер не заканчивается — у него меняются раунды.
      if (!wasRound){ roundNow = meta.round || 1; roundMap = meta.map || null; }
      else if (meta.round && meta.round !== wasRound) onRoundChanged(meta);
      hud.score(roundScore(me.team), net.MAIN.killsToWin, "team");
      return;
    }
    if (meta.state === net.ROOM_STATE.OVER && !matchOver) endMatch(meta.winner || "Матч окончен");
  }));

  // Отправка своего состояния идёт по таймеру, а не каждый кадр: шестьдесят
  // записей в секунду на игрока не нужны никому, а трафик съедят.
  const sender = setInterval(() => {
    if (!self.alive) return;
    net.pushState(roomId, me.sessionUid, {
      x: round(self.pos.x), y: round(self.pos.y), z: round(self.pos.z),
      yaw: round(controls.yaw),
      // Наклон взгляда и ствол в руках: без них чужой боец стоит с ружьём
      // строго горизонтально и всегда с автоматом, чем бы ни стрелял.
      pitch: round(controls.pitch),
      w: arsenal.current.id,
      hp: Math.round(self.hp)
    });
  }, 1000 / SEND_HZ);
  stopWatchers.push(() => clearInterval(sender));

  // Пульс комнаты подаёт КАЖДЫЙ, кто в ней есть, а не только хозяин: иначе
  // стоило хозяину закрыть вкладку — и комната пропадала из списка, хотя бой
  // в ней идёт. Заодно тем же ударом пульса обновляется число игроков, которое
  // лобби показывает как «3/8».
  stopWatchers.push(net.roomHeartbeat(roomId, () => remotes.size + 1));

  // Подчищать старые события — дело хозяина: если это будут делать все сразу,
  // получится лишний трафик на ровном месте.
  if (room.hostSession === me.sessionUid){
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
  const start = document.getElementById("start");

  controls.onChat = () => {
    controls.blocked = true;
    controls.releaseLock();
    hud.openChat();
  };

  hud.onSend = text => {
    net.sendChat(roomId, { uid: me.uid, name: me.name, tag: me.tag, text });
    controls.blocked = false;
    if (!touch) controls.requestLock();
  };

  const reload = () => { if (arsenal.startReload()) playReloadOut(); };
  const swap   = () => { if (arsenal.next()) playSwitch(); };

  document.addEventListener("keydown", e => {
    if (controls.blocked) return;
    if (e.code === "Escape"){ openPause(); return; }
    if (e.code === "KeyR") reload();
    if (e.code === "Digit1" && arsenal.select(0)) playSwitch();
    if (e.code === "Digit2" && arsenal.select(1)) playSwitch();
    if (e.code === "Tab"){ e.preventDefault(); hud.showBoard(true); }
  });
  document.addEventListener("keyup", e => {
    if (e.code === "Tab") hud.showBoard(false);
  });
  addEventListener("wheel", () => { if (!controls.blocked && arsenal.next()) playSwitch(); },
    { passive: true });

  // ---- телефон ------------------------------------------------------------
  if (isTouchDevice()){
    touch = new TouchControls(controls, {
      onReload: reload, onSwap: swap, onPause: openPause,
      // Из настройки кнопок возвращаемся туда же, откуда в неё вошли, — в паузу.
      onEditDone: () => { document.getElementById("start").classList.remove("gone"); openPause(); }
    });
    // Табло на телефоне открывается тапом по счёту вверху — Tab нажать нечем.
    const bar = document.getElementById("topbar");
    let boardOpen = false;
    bar.addEventListener("click", () => {
      boardOpen = !boardOpen;
      hud.showBoard(boardOpen);
    });
    // Захвата мыши на телефоне нет, поэтому "в игре" объявляем сами — иначе
    // стрельба, завязанная на controls.locked, никогда бы не включилась.
    controls.requestLock = () => {
      controls.locked = true;
      controls.onLockChange?.(true);
    };
    controls.releaseLock = () => {
      controls.locked = false;
      controls.onLockChange?.(false);
    };
  }

  // ---- пуск и пауза -------------------------------------------------------
  start.addEventListener("click", event => {
    // Клик по кнопкам внутри меню обрабатывают сами кнопки.
    if (event.target.closest("#pauseBox")) return;
    if (start.classList.contains("paused")) return;
    wakeSound();
    controls.blocked = false;
    controls.requestLock();
  });

  document.getElementById("resumeBtn").onclick = () => {
    start.classList.remove("paused");
    controls.requestLock();
  };
  document.getElementById("leaveBtn").onclick = () => leaveMatch();

  // ---- настройка экранных кнопок -----------------------------------------
  // Кнопка есть смысл только там, где эти кнопки вообще нарисованы.
  const editBtn = document.getElementById("editTouchBtn");
  if (!touch) editBtn.remove();
  else editBtn.onclick = () => {
    // Меню паузы уезжает, чтобы не закрывать те самые кнопки, которые человек
    // сейчас двигает; игра при этом остаётся на паузе.
    document.getElementById("start").classList.add("gone");
    touch.startEdit();
  };

  // ---- комната: код и закрытие -------------------------------------------
  const codeBox = document.getElementById("roomCode");
  codeBox.textContent = room.code || "—";
  document.getElementById("copyCodeBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(room.code || "");
      hud.say("Код скопирован — отправь его своим.");
    } catch {
      // На телефоне и без https буфер обмена запрещён: тогда просто выделяем,
      // чтобы человек скопировал сам. Молчать в этом месте нельзя — выглядит
      // как сломанная кнопка.
      hud.say("Скопировать не дали — код на экране: " + (room.code || "—"));
    }
    playClick();
  };

  // Закрыть комнату может только тот, кто её создал: правила базы сверяют
  // ключ сессии, и у остальных кнопка просто не нужна.
  const closeBtn = document.getElementById("closeRoomBtn");
  if (room.hostSession !== me.sessionUid){
    closeBtn.remove();
  } else {
    closeBtn.onclick = async () => {
      if (closeBtn.dataset.sure !== "1"){
        closeBtn.dataset.sure = "1";
        closeBtn.textContent = "Точно закрыть? Нажми ещё раз";
        setTimeout(() => {
          if (!closeBtn.isConnected) return;
          closeBtn.dataset.sure = "";
          closeBtn.textContent = "Закрыть комнату";
        }, 4000);
        return;
      }
      closeBtn.disabled = true;
      closeBtn.textContent = "Закрываем…";
      await net.closeRoom(roomId).catch(() => {});
      leaveMatch();
    };
  }

  // ---- качество картинки --------------------------------------------------
  // Смена качества перестраивает шейдеры и карту окружения, поэтому делается
  // перезагрузкой матча, а не на ходу: половина настроек (шум в шейдере,
  // разрешение теней, PMREM) живёт внутри уже собранных материалов, и снимать
  // их по одной — верный способ получить наполовину перестроенную сцену.
  const qualityRow = document.getElementById("qualityRow");
  for (const id of QUALITY_ORDER){
    const button = document.createElement("button");
    button.type = "button";
    button.className = quality === id ? "on" : "";
    button.textContent = QUALITY[id].name;
    button.onclick = () => {
      if (quality === id) return;
      saveQuality(id);
      playClick();
      hud.banner("Графика: " + QUALITY[id].name, "Перезапускаем матч", 1400);
      setTimeout(() => location.reload(), 900);
    };
    qualityRow.append(button);
  }

  const volume = document.getElementById("volume");
  volume.value = Math.round(getVolume() * 100);
  document.getElementById("volumeValue").textContent = volume.value;
  volume.oninput = () => {
    setVolume(Number(volume.value) / 100);
    document.getElementById("volumeValue").textContent = volume.value;
  };

  controls.onLockChange = locked => {
    start.classList.toggle("gone", locked);
    touch?.setVisible(locked);
    if (locked){
      start.classList.remove("paused");
      wakeSound();
    }
  };
}

/**
 * Панель «кто сейчас играет» в паузе.
 *
 * Сверху — бойцы этого матча со счётом, ниже — все остальные, кто сейчас в
 * «Заставе»: в какой комнате и на какой карте. Смысл именно в нижней части:
 * зайти вдвоём в пустую комнату и не понять, что рядом идёт матч на шестерых, —
 * обычное дело, когда список видно только из лобби.
 */
function renderWhoNow(){
  const here = $("whoHere"), other = $("whoElse");
  if (!here || !other) return;

  // Свой матч: я и все чужие бойцы, по убийствам.
  const rows = [
    { name: me.name, team: me.team, kills: localStats.kills, deaths: localStats.deaths, mine: true },
    ...[...remotes.values()].map(r => ({
      name: r.name, team: r.team, kills: r.kills || 0, deaths: r.deaths || 0
    }))
  ].sort((a, b) => b.kills - a.kills);

  here.innerHTML = "";
  for (const row of rows){
    const line = document.createElement("div");
    line.className = "who-row" + (row.mine ? " mine" : "");
    line.innerHTML = `
      <span class="who-team ${row.team || "free"}"></span>
      <b>${escapeHtml(row.name)}</b>
      <u>${row.kills}</u><u class="dim">${row.deaths}</u>`;
    here.append(line);
  }

  // Остальные комнаты. Своя не считается, закрытые не показываем — но если
  // там играет кто-то из присутствия, число всё равно видно по комнате.
  const counts = new Map();
  for (const row of presence){
    if (!row.room || row.room === roomId) continue;
    counts.set(row.room, (counts.get(row.room) || 0) + 1);
  }

  const elsewhere = roomList
    .filter(r => r.id !== roomId && !r.priv && r.state !== net.ROOM_STATE.OVER)
    .map(r => ({ ...r, live: counts.get(r.id) || r.count || 0 }))
    .sort((a, b) => b.live - a.live)
    .slice(0, 6);

  const playing = presence.filter(r => r.room).length;
  $("whoCount").textContent = `${playing} в игре`;

  other.innerHTML = "";
  if (!elsewhere.length){
    other.innerHTML = `<p class="who-empty">Других матчей сейчас нет.</p>`;
    return;
  }
  for (const room of elsewhere){
    const line = document.createElement("div");
    line.className = "who-room";
    const isMain = room.id === net.MAIN_ROOM;
    line.innerHTML = `
      <div>
        <b>${isMain ? "Застава — общий" : escapeHtml(room.hostName || "Боец")}</b>
        <i>${escapeHtml(mapMeta(room.map).name)} · ${room.mode === "team" ? "команда" : "каждый сам"}</i>
      </div>
      <span>${room.live}/${room.maxPlayers || 4}</span>
      <button class="btn btn-ghost tiny" type="button">Перейти</button>`;
    line.querySelector("button").onclick = () => switchRoom(room.id);
    other.append(line);
  }
}

const $ = id => document.getElementById(id);

function escapeHtml(text){
  return String(text ?? "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Уйти в другой матч. Сначала выходим честно, потом переходим. */
async function switchRoom(id){
  if (leaving) return;
  leaving = true;
  stopAnnounce?.();
  for (const stop of stopWatchers) { try { stop(); } catch { /* ignore */ } }
  stopWatchers = [];
  try { await leaveRoom?.(); } catch { /* ignore */ }
  await saveResult();
  location.href = `game.html?room=${id}`;
}

/** Меню паузы. Оно же — экран, с которого бой начинается. */
function openPause(){
  if (matchOver || leaving) return;
  const start = document.getElementById("start");
  controls.releaseLock();
  controls.firing = false;
  start.classList.add("paused");
  start.classList.remove("gone");
  renderWhoNow();
  document.getElementById("startTitle").textContent = "Пауза";
  document.getElementById("startSub").textContent = "Матч продолжается без тебя";
  touch?.setVisible(false);
}

/**
 * Выход в лобби. Сначала убираем себя из комнаты и записываем итог, и только
 * потом уходим со страницы: уйти первым — значит бросить в базе бойца, который
 * ещё несколько секунд будет стоять на карте мишенью для остальных.
 */
async function leaveMatch(){
  if (leaving) return;
  leaving = true;
  stopAnnounce?.();
  document.getElementById("leaveBtn").textContent = "Выходим…";

  for (const stop of stopWatchers) { try { stop(); } catch { /* ignore */ } }
  stopWatchers = [];
  try { await leaveRoom?.(); } catch { /* ignore */ }
  await saveResult();
  location.href = "lobby.html";
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

  if (arsenal.tick()) playReloadIn();
  stepSelf(dt);
  for (const remote of remotes.values()) remote.update(dt);
  stepShooting(dt);
  stepTracers(dt);

  camera.position.set(self.pos.x, self.pos.y + (self.height - PLAYER.height + PLAYER.eye), self.pos.z);
  camera.rotation.set(controls.pitch, controls.yaw, 0, "YXZ");

  const speed = Math.hypot(self.vel.x, self.vel.z);
  viewModel.update(dt, speed, arsenal.current.id);
  stepAim(dt);
  stepSteps(dt, speed);
  stepLabels();
  stepRound();

  hud.ammo(arsenal);
  hud.timer(secondsLeft());

  renderer.render(scene, camera);
  viewModel.render(renderer);

  // На общем сервере нулевой таймер — это конец РАУНДА, им занимается
  // stepRound; заканчивать матч по нему нельзя, матч там бесконечный.
  if (!room.permanent && secondsLeft() <= 0 && !matchOver) endMatch("Время вышло");
}

/**
 * Имена над головами: гасим те, что за стеной.
 *
 * Метка рисуется поверх всей сцены (depthTest отключён) — иначе её резало бы
 * собственной каской бойца и углами вагонов, и читалась бы она кусками.
 * Обратная сторона ровно та, на которую и жаловались: имя светилось сквозь
 * стены, и по нему было видно, кто за каким вагоном стоит, — половина смысла
 * укрытий на «Депо» и «Теплицах» пропадала.
 *
 * Поэтому видимость считаем сами: пускаем луч от глаз к голове чужого бойца и
 * смотрим, не упрётся ли он раньше в геометрию карты. СТЕКЛО не считается
 * преградой (raycast пропускает bulletPass) — и это правильно: сквозь стекло
 * человека и так видно целиком, прятать над ним имя было бы странно.
 *
 * Считаем не каждый кадр, а раз в сотню миллисекунд и по одному лучу на
 * бойца: имя не должно мигать от каждого шага, а лишние лучи по всем
 * коллайдерам карты — это как раз то, на чём проседает частота кадров.
 */
const LABEL_RANGE = 90;        // дальше имена не читаются всё равно
let labelClock = 0;
const labelDir = new THREE.Vector3();
const labelHead = new THREE.Vector3();

function stepLabels(){
  const now = performance.now();
  if (now - labelClock < 100) return;
  labelClock = now;

  for (const remote of remotes.values()){
    remote.head(labelHead);
    labelDir.copy(labelHead).sub(camera.position);
    const distance = labelDir.length();

    if (distance > LABEL_RANGE){ remote.setVisible(false); continue; }
    labelDir.divideScalar(distance || 1);

    // Цели не передаём: нас интересует только, есть ли СТЕНА между нами.
    const hit = raycast(camera.position, labelDir, map.colliders, [], distance - 0.3);
    remote.setVisible(!hit);
  }
}

/**
 * Прицеливание по правой кнопке. Меняем угол обзора камеры, а не двигаем её:
 * так не нужно ни второй модели оружия, ни отдельной анимации, а ощущение
 * приближения то же самое. Чувствительность мыши делится на то же число —
 * без этого при трёхкратном прицеле навести на человека невозможно.
 */
function stepAim(dt){
  const weapon = arsenal.current;
  const want = controls.aiming && self.alive ? weapon.zoom : 1;
  aimNow += (want - aimNow) * Math.min(1, dt * 12);

  camera.fov = BASE_FOV / aimNow;
  camera.updateProjectionMatrix();
  controls.zoomFactor = aimNow;

  // Окуляр показываем только у винтовки и только когда приближение почти
  // доехало: мелькающая чёрная рамка при каждом клике раздражает.
  const scoped = weapon.id === "sniper" && aimNow > weapon.zoom * 0.75;
  if (scoped !== scopeShown){
    scopeShown = scoped;
    document.body.classList.toggle("scoped", scoped);
    // Через окуляр ствол не видно — в него и смотрят. Оставленная в кадре
    // модель торчала бы прямо посреди прицельной картинки.
    viewModel.group.visible = !scoped;
  }
}

/** Шаги. Частота от скорости; в воздухе молчим. */
function stepSteps(dt, speed){
  if (!self.alive || speed < 1.5 || !onGround(self, map.colliders)) return;
  const now = performance.now() / 1000;
  const interval = 0.42 * (PLAYER.speed / Math.max(speed, 1));
  if (now - stepAt > interval){
    stepAt = now;
    playStep();
  }
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
  // Прицеливание втрое собирает разброс — это и есть смысл правой кнопки.
  const aimBonus = controls.aiming ? 0.34 : 1;
  const spread = (moving ? weapon.spreadMoving : weapon.spread) * aimBonus;

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

  playShot(weapon.id);
  if (anyHit){ hud.hitMark(); playHit(); }

  drawTracer(origin.clone().addScaledVector(base, 0.6), farthest);
  viewModel.kick(weapon.recoil * 26);
  controls.pitch = Math.min(Math.PI / 2 - 0.02, controls.pitch + weapon.recoil);

  net.sendEvent(roomId, {
    type: "shot", from: me.sessionUid, weapon: weapon.id,
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
  playHurt();

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

  playDeath();
  hud.banner("Вас убил " + (fromName || "никто"), `Возрождение через ${RESPAWN_DELAY} с`, RESPAWN_DELAY * 1000);
  controls.firing = false;
  controls.aiming = false;
}

function checkGoal(){
  // Общий сервер живёт раундами: цель — счёт КОМАНДЫ за раунд, он же лежит в
  // meta и одинаков у всех. Здесь только показываем: начисляет обработчик
  // убийства, потому что сюда заходят ещё и по обновлению табло.
  if (room.permanent){
    hud.score(roundScore(me.team), net.MAIN.killsToWin, "team");
    return;
  }

  const goal = GOAL[room.mode] || GOAL.dm;
  const mine = room.mode === "team" ? teamScore(me.team) : localStats.kills;
  hud.score(mine, goal, room.mode);
  if (mine >= goal && room.hostSession === me.sessionUid){
    net.setRoomState(roomId, net.ROOM_STATE.OVER, { winner: room.mode === "team"
      ? `Победила команда ${me.team === "a" ? "песочных" : "синих"}`
      : `Победил ${me.name}` });
  }
}

/**
 * Счёт команды за текущий раунд на общем сервере.
 *
 * Берётся из meta, а не складывается из счётчиков бойцов, и это важно: убийства
 * у бойца копятся за всё время, что он в комнате, а раунд обнуляется. Складывая
 * личные счётчики, мы бы получали сумму за весь вечер, и раунд заканчивался бы
 * через минуту после начала.
 */
function roundScore(team){
  return Number(team === "b" ? room.scoreB : room.scoreA) || 0;
}

/**
 * Раунды на общем сервере.
 *
 * Крутит их ровно один клиент — тот, чей ключ сессии меньше всех среди
 * присутствующих. Это не выборы: все видят один и тот же список игроков и
 * приходят к одному ответу сами, а когда ведущий уходит, следующий по порядку
 * берёт дело на себя молча. Иначе четверо разом начали бы четыре раунда.
 *
 * Проверяем раз в две секунды, а не каждый кадр: спешить некуда, а шестьдесят
 * записей в секунду в meta не нужны никому.
 */
let roundCheckedAt = 0;
function stepRound(){
  if (!room?.permanent || matchOver || leaving) return;

  const now = Date.now();
  if (now - roundCheckedAt < 2000) return;
  roundCheckedAt = now;

  const sessions = [me.sessionUid, ...remotes.keys()];
  if (!net.isRoundKeeper(me.sessionUid, sessions)) return;

  const done = roundScore("a") >= net.MAIN.killsToWin
            || roundScore("b") >= net.MAIN.killsToWin
            || now > (room.roundEnds || 0);
  if (done) net.nextRound(room).catch(() => {});
}

/**
 * Начался новый раунд.
 *
 * Если вместе с ним сменилась карта — перезагружаем страницу. Перестраивать
 * сцену на ходу можно, но это самый богатый на ошибки кусок работы во всей
 * игре: надо снять все старые коллайдеры, выбросить геометрию, переставить
 * всех бойцов и не забыть ни одной мелочи. Перезагрузка делает то же самое
 * гарантированно и занимает секунду — на общем сервере это происходит раз в
 * полчаса, и лучше честная пауза, чем редкий необъяснимый сбой.
 */
let roundNow = 0;
let roundMap = null;      // карта, по которой мы СЕЙЧАС бегаем

function onRoundChanged(meta){
  // Сравниваем с отдельно запомненной картой, а не с room.map. Причина в том,
  // что room к этому моменту уже переписан пришедшим meta, и карта в нём,
  // разумеется, новая; а полагаться на то, что предыдущий объект meta никто не
  // изменил, нельзя — это зависит от того, отдаёт ли библиотека копию.
  // Собственная переменная не зависит ни от чего.
  const mapChanged = meta.map && roundMap && meta.map !== roundMap;
  roundNow = meta.round;
  roundMap = meta.map || roundMap;

  if (mapChanged){
    hud.banner(mapMeta(meta.map).name, `Раунд ${meta.round} — меняем карту`, 3000);
    playMatchEnd();
    setTimeout(() => { location.href = `game.html?room=${roomId}`; }, 3200);
    return;
  }

  hud.banner(`Раунд ${meta.round}`, "Счёт обнулён", 2200);
  playSpawn();
  localStats.kills = 0;
  net.pushScore(roomId, me.sessionUid, { kills: 0, deaths: localStats.deaths });
  if (self.alive) { self.hp = 100; hud.health(self.hp); }
  else spawn();
}

function teamScore(team){
  let total = team === me.team ? localStats.kills : 0;
  for (const remote of remotes.values()) if (remote.team === team) total += remote.kills || 0;
  return total;
}

function secondsLeft(){
  // На общем сервере матч не кончается никогда — кончается РАУНД, и его конец
  // записан в meta.roundEnds. Считать от начала матча тут нечего: он идёт
  // круглосуточно.
  if (room.permanent) return ((room.roundEnds || Date.now()) - Date.now()) / 1000;
  return MATCH_SECONDS - (Date.now() - (room.startedAt || room.createdAt || Date.now())) / 1000;
}

/**
 * Запись итога. Вынесена отдельно, потому что поводов два: матч кончился сам
 * или человек вышел в лобби посреди боя. Во втором случае честно засчитываем
 * всё, что он успел: уход не должен обнулять полчаса игры.
 */
async function saveResult(){
  if (saved) return;
  saved = true;
  try {
    await addMatchResult(me.uid, {
      points: localStats.kills * 10,
      coins: localStats.kills * COINS_PER_KILL + COINS_PER_MATCH,
      kills: localStats.kills,
      deaths: localStats.deaths
    });
  } catch { /* не записалось — матч это не портит */ }
}

async function endMatch(reason){
  if (matchOver) return;
  matchOver = true;
  controls.releaseLock();
  touch?.setVisible(false);
  playMatchEnd();

  hud.banner("Матч окончен", reason, 0);
  document.getElementById("start").classList.add("gone");
  document.getElementById("finish").classList.add("show");
  document.getElementById("finishKills").textContent = localStats.kills;
  document.getElementById("finishDeaths").textContent = localStats.deaths;
  document.getElementById("finishCoins").textContent =
    "+" + (localStats.kills * COINS_PER_KILL + COINS_PER_MATCH);

  // Итог пишем в Firestore ОДНОЙ записью в самом конце. Начислять по ходу боя
  // — это и лишний расход бесплатного лимита, и задержка ровно тогда, когда
  // она мешает больше всего.
  await saveResult();
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

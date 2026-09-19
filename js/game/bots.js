// bots.js — боты на общем сервере.
//
// Зачем они вообще. Круглосуточный сервер без людей — это пустая карта и
// надпись «1 в игре». Человек заходит, видит пустоту и уходит, и следующий
// видит ровно то же самое. Боты разрывают этот круг: зашёл — а там идёт бой.
//
// Кто их считает. Своего сервера у игры нет, поэтому ботов ведёт ОДИН клиент —
// тот же, что крутит раунды: чей ключ сессии меньше всех в комнате. Он держит
// их у себя в голове, двигает, стреляет за них и складывает положение в базу,
// откуда его читают остальные. Ведущий ушёл — следующий по порядку подхватывает
// ботов с их последних позиций и ведёт дальше; мысли прежнего ведущего при
// этом теряются, и бот просто заново решает, куда идти. Это незаметно.
//
// Отсюда и важное свойство: без единого человека в комнате ботов НЕ СЧИТАЕТ
// НИКТО. Пустой сервер не жжёт трафик впустую — и не должен.
//
// Честность. Боты играют по тем же правилам, что люди: та же физика, то же
// оружие с тем же уроном и разбросом, те же стены. Они не видят сквозь
// геометрию и не стреляют сквозь дым. Единственная поблажка себе — они не
// «целятся» мышью, а поворачиваются к цели с ограниченной скоростью, и им
// добавлена задержка реакции: без неё бот попадает в момент появления врага в
// поле зрения, и играть против такого невозможно.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
import { PLAYER, movePlayer, raycast } from "./physics.js";
import { WEAPONS, damageAt } from "./weapons.js";
import { BOMB } from "./modes.js";

export const BOT_PREFIX = "bot:";
export const isBotId = id => typeof id === "string" && id.startsWith(BOT_PREFIX);

/** Сколько ботов держим и как быстро они уходят, когда приходят люди. */
export const CREW = {
  target: 10,          // столько бойцов должно быть в комнате всего
  maxBots: 10,
  sendHz: 8            // как часто их положение уходит в базу
};

// Повадки. Подобраны так, чтобы бота можно было обыграть, а не чтобы он был
// беспомощным: он попадает, но не мгновенно и не всегда.
const SKILL = {
  reaction: 0.3,       // секунд от «увидел» до первого выстрела
  aimSpeed: 4.2,       // радиан в секунду: насколько быстро доворачивает ствол
  aimError: 0.035,     // разброс прицеливания, радианы (~2°)
  burst: 0.4,          // сколько стреляет очередью
  rest: 0.45,          // и сколько отдыхает между очередями
  sight: 90,           // дальше этого не замечает вовсе, метры
  fov: Math.PI * 0.62, // и не видит того, что сильно сбоку
  lose: 2.5            // секунд помнит врага, которого потерял из виду
};

const NAMES = [
  "Сивый", "Тумак", "Кедр", "Штык", "Лось", "Кнопка", "Грач", "Шило",
  "Дрозд", "Батон", "Фитиль", "Хмурый", "Сойка", "Лещ", "Гвоздь", "Пепел"
];

const GUNS = ["rifle", "rifle", "smg", "shotgun", "sniper"];

const up = new THREE.Vector3(0, 1, 0);

/** Один бот. Живёт только в голове ведущего; наружу уходит лишь положение. */
class Bot {
  constructor(id, { name, team, weapon, spawn, yaw }){
    this.id = id;
    this.name = name;
    this.team = team;
    this.weapon = weapon;

    this.pos = spawn.clone();
    this.vel = new THREE.Vector3();
    this.height = PLAYER.height;
    this.yaw = yaw || 0;
    this.pitch = 0;
    this.hp = 100;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.respawnAt = 0;

    this.path = null;
    this.step = 0;
    this.goal = null;          // куда идём и зачем
    this.job = "roam";
    this.hold = 0;             // сколько держим кнопку на точке
    this.repath = 0;           // когда пора пересчитать дорогу

    this.enemy = null;         // кого видим
    this.seenFor = 0;          // сколько секунд уже видим
    this.lostFor = 0;
    this.fireFor = 0;          // фаза очереди
    this.resting = 0;
    this.lastShot = 0;
  }

  eye(out){ return out.set(this.pos.x, this.pos.y + PLAYER.eye, this.pos.z); }

  get spec(){ return WEAPONS[this.weapon] || WEAPONS.rifle; }
}

/**
 * Отряд ботов: заводит, ведёт и выкладывает в базу.
 *
 * Наружу отдаёт ровно то, что нужно main.js: «вот их положение, разошли» и
 * «вот что случилось, сообщи остальным».
 */
export class BotCrew {
  constructor({ map, nav, mode, random = Math.random, hooks = {} }){
    this.map = map;
    this.nav = nav;
    this.mode = mode;
    this.random = random;
    this.hooks = hooks;         // onShot, onHit, onKill, onPlant, onDefuse
    this.bots = new Map();
    this.nextId = 1;
    this.usedNames = new Set();
    this.clock = 0;
  }

  get list(){ return [...this.bots.values()]; }

  /**
   * Довести число бойцов до нужного.
   *
   * Считаем ВМЕСТЕ с людьми: цель — чтобы в комнате было десятеро, а не чтобы
   * ботов было десять. Пришёл человек — лишний бот уходит, но не мгновенно:
   * выдёргивать бойца посреди перестрелки некрасиво, поэтому убирают только
   * между раундами (см. release).
   */
  fill(humans, teamCount){
    const want = Math.max(0, Math.min(CREW.maxBots, CREW.target - humans));
    while (this.bots.size < want) this._add(teamCount);
    return this.bots.size;
  }

  /** Отпустить лишних — зовётся на смене раунда, а не посреди боя. */
  release(humans){
    const want = Math.max(0, Math.min(CREW.maxBots, CREW.target - humans));
    const extra = this.list.slice(want);
    for (const bot of extra){
      this.bots.delete(bot.id);
      this.usedNames.delete(bot.name);
    }
    return extra.map(bot => bot.id);
  }

  _add(teamCount){
    const id = BOT_PREFIX + (this.nextId++);
    const free = NAMES.filter(n => !this.usedNames.has(n));
    const name = free.length ? free[Math.floor(this.random() * free.length)] : "Боец " + this.nextId;
    this.usedNames.add(name);

    // В какую сторону: туда, где народу меньше. Иначе одна сторона пустая.
    const a = teamCount?.a ?? 0, b = teamCount?.b ?? 0;
    const team = a <= b ? "a" : "b";
    if (teamCount){ teamCount[team] = (teamCount[team] || 0) + 1; }

    const spawn = this._spawnFor(team);
    const bot = new Bot(id, {
      name, team,
      weapon: GUNS[Math.floor(this.random() * GUNS.length)],
      spawn: spawn.pos, yaw: spawn.yaw
    });
    this.bots.set(id, bot);
    return bot;
  }

  _spawnFor(team){
    const points = this.map.teamSpawns?.[team]?.length
      ? this.map.teamSpawns[team]
      : this.map.spawns;
    const pick = points[Math.floor(this.random() * points.length)];
    return { pos: new THREE.Vector3(...pick.pos), yaw: pick.yaw || 0 };
  }

  /** Новый раунд: все живы и стоят на своих местах. */
  restart(){
    for (const bot of this.bots.values()){
      const spawn = this._spawnFor(bot.team);
      bot.pos.copy(spawn.pos);
      bot.vel.set(0, 0, 0);
      bot.yaw = spawn.yaw;
      bot.hp = 100;
      bot.alive = true;
      bot.respawnAt = 0;
      bot.path = null;
      bot.goal = null;
      bot.hold = 0;
      bot.enemy = null;
    }
  }

  /** Записать боту убийство. Зовётся, когда он завалил человека. */
  credit(botId){
    const bot = this.bots.get(botId);
    if (bot) bot.kills++;
  }

  /** Урон боту. Возвращает true, если этим его убили. */
  hurt(botId, damage, fromId, fromName){
    const bot = this.bots.get(botId);
    if (!bot || !bot.alive) return false;
    bot.hp -= damage;
    if (bot.hp > 0) return false;

    bot.hp = 0;
    bot.alive = false;
    bot.deaths++;
    bot.enemy = null;
    bot.respawnAt = this.mode?.respawn === false ? Infinity : this.clock + 5;
    this.credit(fromId);
    this.hooks.onKill?.({ killer: fromId, killerName: fromName, victim: botId, victimName: bot.name });
    return true;
  }

  /**
   * Шаг всего отряда.
   *
   * world — то, что боты видят вокруг: живые бойцы (люди и другие боты),
   * состояние бомбы и можно ли сейчас вообще шевелиться.
   */
  step(dt, world){
    this.clock += dt;
    world.dt = dt;
    for (const bot of this.bots.values()){
      if (!bot.alive){
        if (this.clock >= bot.respawnAt) this._revive(bot);
        continue;
      }
      this._look(bot, dt, world);
      this._decide(bot, world);
      this._walk(bot, dt, world);
      this._shoot(bot, dt, world);
    }
  }

  _revive(bot){
    const spawn = this._spawnFor(bot.team);
    bot.pos.copy(spawn.pos);
    bot.vel.set(0, 0, 0);
    bot.yaw = spawn.yaw;
    bot.hp = 100;
    bot.alive = true;
    bot.path = null;
    bot.goal = null;
  }

  // ---- зрение ------------------------------------------------------------

  /**
   * Кого видно. Именно ВИДНО: луч от глаз к голове, поле зрения и дальность.
   *
   * Бот, который знает про врага за стеной, ломает всю игру — прятаться от
   * него бессмысленно. Поэтому проверка ровно та же, по которой игра решает,
   * гасить ли имя над головой: raycast по геометрии карты. Дым тоже считается
   * преградой, иначе дымовая граната против ботов не работает вовсе.
   */
  _look(bot, dt, world){
    const eye = bot.eye(new THREE.Vector3());
    const forward = new THREE.Vector3(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));

    let best = null, bestDistance = Infinity;
    for (const target of world.fighters){
      if (target.team === bot.team || target.id === bot.id || target.hp <= 0) continue;

      const head = new THREE.Vector3(target.pos.x, target.pos.y + PLAYER.eye, target.pos.z);
      const to = head.clone().sub(eye);
      const distance = to.length();
      if (distance > SKILL.sight || distance > bestDistance) continue;

      const dir = to.clone().divideScalar(distance);
      const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      if (flat.dot(forward) < Math.cos(SKILL.fov / 2)) continue;       // сбоку не видит
      if (raycast(eye, dir, this.map.colliders, [], distance - 0.3)) continue;
      if (world.blocked?.(eye, head)) continue;                        // дым

      best = target;
      bestDistance = distance;
    }

    if (best){
      if (bot.enemy?.id !== best.id) bot.seenFor = 0;
      bot.enemy = best;
      bot.enemyAt = new THREE.Vector3(best.pos.x, best.pos.y, best.pos.z);
      bot.seenFor += dt;
      bot.lostFor = 0;
    } else if (bot.enemy){
      bot.lostFor += dt;
      // Совсем забывать врага сразу нельзя: боец, нырнувший за угол,
      // перестал бы существовать, и бот тут же отвернулся бы от него.
      if (bot.lostFor > SKILL.lose){ bot.enemy = null; bot.seenFor = 0; }
    }
  }

  // ---- решение: куда идти ------------------------------------------------

  _decide(bot, world){
    if (this.clock < bot.repath && bot.path) return;

    const goal = this._goalFor(bot, world);
    if (!goal) return;

    // Пересчитываем дорогу, только если цель уехала: путь по сетке стоит
    // миллисекунды, но десять ботов по шестьдесят раз в секунду — это уже
    // заметно, а цель почти всегда там же, где была.
    const moved = !bot.goal || bot.goal.distanceTo(goal) > 4;
    if (moved || !bot.path || bot.step >= bot.path.length){
      const path = this.nav.path(bot.pos, goal);
      if (path){
        bot.path = path;
        bot.step = 0;
        bot.goal = goal.clone();
      } else {
        // Дороги нет. Раньше бот в этом случае всё равно получал цель и шёл к
        // ней напрямик — то есть упирался в скалу и стоял в неё до конца
        // раунда. Теперь он честно признаёт, что туда не пройти, и идёт куда
        // может: на другую точку, а если и туда никак — просто гулять.
        this._giveUp(bot, world);
      }
    }
    bot.repath = this.clock + 0.6 + this.random() * 0.6;
  }

  /** Цель недостижима — выбираем другую, до которой дорога есть. */
  _giveUp(bot, world){
    const sites = this.map.sites || [];
    const tries = [];
    // Сперва другая точка закладки: раунд она не ломает.
    for (let i = 0; i < sites.length; i++){
      if (i !== bot.site) tries.push({ site: i, at: new THREE.Vector3(...sites[i]) });
    }
    for (let k = 0; k < 4; k++){
      const spot = this.nav.randomSpot(this.random);
      if (spot) tries.push({ site: bot.site, at: spot });
    }

    for (const attempt of tries){
      const path = this.nav.path(bot.pos, attempt.at);
      if (!path) continue;
      bot.site = attempt.site;
      bot.path = path;
      bot.step = 0;
      bot.goal = attempt.at.clone();
      return;
    }
    // Совсем некуда — стоим. Лучше, чем упираться в стену.
    bot.path = null;
    bot.goal = null;
  }

  _goalFor(bot, world){
    const bomb = world.bomb;
    const sites = this.map.sites || [];

    if (this.mode?.id === "bomb" && sites.length){
      const planted = bomb?.state === "planted";
      if (planted){
        const at = new THREE.Vector3(bomb.x, bomb.y, bomb.z);
        // Спецназ бежит снимать, террористы — сторожить: и тем и другим туда.
        bot.job = bot.team === "b" ? "defuse" : "guard";
        return at;
      }
      if (bot.team === "a"){
        bot.job = world.carrier === bot.id ? "plant" : "push";
        return new THREE.Vector3(...sites[this._siteFor(bot, sites)]);
      }
      bot.job = "hold";
      return new THREE.Vector3(...sites[this._siteFor(bot, sites)]);
    }

    // В обычных режимах идём к тому, кого видели последним, иначе — гуляем.
    if (bot.enemyAt){ bot.job = "fight"; return bot.enemyAt; }
    bot.job = "roam";
    return this.nav.randomSpot(this.random);
  }

  /** Какую точку этот бот считает «своей» в этом раунде. */
  _siteFor(bot, sites){
    if (bot.site === undefined || bot.site >= sites.length){
      bot.site = Math.floor(this.random() * sites.length);
    }
    return bot.site;
  }

  // ---- движение ----------------------------------------------------------

  _walk(bot, dt, world){
    if (world.frozen){ bot.vel.x = 0; bot.vel.z = 0; }

    const wantStill = this._working(bot, world);
    let wish = new THREE.Vector3();

    // Куда шагать: по пути, а когда путь кончился — прямо к цели.
    //
    // Последнее важнее, чем кажется. Путь идёт по клеткам сетки, и последняя
    // клетка отстоит от настоящей цели на шаг сетки. Пока бот на ней и
    // останавливался, он замирал в трёх-четырёх метрах от точки закладки — то
    // есть НЕ в зоне, — и упорно ничего не закладывал, хотя стоял почти на
    // месте. Со стороны это выглядело как тупой бот, а на деле не хватало
    // последних двух метров.
    let point = null;
    if (!wantStill){
      let arrive = 1.2;
      if (bot.path && bot.step < bot.path.length) point = bot.path[bot.step];
      // Напрямик — только когда путь пройден до конца. Без пути идти напрямик
      // нельзя: это и есть «бот уткнулся в стену».
      else if (bot.path && bot.goal){ point = bot.goal; arrive = 0.7; }

      if (point){
        const flat = new THREE.Vector3(point.x - bot.pos.x, 0, point.z - bot.pos.z);
        if (flat.length() < arrive){
          if (bot.path && bot.step < bot.path.length) bot.step++;
        } else {
          wish = flat.normalize();
        }
      }
    }

    // Когда стреляем — идём медленнее: иначе бот носится и попадает, что
    // выглядит нечестно, да и человеку так проще в него попасть.
    const speed = bot.enemy ? PLAYER.speed * 0.55 : PLAYER.speed;
    const target = wish.multiplyScalar(speed);
    const accel = 12 * dt;
    bot.vel.x += (target.x - bot.vel.x) * Math.min(1, accel);
    bot.vel.z += (target.z - bot.vel.z) * Math.min(1, accel);
    bot.vel.y -= PLAYER.gravity * dt;

    const { grounded } = movePlayer(bot, bot.vel.clone().multiplyScalar(dt), this.map.colliders);
    if (grounded && bot.vel.y < 0) bot.vel.y = 0;

    // Застрял ли.
    //
    // Смотрим не «сдвинулся ли», а «ПРИБЛИЗИЛСЯ ли к точке, куда идёт». Разница
    // решающая: бот, упёршийся в угол, не стоит — он скользит вдоль стены и
    // прекрасно «двигается», просто никуда. Первая версия проверяла смещение и
    // такого бота честно считала идущим; он тёрся об угол до конца раунда.
    // Раз в секунду сверяем расстояние до цели: не сократилось — значит дорога
    // не работает, пробуем следующую точку пути, а кончились — ищем заново.
    // Проверяем, только если бот ВООБЩЕ пытается идти. Дошедший и стоящий у
    // цели не «застрял» — он пришёл; без этой оговорки бот у точки закладки
    // сам себе объявлял, что дорога не работает, и уходил перекладывать путь
    // вместо того, чтобы класть бомбу.
    if (!wantStill && point && wish.lengthSq() > 0){
      if (this.clock - (bot.progressAt || 0) > 1){
        const now = Math.hypot(point.x - bot.pos.x, point.z - bot.pos.z);
        if (bot.lastGap !== undefined && now > bot.lastGap - 0.4){
          if (bot.path && bot.step < bot.path.length - 1) bot.step++;
          else { bot.path = null; bot.goal = null; bot.repath = 0; }
          bot.lastGap = undefined;
        } else bot.lastGap = now;
        bot.progressAt = this.clock;
      }
    } else {
      bot.lastGap = undefined;
      bot.progressAt = this.clock;
    }

    // Куда смотрит: на врага, если видит, иначе — куда идёт.
    const aim = bot.enemy
      ? new THREE.Vector3(bot.enemy.pos.x, bot.enemy.pos.y + PLAYER.eye, bot.enemy.pos.z)
      : (bot.path?.[bot.step] || null);
    if (aim){
      const eye = bot.eye(new THREE.Vector3());
      const to = aim.clone().sub(eye);
      const wantYaw = Math.atan2(-to.x, -to.z);
      const wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      bot.yaw += angleTo(bot.yaw, wantYaw) * Math.min(1, SKILL.aimSpeed * dt);
      bot.pitch += (wantPitch - bot.pitch) * Math.min(1, SKILL.aimSpeed * dt);
    }
  }

  /** Стоит ли бот на месте и делает дело — закладывает или снимает. */
  _working(bot, world){
    if (this.mode?.id !== "bomb" || world.frozen) return false;
    const sites = this.map.sites || [];
    const bomb = world.bomb;
    const planted = bomb?.state === "planted";

    if (bot.team === "a" && !planted && world.carrier === bot.id){
      const site = this._siteFor(bot, sites);
      const at = sites[site];
      if (!at) return false;
      // Та же зона, что у человека, только с небольшим запасом от края: бот
      // подходит к середине, и на границе ему делать нечего.
      const near = Math.hypot(bot.pos.x - at[0], bot.pos.z - at[2]) < BOMB.siteRadius * 0.9
                && Math.abs(bot.pos.y - at[1]) < 3.5;
      if (!near) return false;
      bot.hold += world.dt;
      if (bot.hold >= BOMB.plantTime){
        bot.hold = 0;
        this.hooks.onPlant?.({ bot, site, at });
      }
      return true;
    }

    if (bot.team === "b" && planted){
      const near = Math.hypot(bot.pos.x - bomb.x, bot.pos.z - bomb.z) < 2.0
                && Math.abs(bot.pos.y - bomb.y) < 3.5;
      if (!near) return false;
      bot.hold += world.dt;
      if (bot.hold >= BOMB.defuseTime){
        bot.hold = 0;
        this.hooks.onDefuse?.({ bot });
      }
      return true;
    }

    bot.hold = 0;
    return false;
  }

  // ---- стрельба ----------------------------------------------------------

  _shoot(bot, dt, world){
    if (!bot.enemy || world.frozen) return;
    // Задержка реакции: бот не открывает огонь в тот же кадр, в котором увидел.
    if (bot.seenFor < SKILL.reaction) return;

    if (bot.resting > 0){ bot.resting -= dt; return; }
    bot.fireFor += dt;
    if (bot.fireFor > SKILL.burst){ bot.fireFor = 0; bot.resting = SKILL.rest; return; }

    const spec = bot.spec;
    const gap = 60 / spec.rpm;
    if (this.clock - bot.lastShot < gap) return;
    bot.lastShot = this.clock;

    const eye = bot.eye(new THREE.Vector3());
    const head = new THREE.Vector3(
      bot.enemy.pos.x, bot.enemy.pos.y + PLAYER.eye * 0.85, bot.enemy.pos.z);
    const dir = head.clone().sub(eye).normalize();

    // Разброс: тот же приём, что и у игрока, только угол задан повадками бота.
    const spread = SKILL.aimError * (bot.vel.lengthSq() > 1 ? 1.8 : 1);
    dir.applyAxisAngle(up, (this.random() - 0.5) * spread * 2);
    dir.applyAxisAngle(new THREE.Vector3(dir.z, 0, -dir.x).normalize(),
                       (this.random() - 0.5) * spread * 2);

    const distance = eye.distanceTo(head);
    const wall = raycast(eye, dir, this.map.colliders, [], distance);
    const end = eye.clone().addScaledVector(dir, wall ? wall.distance : distance);
    this.hooks.onShot?.({ bot, from: eye, to: end });
    if (wall) return;                     // попал в стену, а не в человека

    // Проверка попадания по коробке цели — тем же способом, что у игрока.
    if (!hitsBox(eye, dir, bot.enemy, distance + 0.5)) return;
    const damage = damageAt(spec, distance);
    this.hooks.onHit?.({ bot, target: bot.enemy, damage });
  }

  /**
   * Что уходит в базу: только то, без чего чужого бойца не нарисовать, и
   * только про тех, у кого хоть что-то изменилось.
   *
   * Второе важнее первого. Выкладка всех десятерых восемь раз в секунду — это
   * почти одиннадцать килобайт в секунду на каждого, кто в комнате, то есть
   * четыре с половиной гигабайта в месяц при двух часах игры вдвоём — почти
   * весь бесплатный месячный лимит Realtime Database. А шевелится в каждый
   * момент далеко не всякий: убитые в заминировании лежат до конца раунда и не
   * меняются вовсе, стоящие в засаде — тоже. Отправлять их снова незачем.
   *
   * Сравниваем по ОКРУГЛЁННЫМ числам, тем самым, что уходят в базу: дрожание в
   * сотой доле метра всё равно не долетит, а «изменением» считалось бы каждый
   * раз.
   */
  snapshot(){
    const patch = {};
    for (const bot of this.bots.values()){
      const row = {
        uid: bot.id, name: bot.name, team: bot.team, bot: true,
        x: round(bot.pos.x), y: round(bot.pos.y), z: round(bot.pos.z),
        yaw: round(bot.yaw), pitch: round(bot.pitch),
        w: bot.weapon, hp: Math.round(bot.hp),
        kills: bot.kills, deaths: bot.deaths
      };
      const mark = `${row.x},${row.y},${row.z},${row.yaw},${row.pitch},${row.hp},${row.kills},${row.deaths}`;
      if (bot.sent === mark) continue;
      bot.sent = mark;
      patch[bot.id] = row;
    }
    return patch;
  }

  /** Полная выкладка — на смене раунда и когда отряд только собрался. */
  snapshotAll(){
    for (const bot of this.bots.values()) bot.sent = null;
    return this.snapshot();
  }
}

/** Разница углов, приведённая к отрезку от -π до π. */
function angleTo(from, to){
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Задевает ли луч коробку бойца. */
function hitsBox(origin, dir, target, maxDistance){
  const half = PLAYER.width / 2;
  const box = new THREE.Box3(
    new THREE.Vector3(target.pos.x - half, target.pos.y, target.pos.z - half),
    new THREE.Vector3(target.pos.x + half, target.pos.y + PLAYER.height, target.pos.z + half));
  const ray = new THREE.Ray(origin, dir);
  const point = ray.intersectBox(box, new THREE.Vector3());
  return !!point && origin.distanceTo(point) <= maxDistance;
}

const round = v => Math.round(v * 100) / 100;

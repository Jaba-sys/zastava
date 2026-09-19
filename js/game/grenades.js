// grenades.js — осколочная и дымовая.
//
// Граната — первое в игре, что ЛЕТИТ. Пули считаются лучом: выстрелил и сразу
// знаешь, куда попал. С гранатой так нельзя — весь её смысл в том, что она
// летит по дуге, отскакивает от стены и падает туда, куда прямой наводкой не
// попасть. Значит, нужна настоящая траектория со столкновениями, и она здесь
// есть — но самая простая, какая решает задачу: шар радиусом восемь
// сантиметров, гравитация и отскок от тех же коробок, из которых сложены карты.
//
// Две штуки и обе нужны, потому что решают противоположные задачи:
//
//   осколочная — выбивает из укрытия. Урон падает с расстоянием и НЕ проходит
//        сквозь стены: за углом от взрыва спасает угол, а не расстояние.
//   дымовая    — наоборот, прячет. Она никому не вредит, зато на десять секунд
//        закрывает проход или точку закладки. Без неё выйти на открытое место
//        под прицелом просто нельзя, и карты превращаются в тир.
//
// Дым по-настоящему мешает смотреть: он не только рисуется, но и считается
// преградой для имён над головами (см. smokeBlocks). Дым, сквозь который всё
// видно, — украшение, а не тактика.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
import { raycast } from "./physics.js";

export const GRENADES = {
  frag: {
    id: "frag",
    name: "Граната",
    short: "Оск.",
    about: "Выбивает из укрытия: осколки не заворачивают за угол",
    price: 300,
    fuse: 2.6,             // сколько летит до взрыва
    radius: 7.5,           // дальше этого не задевает совсем
    damage: 120,           // в эпицентре; падает к краю радиуса
    throwSpeed: 17
  },
  smoke: {
    id: "smoke",
    name: "Дымовая",
    short: "Дым",
    about: "Закрывает проход на десять секунд. Урона не наносит",
    price: 350,
    fuse: 1.8,
    radius: 5.2,           // радиус облака
    duration: 11,          // сколько стоит дым
    damage: 0,
    throwSpeed: 15
  }
};

export const GRENADE_ORDER = ["frag", "smoke"];

const GRAVITY = 20;
const BOUNCE = 0.42;        // сколько скорости остаётся после удара о стену
const FRICTION = 0.72;      // ...и сколько — после скольжения по полу
const BALL = 0.08;

/**
 * Одна летящая граната.
 *
 * Считается у КАЖДОГО клиента отдельно, по одинаковым числам: по сети идёт
 * только «бросок такой-то, отсюда, с такой скоростью». Гонять по двенадцать
 * пакетов в секунду на каждую гранату было бы и дорого, и бессмысленно — при
 * одинаковых начальных условиях траектория у всех получится одна и та же.
 */
export class Grenade {
  constructor({ kind, from, velocity, owner, team, at = 0 }){
    this.spec = GRENADES[kind] || GRENADES.frag;
    this.kind = this.spec.id;
    this.owner = owner;
    this.team = team;
    this.pos = from.clone();
    this.vel = velocity.clone();
    this.life = this.spec.fuse;
    this.done = false;
    this.rest = 0;             // сколько лежит неподвижно

    const color = this.kind === "smoke" ? 0x9aa6ad : 0x3f4a3a;
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL, 10, 8),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 })
    );
    this.mesh.castShadow = true;
    this.mesh.position.copy(this.pos);
  }

  /** @returns true, когда пора взрываться. */
  step(dt, colliders){
    if (this.done) return false;

    this.life -= dt;
    this.vel.y -= GRAVITY * dt;

    // Движение дробим на шажки не длиннее радиуса шара: иначе на быстром
    // броске граната за кадр перепрыгивает стену и улетает за карту.
    let left = dt;
    while (left > 0){
      const step = Math.min(left, BALL / Math.max(0.001, this.vel.length()));
      left -= step;
      this._move(step, colliders);
      if (step <= 0) break;
    }

    this.mesh.position.copy(this.pos);
    // Лежащая граната не крутится — вращаем только летящую, чтобы было видно,
    // что она живая.
    if (this.vel.lengthSq() > 0.5){
      this.mesh.rotation.x += dt * 9;
      this.mesh.rotation.z += dt * 6;
    }
    return this.life <= 0;
  }

  _move(dt, colliders){
    const next = this.pos.clone().addScaledVector(this.vel, dt);

    // Проверяем три оси по очереди, как и у игрока: так граната скользит вдоль
    // стены, а не залипает в углу.
    for (const axis of ["x", "y", "z"]){
      const probe = this.pos.clone();
      probe[axis] = next[axis];
      if (this._hits(probe, colliders)){
        this.vel[axis] *= -BOUNCE;
        // Удар о пол гасит и горизонтальную скорость — иначе граната катится
        // по карте бесконечно, как шар для боулинга.
        if (axis === "y" && this.vel.y > -0.4){
          this.vel.x *= FRICTION;
          this.vel.z *= FRICTION;
          if (Math.abs(this.vel.y) < 1.2) this.vel.y = 0;
        }
      } else {
        this.pos[axis] = next[axis];
      }
    }
  }

  _hits(point, colliders){
    for (const c of colliders){
      if (c.bulletPass) continue;      // сквозь стекло граната не пролетает —
      const b = c.box;                 // стекло держит предметы, только не пули
      if (point.x + BALL > b.min.x && point.x - BALL < b.max.x &&
          point.y + BALL > b.min.y && point.y - BALL < b.max.y &&
          point.z + BALL > b.min.z && point.z - BALL < b.max.z) return true;
    }
    return false;
  }

  dispose(scene){
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Урон от осколочной по одной цели.
 *
 * Два множителя, и второй важнее первого. Расстояние — понятно. А вот стена:
 * если между взрывом и человеком есть геометрия, урона НЕТ совсем. Осколки не
 * заворачивают за угол, и именно это делает гранату инструментом, а не
 * лотереей: ты кидаешь её ЗА укрытие, а не «примерно туда».
 */
export function fragDamage(center, target, colliders){
  const spec = GRENADES.frag;
  const to = target.clone().sub(center);
  const distance = to.length();
  if (distance > spec.radius) return 0;

  if (distance > 0.4){
    const dir = to.clone().divideScalar(distance);
    const hit = raycast(center, dir, colliders, [], distance - 0.25);
    if (hit) return 0;
  }

  // Квадратичное падение: у самого центра почти полный урон, у края радиуса
  // почти ничего. Линейное падение даёт слишком «щедрый» край.
  const k = 1 - distance / spec.radius;
  return Math.round(spec.damage * k * k);
}

// ---------------------------------------------------------------------------
// Дым
// ---------------------------------------------------------------------------

/**
 * Облако дыма.
 *
 * Рисуется десятком полупрозрачных шаров разного размера, которые медленно
 * всплывают и расходятся. Частицы тут не нужны: облако должно быть ПЛОТНЫМ и
 * одинаковым у всех, а не красивым — сквозь красивое видно.
 */
export class Smoke {
  constructor(center, at = performance.now() / 1000){
    this.center = center.clone();
    this.radius = GRENADES.smoke.radius;
    this.born = at;
    this.life = GRENADES.smoke.duration;
    this.done = false;

    this.group = new THREE.Group();
    this.puffs = [];
    // Ламберт, а не стандартный материал, и это не экономия на красоте.
    // Облако — одиннадцать больших шаров друг на друге: в упор они закрывают
    // весь экран, и каждый пиксель считается по десять раз. С полным PBR
    // (шероховатость, металл, карта окружения, наш шум поверх) такой кадр
    // складывается в заметную судорогу — на стенде с программным рендером он
    // занимал девять секунд. Дыму физическая точность не нужна вовсе: нужно,
    // чтобы он брал свет карты и был плотным.
    const material = new THREE.MeshLambertMaterial({
      color: 0xd8dde0,
      transparent: true, opacity: 0, depthWrite: false
    });
    this.material = material;

    for (let i = 0; i < 11; i++){
      const r = this.radius * (0.42 + Math.random() * 0.3);
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 7), material);
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * this.radius * 0.6;
      puff.position.set(Math.cos(a) * d, Math.random() * 1.4 - 0.2, Math.sin(a) * d);
      puff.userData.drift = new THREE.Vector3(
        (Math.random() - 0.5) * 0.12, 0.05 + Math.random() * 0.08, (Math.random() - 0.5) * 0.12
      );
      this.group.add(puff);
      this.puffs.push(puff);
    }
    this.group.position.copy(center);
  }

  update(dt, now){
    const age = now - this.born;
    if (age > this.life){ this.done = true; return; }

    // Быстро расходится, долго стоит, быстро тает. Плавное нарастание с обоих
    // концов — иначе облако появляется и исчезает щелчком.
    const rise = Math.min(1, age / 0.6);
    const fade = Math.min(1, (this.life - age) / 1.2);
    this.material.opacity = 0.82 * rise * fade;

    for (const puff of this.puffs) puff.position.addScaledVector(puff.userData.drift, dt);
  }

  /** Плотно ли здесь: закрывает ли дым линию взгляда. */
  blocks(from, to){
    if (this.done) return false;
    // Расстояние от центра облака до отрезка «глаз — цель». Считаем через
    // проекцию: дешевле, чем возиться с пересечением сферы, и точности хватает.
    const line = to.clone().sub(from);
    const len = line.length();
    if (len < 0.001) return false;
    const t = Math.max(0, Math.min(1, this.center.clone().sub(from).dot(line) / (len * len)));
    const near = from.clone().addScaledVector(line, t);
    return near.distanceTo(this.center) < this.radius * 0.85;
  }

  dispose(scene){
    scene.remove(this.group);
    for (const puff of this.puffs) puff.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Прогреть дым заранее.
 *
 * Первый полупрозрачный материал в сцене заставляет видеокарту собрать под него
 * новую программу шейдера, и происходит это ровно в тот кадр, когда дым встаёт.
 * На слабом телефоне это заметная судорога — как раз в секунду, когда человек
 * под дымом перебегает открытое место. Поэтому один невидимый шар собирается и
 * компилируется на загрузке карты, когда ждать не жалко, и тут же выбрасывается:
 * программа остаётся в кэше, а хлопка в бою больше нет.
 *
 * На стенде это к тому же лечило странную поломку: программный рендер собирал
 * ту же программу пятнадцать секунд, и облако успевало «состариться» за один
 * кадр — дым исчезал, не успев появиться.
 */
export function primeSmoke(renderer, scene, camera){
  const warm = new Smoke(camera.position.clone(), 0);
  warm.material.opacity = 0;
  scene.add(warm.group);
  try { renderer.compile(scene, camera); } catch { /* не выйдет — не беда */ }
  warm.dispose(scene);
}

/** Мешает ли хоть одно облако смотреть отсюда туда. */
export function smokeBlocks(clouds, from, to){
  for (const cloud of clouds) if (cloud.blocks(from, to)) return true;
  return false;
}

/**
 * Куда и с какой скоростью полетит граната из рук.
 *
 * Бросок идёт чуть выше линии взгляда: если кидать ровно вперёд, граната
 * втыкается в пол в трёх метрах, и человек не понимает, почему «не долетело».
 * Небольшой подъём решает это без всякого обучения.
 */
export function throwVelocity(camera, kind, extra = 0){
  const spec = GRENADES[kind] || GRENADES.frag;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y += 0.18;
  dir.normalize();
  return dir.multiplyScalar(spec.throwSpeed + extra);
}

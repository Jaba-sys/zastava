// remote.js — чужие бойцы.
//
// Позиции приходят по сети двенадцать раз в секунду, а кадров в секунду —
// шестьдесят. Если ставить чужого игрока ровно туда, откуда пришло последнее
// сообщение, он будет дёргаться рывками. Поэтому каждый кадр мы подтягиваем
// его к последней известной точке плавно — это называется интерполяцией и
// стоит примерно ничего, а разница видна сразу.
//
// Скорость для походки считается ЗДЕСЬ, из того, насколько сдвинулась
// сглаженная позиция, а не приходит по сети: лишнее поле в каждом пакете
// двенадцать раз в секунду того не стоит, а результат тот же.
//
// Коробка для попаданий берётся от ТЕКУЩЕГО, сглаженного положения, а не от
// сетевого: стрелять надо туда, где человек нарисован, иначе промахи кажутся
// несправедливыми.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
import { PLAYER } from "./physics.js";
import { Soldier } from "./soldier.js";

export class RemotePlayer {
  constructor(id, data){
    this.id = id;
    this.uid = data.uid;
    this.name = data.name || "Боец";
    this.tag = data.tag || null;
    this.team = data.team || "free";
    this.hp = data.hp ?? 100;
    this.kills = data.kills || 0;
    this.deaths = data.deaths || 0;

    this.target = new THREE.Vector3(data.x || 0, data.y || 0, data.z || 0);
    this.shown  = this.target.clone();
    this.targetYaw = data.yaw || 0;
    this.shownYaw = this.targetYaw;
    this.pitch = data.pitch || 0;
    this.speed = 0;

    this.group = new THREE.Group();
    this.soldier = new Soldier(this.team, data.w || "rifle");
    this.group.add(this.soldier.root);
    this.group.position.copy(this.shown);

    this.label = makeLabel(this.name);
    this.label.position.y = 2.25;
    this.group.add(this.label);

    this.box = new THREE.Box3();
    this.visible = true;      // видно ли его отсюда — считается в main.js
    this.alive = true;
    this._updateBox();
  }

  /** Точка, по которой проверяется видимость: голова, а не ноги. */
  head(out){
    return out.set(this.shown.x, this.shown.y + PLAYER.eye, this.shown.z);
  }

  apply(data){
    if (typeof data.x === "number") this.target.set(data.x, data.y, data.z);
    if (typeof data.yaw === "number") this.targetYaw = data.yaw;
    if (typeof data.pitch === "number") this.pitch = data.pitch;
    if (typeof data.hp === "number") this.hp = data.hp;
    if (typeof data.kills === "number") this.kills = data.kills;
    if (typeof data.deaths === "number") this.deaths = data.deaths;
    if (data.team) this.team = data.team;
    if (data.w) this.soldier.setWeapon(data.w);
    if (data.name && data.name !== this.name){
      this.name = data.name;
      this.group.remove(this.label);
      this.label = makeLabel(this.name);
      this.label.position.y = 2.25;
      this.group.add(this.label);
    }
  }

  /** Он выстрелил — дёрнуть ствол. Зовётся из обработчика чужих выстрелов. */
  kick(){ this.soldier.kick(); }

  update(dt){
    // Коэффициент подобран так, чтобы отставание было незаметно, а рывки
    // сгладились: за 100 мс боец проходит почти весь путь до цели.
    const k = 1 - Math.pow(0.0008, dt);
    const before = this.shown.clone();
    this.shown.lerp(this.target, k);

    // Скорость по земле — для походки. Вертикальное движение не считаем:
    // падая с обрыва, человек не перебирает ногами быстрее.
    if (dt > 0){
      const moved = Math.hypot(this.shown.x - before.x, this.shown.z - before.z) / dt;
      this.speed += (moved - this.speed) * Math.min(1, dt * 9);
    }

    let diff = this.targetYaw - this.shownYaw;
    while (diff >  Math.PI) diff -= Math.PI * 2;      // кратчайшая сторона
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.shownYaw += diff * k;

    this.group.position.copy(this.shown);
    this.group.rotation.y = this.shownYaw;

    const dead = this.hp <= 0;
    this.soldier.update(dt, this.speed, this.pitch, dead);
    // Мёртвый остаётся лежать, но имя над ним гасим — иначе поле боя
    // превращается в список надписей.
    this.alive = !dead;
    this.label.visible = !dead && this.visible;

    this._updateBox();
  }

  /**
   * Видно ли его отсюда — решает вызывающий (см. stepLabels в main.js) и
   * кладёт сюда. Само по себе имя над головой рисуется ПОВЕРХ всего
   * (depthTest отключён), иначе его резало бы собственной каской; из-за этого
   * оно же светилось и сквозь стены, показывая, кто за каким вагоном стоит.
   */
  setVisible(value){
    this.visible = value;
    this.label.visible = value && this.alive !== false;
  }

  _updateBox(){
    const h = PLAYER.width / 2;
    this.box.min.set(this.shown.x - h, this.shown.y, this.shown.z - h);
    this.box.max.set(this.shown.x + h, this.shown.y + PLAYER.height, this.shown.z + h);
  }

  dispose(scene){
    scene.remove(this.group);
    this.soldier.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

/** Имя над головой — нарисованное на холсте и повёрнутое к камере. */
function makeLabel(text){
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "600 34px 'IBM Plex Sans', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,.75)";
  ctx.strokeText(text, 128, 34);
  ctx.fillStyle = "#ece7db";
  ctx.fillText(text, 128, 34);

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    depthTest: false, transparent: true
  }));
  sprite.scale.set(1.9, 0.48, 1);
  sprite.renderOrder = 10;
  return sprite;
}

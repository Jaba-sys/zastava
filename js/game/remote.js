// remote.js — чужие бойцы.
//
// Позиции приходят по сети двенадцать раз в секунду, а кадров в секунду —
// шестьдесят. Если ставить чужого игрока ровно туда, откуда пришло последнее
// сообщение, он будет дёргаться рывками. Поэтому каждый кадр мы подтягиваем
// его к последней известной точке плавно — это называется интерполяцией и
// стоит примерно ничего, а разница видна сразу.
//
// Коробка для попаданий берётся от ТЕКУЩЕГО, сглаженного положения, а не от
// сетевого: стрелять надо туда, где человек нарисован, иначе промахи кажутся
// несправедливыми.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
import { PLAYER } from "./physics.js";

const TEAM_COLORS = { a: 0xe8a317, b: 0x5aa0d2, free: 0xc9b896 };

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

    this.group = new THREE.Group();
    const color = TEAM_COLORS[this.team] || TEAM_COLORS.free;
    const body = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.8 });

    // Силуэт нарочно простой и угловатый: на карте важно мгновенно отличить
    // человека от ящика, а не рассмотреть на нём швы.
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.8, 0.36), body);
    torso.position.y = 1.12; torso.castShadow = true;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), dark);
    head.position.y = 1.68; head.castShadow = true;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.72, 0.32), dark);
    legs.position.y = 0.36; legs.castShadow = true;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.8), dark);
    gun.position.set(0.28, 1.2, -0.42);

    this.group.add(torso, head, legs, gun);
    this.group.position.copy(this.shown);

    this.label = makeLabel(this.name);
    this.label.position.y = 2.15;
    this.group.add(this.label);

    this.box = new THREE.Box3();
    this._updateBox();
  }

  apply(data){
    if (typeof data.x === "number") this.target.set(data.x, data.y, data.z);
    if (typeof data.yaw === "number") this.targetYaw = data.yaw;
    if (typeof data.hp === "number") this.hp = data.hp;
    if (typeof data.kills === "number") this.kills = data.kills;
    if (typeof data.deaths === "number") this.deaths = data.deaths;
    if (data.team) this.team = data.team;
    if (data.name && data.name !== this.name){
      this.name = data.name;
      this.group.remove(this.label);
      this.label = makeLabel(this.name);
      this.label.position.y = 2.15;
      this.group.add(this.label);
    }
  }

  update(dt){
    // Коэффициент подобран так, чтобы отставание было незаметно, а рывки
    // сгладились: за 100 мс боец проходит почти весь путь до цели.
    const k = 1 - Math.pow(0.0008, dt);
    this.shown.lerp(this.target, k);

    let diff = this.targetYaw - this.shownYaw;
    while (diff >  Math.PI) diff -= Math.PI * 2;      // кратчайшая сторона
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.shownYaw += diff * k;

    this.group.position.copy(this.shown);
    this.group.rotation.y = this.shownYaw;
    this.group.visible = this.hp > 0;
    this._updateBox();
  }

  _updateBox(){
    const h = PLAYER.width / 2;
    this.box.min.set(this.shown.x - h, this.shown.y, this.shown.z - h);
    this.box.max.set(this.shown.x + h, this.shown.y + PLAYER.height, this.shown.z + h);
  }

  dispose(scene){
    scene.remove(this.group);
    this.group.traverse(node => {
      node.geometry?.dispose?.();
      if (node.material?.map) node.material.map.dispose();
      node.material?.dispose?.();
    });
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

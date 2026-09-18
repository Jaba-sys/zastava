// builder.js — маленький набор кубиков, из которых собраны обе карты.
//
// Вся геометрия карт — прямоугольные коробки, и это осознанный выбор, а не
// лень. Столкновения с коробками, выровненными по осям, считаются точно и
// быстро, без физического движка и без "проваливаний сквозь пол", которыми
// славятся самодельные шутеры. Внешний вид при этом держится не на форме, а
// на свете, цвете и пропорциях — карьер и депо выглядят по-разному именно
// поэтому, хотя сложены из одинаковых кирпичей.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

export { THREE };

/**
 * Коллектор геометрии: копит меши для сцены и коробки для столкновений.
 *
 * solid   — стена и для игрока, и для пули (обычная геометрия);
 * glass   — стена для игрока, но пуля проходит насквозь (стёкла диспетчерской);
 * decor   — ни для кого не преграда (фонари, провода, разметка).
 */
export class MapBuilder {
  constructor(){
    this.group     = new THREE.Group();
    this.colliders = [];     // { box: THREE.Box3, bulletPass: bool }
    this.lights    = [];
  }

  /** Коробка: центр по x/z, НИЗ по y — так удобнее ставить на пол. */
  box(x, y, z, w, h, d, material, kind = "solid"){
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = kind !== "decor";
    mesh.receiveShadow = true;
    this.group.add(mesh);

    if (kind !== "decor"){
      this.colliders.push({
        box: new THREE.Box3(
          new THREE.Vector3(x - w / 2, y,     z - d / 2),
          new THREE.Vector3(x + w / 2, y + h, z + d / 2)
        ),
        bulletPass: kind === "glass"
      });
    }
    return mesh;
  }

  /**
   * Пандус: лесенка из коробок, поднимающаяся от (x1,y1,z1) к (x2,y2,z2).
   *
   * base — с какой высоты начинать коробки. По умолчанию 0: пандус стоит на
   * земле сплошным клином, так проще всего. Но сходням, которые идут поверху
   * над проходом, ноль не годится — они превратились бы в глухую стену от
   * самой земли и перекрыли бы всё под собой. Им задают base чуть ниже
   * начальной высоты.
   *
   * Ширина ступени берётся по ТОЙ оси, вдоль которой пандус идёт, а поперёк
   * ставится width. Если этого не сделать, каждая ступень выходит квадратной
   * и они наезжают друг на друга — получается не пандус, а груда кубов с
   * мерцающими гранями.
   */
  ramp(x1, y1, z1, x2, y2, z2, width, material, base = 0, steps = 0){
    const dx = x2 - x1, dz = z2 - z1;
    const alongX = Math.abs(dx) >= Math.abs(dz);

    // Число ступеней считается от ПОДЪЁМА, а не задаётся на глаз. Игрок
    // заходит на уступ не выше PLAYER.maxStep (0.45 м), и достаточно один раз
    // ошибиться — взять 16 ступеней там, где нужно 17, — чтобы лестница стала
    // стеной. На «Депо» ровно так и вышло: сходни на эстакаду выглядели
    // лестницей, а подняться по ним было нельзя. Берём с запасом.
    const rise = Math.abs(y2 - y1);
    steps = Math.max(steps, Math.ceil(rise / 0.28), 4);

    for (let i = 0; i < steps; i++){
      const t0 = i / steps, t1 = (i + 1) / steps;
      const mid = (t0 + t1) / 2;
      const cx = x1 + dx * mid;
      const cz = z1 + dz * mid;
      const top = y1 + (y2 - y1) * t1;
      // +0.04 — нахлёст между ступенями: без него между коробками остаются
      // волосяные щели, в которые игрок цепляется на бегу.
      const sizeX = alongX ? Math.abs(dx) / steps + 0.04 : width;
      const sizeZ = alongX ? width : Math.abs(dz) / steps + 0.04;
      this.box(cx, base, cz, sizeX, Math.max(0.2, top - base), sizeZ, material);
    }
  }

  /** Цилиндр — только на вид (поворотный круг, бочки, водонапорная башня). */
  cylinder(x, y, z, radius, height, material, kind = "solid", segments = 24){
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, segments), material
    );
    mesh.position.set(x, y + height / 2, z);
    mesh.castShadow = kind !== "decor";
    mesh.receiveShadow = true;
    this.group.add(mesh);

    if (kind !== "decor"){
      // Круг оборачиваем вписанным квадратом: разница в пару сантиметров по
      // углам, зато столкновения остаются честными коробками.
      const r = radius * 0.92;
      this.colliders.push({
        box: new THREE.Box3(
          new THREE.Vector3(x - r, y, z - r),
          new THREE.Vector3(x + r, y + height, z + r)
        ),
        bulletPass: false
      });
    }
    return mesh;
  }

  light(light){
    this.group.add(light);
    this.lights.push(light);
    return light;
  }

  /**
   * Невидимые стены по краю карты. Без них человек рано или поздно уходит за
   * geometry и падает в пустоту — а это худший способ проиграть.
   */
  walls(minX, maxX, minZ, maxZ, height = 40){
    const t = 2;
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    this.box((minX + maxX) / 2, 0, minZ - t / 2, maxX - minX + t * 2, height, t, invisible);
    this.box((minX + maxX) / 2, 0, maxZ + t / 2, maxX - minX + t * 2, height, t, invisible);
    this.box(minX - t / 2, 0, (minZ + maxZ) / 2, t, height, maxZ - minZ + t * 2, invisible);
    this.box(maxX + t / 2, 0, (minZ + maxZ) / 2, t, height, maxZ - minZ + t * 2, invisible);
  }
}

/** Материал с лёгким шумом по вершинам — чтобы плоскости не были стерильными. */
export function rough(color, { roughness = 0.95, metalness = 0.02 } = {}){
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/**
 * Куда повернуть бойца в точке возрождения, чтобы он смотрел на цель.
 *
 * Считаем, а не подбираем на глаз: камера смотрит вдоль -Z, повёрнутого на
 * yaw, то есть вперёд у неё (-sin yaw, -cos yaw). Один раз перепутать знак —
 * и человек возрождается носом в стену, что и случилось на первом прогоне
 * обеих карт.
 */
export function yawTowards(from, to){
  return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
}

export function glass(color = 0x9fd4e0){
  return new THREE.MeshStandardMaterial({
    color, transparent: true, opacity: 0.22,
    roughness: 0.1, metalness: 0.1, side: THREE.DoubleSide
  });
}

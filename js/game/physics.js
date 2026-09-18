// physics.js — столкновения, гравитация, прыжок.
//
// Игрок — не капсула и не сфера, а обычная коробка 0.7 x 1.7 x 0.7. Движение
// раскладывается по осям и решается по очереди: сдвинулись по X — вытолкнулись
// из всего, во что влезли, потом по Z, потом по Y. Приём старый и надёжный:
// он не даёт застрять в стыке двух коробок и не пропускает игрока сквозь стену
// на большой скорости, потому что перемещение за кадр дробится на шаги не
// длиннее половины игрока.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

export const PLAYER = {
  width: 0.7,
  height: 1.75,
  eye: 1.62,          // на какой высоте камера относительно ног
  speed: 7.4,
  sprint: 10.6,
  crouchSpeed: 3.6,
  crouchHeight: 1.1,
  jump: 7.2,
  gravity: 22,
  airControl: 0.34,
  maxStep: 0.45       // на какую высоту заходим без прыжка (ступени, рельсы)
};

const MAX_SUBSTEP = 0.3;

// Зазор, на который коробка игрока приподнимается над ногами при проверке
// движения вбок.
//
// Без него игра не работает вовсе, и это неочевидно: коробка игрока начинается
// ровно на уровне пола, пол — коробка, заканчивающаяся ровно там же, и они
// СОПРИКАСАЮТСЯ. Для проверки пересечения соприкосновение — это пересечение,
// поэтому любой шаг вбок тут же объявлялся ударом об стену, скорость обнулялась
// и человек стоял на месте, не понимая, почему не идёт. Приподнимаем на шесть
// сантиметров — пол перестаёт мешать, а всё, что выше этого зазора, по-прежнему
// честная преграда.
const SKIN = 0.06;

/**
 * Коробка игрока. lift — насколько приподнять низ:
 *   SKIN — для движения вбок (пол не считается стеной);
 *   0    — для движения вверх-вниз (пол обязан считаться полом).
 */
function aabb(pos, height, width, lift = 0){
  const h = width / 2;
  return new THREE.Box3(
    new THREE.Vector3(pos.x - h, pos.y + lift, pos.z - h),
    new THREE.Vector3(pos.x + h, pos.y + height, pos.z + h)
  );
}

/** Все коробки, которые пересекает игрок в этой точке. */
function hits(colliders, box){
  const out = [];
  for (const c of colliders) if (c.box.intersectsBox(box)) out.push(c);
  return out;
}

/**
 * Двигает игрока на delta и разбирается со столкновениями.
 * Возвращает { grounded } — стоим ли на чём-то твёрдом.
 */
export function movePlayer(state, delta, colliders){
  let grounded = false;

  // дробим перемещение, чтобы на большой скорости не проскочить стену насквозь
  const steps = Math.max(1, Math.ceil(delta.length() / MAX_SUBSTEP));
  const part = delta.clone().divideScalar(steps);

  for (let s = 0; s < steps; s++){
    // ---- X ----
    state.pos.x += part.x;
    for (const c of hits(colliders, aabb(state.pos, state.height, PLAYER.width, SKIN))){
      // Попытка шагнуть на невысокое препятствие, а не упереться в него:
      // так рельсы, шпалы и ступени не останавливают бег.
      const stepUp = c.box.max.y - state.pos.y;
      if (stepUp > 0 && stepUp <= PLAYER.maxStep && canStand(state, colliders, state.pos.y + stepUp)){
        state.pos.y += stepUp;
        continue;
      }
      state.pos.x -= part.x;
      state.vel.x = 0;
      break;
    }

    // ---- Z ----
    state.pos.z += part.z;
    for (const c of hits(colliders, aabb(state.pos, state.height, PLAYER.width, SKIN))){
      const stepUp = c.box.max.y - state.pos.y;
      if (stepUp > 0 && stepUp <= PLAYER.maxStep && canStand(state, colliders, state.pos.y + stepUp)){
        state.pos.y += stepUp;
        continue;
      }
      state.pos.z -= part.z;
      state.vel.z = 0;
      break;
    }

    // ---- Y ----
    // Здесь зазор НЕ нужен: пол обязан остановить падение.
    state.pos.y += part.y;
    for (const c of hits(colliders, aabb(state.pos, state.height, PLAYER.width))){
      if (part.y <= 0){
        state.pos.y = c.box.max.y;     // встали на крышу коробки
        grounded = true;
      } else {
        state.pos.y = c.box.min.y - state.height;   // ударились головой
      }
      state.vel.y = 0;
      break;
    }
  }

  // Провалиться под карту нельзя ни при каких обстоятельствах.
  if (state.pos.y < -40){
    state.pos.y = -40;
    state.vel.set(0, 0, 0);
    state.fell = true;
  }

  return { grounded };
}

/** Влезет ли игрок, если поставить его ноги на высоту y. */
function canStand(state, colliders, y){
  const probe = aabb(new THREE.Vector3(state.pos.x, y, state.pos.z), state.height, PLAYER.width, SKIN);
  return hits(colliders, probe).length === 0;
}

/** Есть ли опора прямо под ногами (для прыжка и для звука шагов). */
export function onGround(state, colliders){
  // Щупаем тонким слоем ПОД ногами, а не всей коробкой: полная коробка всегда
  // задевала бы стену, вдоль которой человек стоит, и он считался бы стоящим
  // на земле, вися в воздухе у отвесного обрыва.
  const h = PLAYER.width / 2;
  const probe = new THREE.Box3(
    new THREE.Vector3(state.pos.x - h, state.pos.y - 0.12, state.pos.z - h),
    new THREE.Vector3(state.pos.x + h, state.pos.y + 0.02, state.pos.z + h)
  );
  return hits(colliders, probe).length > 0;
}

/**
 * Луч выстрела. Возвращает ближайшее попадание: в игрока или в стену.
 * Стёкла (bulletPass) пуля проходит насквозь — на это и расчёт диспетчерской
 * в «Карьере»: видно оттуда всех, но и укрытием она не является.
 */
export function raycast(origin, dir, colliders, targets, maxDistance = 220){
  const ray = new THREE.Ray(origin, dir);
  let best = { distance: maxDistance, target: null, point: null };
  const point = new THREE.Vector3();

  for (const c of colliders){
    if (c.bulletPass) continue;
    if (ray.intersectBox(c.box, point)){
      const d = origin.distanceTo(point);
      if (d < best.distance) best = { distance: d, target: null, point: point.clone() };
    }
  }

  for (const t of targets){
    if (!t.box) continue;
    if (ray.intersectBox(t.box, point)){
      const d = origin.distanceTo(point);
      if (d < best.distance) best = { distance: d, target: t, point: point.clone() };
    }
  }

  return best.target || best.point ? best : null;
}

// soldier.js — фигура бойца: как он выглядит и как двигается.
//
// Раньше чужой игрок был тремя коробками, а «оружие» — отдельным бруском,
// висевшим сбоку от туловища. Выглядело это так, будто человек стоит с
// вытянутой рукой. Здесь фигура собрана по-настоящему: скелетом из вложенных
// групп, у каждой части свой сустав.
//
//   soldier
//   └ hips ─────────── таз, вокруг него поворачивается всё тело
//     ├ legL / legR ── бедро → голень → стопа, шагают при ходьбе
//     └ chest ──────── корпус; ОН наклоняется по прицелу, а не вся фигура
//       ├ neck → head  голова с каской, довернута отдельно
//       └ aim ──────── плечи, обе руки и ствол в них
//         ├ gunMount ─ ствол; его место задаётся ПЕРВЫМ
//         ├ armR ───── правая: кисть каждый кадр подводится к рукояти
//         └ armL ───── левая: кисть подводится к цевью
//
// Два решения делают всю разницу.
//
// Первое: оружие висит в ТОЙ ЖЕ группе, что и руки. Поэтому человек не «стоит
// рядом с ружьём»: куда поворачивается корпус, туда едут и руки, и ствол, и
// разъехаться они не могут.
//
// Второе: кисти не расставлены на глаз, а КАЖДЫЙ КАДР решаются обратной
// кинематикой под фактическое положение ствола (см. reachTo). Из-за этого при
// отдаче, при смене оружия и при любом наклоне руки остаются на оружии — а
// именно рассинхрон рук и ствола сразу читается как «картонный манекен».
//
// Всё это по-прежнему коробки, без единой загруженной модели: они грузятся
// мгновенно, весят ноль и совпадают по стилю с картами, сложенными из таких же
// коробок. Реалистичность тут берётся не из числа полигонов, а из пропорций,
// суставов и того, что фигура двигается как человек, а не как манекен.
//
// Пропорции взяты от роста 1.75 (PLAYER.height): подошва на y = 0, макушка с
// каской около 1.77, глаза около 1.60 — там же, где камера от первого лица.
// Если менять размеры, менять их надо согласованно, иначе чужой боец окажется
// выше или ниже, чем в него стреляют.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

const TEAM = {
  a:    { cloth: 0x8a6a3a, vest: 0x5e4728, trim: 0xe8a317 },
  b:    { cloth: 0x3f5670, vest: 0x2c3d50, trim: 0x5aa0d2 },
  free: { cloth: 0x6b6355, vest: 0x4a443a, trim: 0xc9b896 }
};

const SKIN  = 0xb98d68;
const BOOT  = 0x24262a;
const GLOVE = 0x3a3128;
const METAL = 0x3c4146;
const WOOD  = 0x6b4a2c;
const GLASS = 0x1b2026;

const mat = (color, rough = 0.85, metal = 0.05) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

/** Коробка с началом координат в заданной точке — так удобнее вешать на сустав. */
function part(parent, w, h, d, material, x = 0, y = 0, z = 0){
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Сустав: пустая группа, вокруг которой вращается всё, что ниже. */
function joint(parent, x, y, z){
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Оружие в руках бойца. Формы повторяют вид от первого лица, чтобы по силуэту
 * издали было понятно, с чем на тебя идут: у дробовика толстый короткий ствол,
 * у винтовки длинный с прицелом, у пулемёта коробка магазина снизу.
 *
 * Возвращает вместе с моделью две точки хвата — за них потом цепляются кисти.
 * Точки считаются из размеров ствола, а не вбиваются числом: иначе при смене
 * оружия руки остались бы там, где были у прошлого.
 */
function buildGun(parent, weaponId){
  const g = new THREE.Group();
  const metal = mat(METAL, 0.5, 0.6);
  const wood  = mat(WOOD, 0.85);
  const dark  = mat(0x2a2e33, 0.75);

  const shapes = {
    rifle:   { body: [0.07, 0.09, 0.42], barrel: [0.035, 0.035, 0.3],  stock: true,  mag: [0.05, 0.16, 0.07], sight: true },
    smg:     { body: [0.07, 0.09, 0.26], barrel: [0.03,  0.03,  0.14], stock: false, mag: [0.05, 0.2,  0.06], sight: false },
    shotgun: { body: [0.09, 0.1,  0.4],  barrel: [0.055, 0.055, 0.34], stock: true,  mag: null,               sight: false },
    sniper:  { body: [0.07, 0.09, 0.5],  barrel: [0.03,  0.03,  0.44], stock: true,  mag: [0.045, 0.1, 0.06], sight: true },
    lmg:     { body: [0.09, 0.12, 0.46], barrel: [0.04,  0.04,  0.38], stock: true,  mag: [0.12, 0.18, 0.16], sight: false }
  };
  const s = shapes[weaponId] || shapes.rifle;
  const halfL = s.body[2] / 2;
  const halfH = s.body[1] / 2;

  part(g, ...s.body, metal, 0, 0, 0);
  part(g, ...s.barrel, metal, 0, 0.01, -(halfL + s.barrel[2] / 2));
  if (s.stock) part(g, 0.06, 0.08, 0.18, wood, 0, -0.01, halfL + 0.08);
  if (s.mag)   part(g, ...s.mag, metal, 0, -(halfH + s.mag[1] / 2 - 0.02), 0.02);
  if (s.sight) part(g, 0.03, 0.04, 0.12, metal, 0, halfH + 0.03, -0.02);

  // Пистолетная рукоять — её видно, и за неё же держится правая кисть.
  const gripZ = halfL - 0.07;
  part(g, 0.05, 0.13, 0.07, dark, 0, -(halfH + 0.05), gripZ + 0.015);

  // Цевьё. Где оно — не вопрос вкуса: левая кисть должна ДОСТАВАТЬ до него, а
  // размах рук у фигуры конечный. Поэтому расстояние между хватами закреплено
  // (GRIP_SPAN) и лишь ограничено длиной самого ствола: у длинной винтовки рука
  // ложится на цевьё, у короткого ПП — ближе к дулу, но ни у того, ни у другого
  // она не улетает туда, куда рука физически не дотянется. Именно из-за такого
  // перелёта боец и стоял раньше «с вытянутой рукой» мимо оружия.
  const GRIP_SPAN = 0.27;
  const foreZ = Math.max(gripZ - GRIP_SPAN, -(halfL + s.barrel[2] * 0.75));
  const foreY = -(halfH + 0.045);
  part(g, 0.055, 0.06, 0.16, wood, 0, foreY + 0.02, foreZ);

  parent.add(g);
  return {
    group: g,
    rear:  new THREE.Vector3(0, -(halfH + 0.065), gripZ),
    front: new THREE.Vector3(0, foreY - 0.015, foreZ)
  };
}

/**
 * Поставить руку так, чтобы КИСТЬ ОКАЗАЛАСЬ В ЗАДАННОЙ ТОЧКЕ.
 *
 * Это обратная кинематика для двух костей, и без неё ничего не выходит. Если
 * подбирать углы плеча и локтя на глаз — а именно так и было сделано в первой
 * версии, — кисти оказываются где угодно, только не на оружии, и боец идёт с
 * ружьём, висящим отдельно от рук. Здесь наоборот: сначала решаем, где держать
 * ствол, а углы считаются под это.
 *
 * Треугольник со сторонами L1 (плечо), L2 (предплечье) и D (от плеча до кисти)
 * задан однозначно — теорема косинусов даёт угол при плече. Но сам треугольник
 * ещё можно крутить вокруг прямой «плечо → кисть», и от этого зависит, куда
 * торчит локоть. Вот это и решает pole: подсказка, в какую сторону его увести.
 * Без неё локоть встаёт в случайное положение, и рука читается как приваренный
 * сбоку брусок — ровно та беда, из-за которой фигуру и переделывали.
 *
 * Плечо разворачиваем не к кисти, а к ВЫЧИСЛЕННОМУ локтю; предплечье потом —
 * от локтя к кисти. Так обе кости лежат в одной плоскости и сустав не выгибает.
 */
function reachTo(shoulder, elbow, L1, L2, target, pole){
  const D = Math.min(target.length(), (L1 + L2) * 0.999);
  if (D < 1e-4) return;

  const dir = target.clone().divideScalar(target.length() || 1);
  const cosA = (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D);
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));

  // Убрать из подсказки составляющую вдоль dir — останется чистое «куда вбок».
  const side = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (side.lengthSq() < 1e-6) side.set(dir.y, -dir.x, 0);      // вырожденный случай
  side.normalize();

  const elbowPos = dir.clone().multiplyScalar(L1 * Math.cos(a))
                      .addScaledVector(side, L1 * Math.sin(a));

  const q1 = new THREE.Quaternion().setFromUnitVectors(DOWN, elbowPos.clone().normalize());
  shoulder.quaternion.copy(q1);

  const fore = target.clone().sub(elbowPos).normalize().applyQuaternion(q1.clone().invert());
  elbow.quaternion.setFromUnitVectors(DOWN, fore);
}

const UPPER = 0.28;   // плечо
const FORE  = 0.26;   // предплечье
const WRIST = 0.05;   // от запястья до середины кисти — её и ставим на оружие

export class Soldier {
  constructor(team = "free", weaponId = "rifle"){
    const c = TEAM[team] || TEAM.free;
    const cloth = mat(c.cloth);
    const vest  = mat(c.vest, 0.7);
    const trim  = mat(c.trim, 0.6, 0.2);
    const skin  = mat(SKIN, 0.9);
    const boot  = mat(BOOT, 0.7);
    const glove = mat(GLOVE, 0.8);
    const glass = mat(GLASS, 0.25, 0.5);

    this.root = new THREE.Group();

    // ---- ноги ---------------------------------------------------------------
    // Подошва на y = 0: бедро 0.39, голень 0.37, ботинок 0.09 — от таза на 0.85
    // ровно до земли. Стопа на своём суставе, иначе на шаге носок уходит в грунт.
    this.hips = joint(this.root, 0, 0.95, 0);
    part(this.hips, 0.38, 0.22, 0.25, cloth, 0, -0.08, 0);
    part(this.hips, 0.4, 0.07, 0.27, vest, 0, 0.02, 0);          // ремень

    this.legs = [];
    for (const side of [-1, 1]){
      const hip = joint(this.hips, 0.115 * side, -0.10, 0);
      part(hip, 0.17, 0.39, 0.2, cloth, 0, -0.195, 0);
      const knee = joint(hip, 0, -0.39, 0);
      part(knee, 0.145, 0.37, 0.17, cloth, 0, -0.185, 0);
      part(knee, 0.155, 0.1, 0.18, vest, 0, -0.03, -0.015);       // наколенник
      const ankle = joint(knee, 0, -0.37, 0);
      part(ankle, 0.16, 0.09, 0.26, boot, 0, -0.045, 0.035);
      this.legs.push({ hip, knee, ankle });
    }

    // ---- корпус -------------------------------------------------------------
    // Наклоняется отдельно от ног: человек целится вверх грудью, а не всем
    // телом вместе со ступнями.
    this.chest = joint(this.hips, 0, 0.05, 0);
    part(this.chest, 0.42, 0.46, 0.25, cloth, 0, 0.22, 0);
    part(this.chest, 0.44, 0.26, 0.28, vest, 0, 0.28, 0);        // разгрузка
    part(this.chest, 0.1, 0.12, 0.05, vest, -0.11, 0.24, -0.15); // подсумок
    part(this.chest, 0.1, 0.12, 0.05, vest,  0.11, 0.24, -0.15); // второй
    part(this.chest, 0.26, 0.2, 0.12, vest, 0, 0.26, 0.17);      // ранец за спиной
    part(this.chest, 0.05, 0.28, 0.04, trim, -0.12, 0.31, -0.13); // лямка, цвет отряда
    part(this.chest, 0.05, 0.28, 0.04, trim,  0.12, 0.31, -0.13);
    part(this.chest, 0.44, 0.1, 0.24, cloth, 0, 0.41, 0);         // плечевой пояс

    // ---- голова -------------------------------------------------------------
    // Шея должна быть ВИДНА: голова, севшая прямо на плечи, — первое, что
    // выдаёт коробочную фигуру. Поэтому пояс кончается на 1.46, шея идёт до
    // 1.55, и только там начинается подбородок.
    part(this.chest, 0.12, 0.1, 0.12, skin, 0, 0.5, 0);           // шея
    this.head = joint(this.chest, 0, 0.545, 0);
    part(this.head, 0.17, 0.2, 0.18, skin, 0, 0.1, 0);
    part(this.head, 0.175, 0.045, 0.03, glass, 0, 0.125, -0.093); // очки
    part(this.head, 0.2, 0.085, 0.21, vest, 0, 0.225, 0);         // каска
    part(this.head, 0.205, 0.028, 0.215, trim, 0, 0.183, 0);      // цветной ободок
    part(this.head, 0.17, 0.026, 0.07, vest, 0, 0.187, -0.125);   // козырёк

    // ---- руки и оружие ------------------------------------------------------
    // Порядок важен: СНАЧАЛА решаем, где держать ствол, и только потом
    // подводим к нему кисти. Наоборот не работает — см. reachTo() выше.
    this.aim = joint(this.chest, 0, 0.40, 0);

    this.gunMount = joint(this.aim, 0.06, -0.02, -0.30);
    const built = buildGun(this.gunMount, weaponId);
    this.gun = built.group;
    this.grip = { rear: built.rear, front: built.front };
    this.weaponId = weaponId;

    // Плечи чуть впереди оси корпуса: так руки не растут из спины.
    // pole — куда уводить локоть. У правой (на рукояти) он идёт назад и в
    // сторону, у левой (на цевье) — вниз и слегка внутрь: так стоит человек с
    // оружием, и так не выворачивает суставы.
    this.arms = [];
    const sides = [
      { x:  0.215, pole: new THREE.Vector3( 0.8, -0.8,  0.55) },   // правая, рукоять
      { x: -0.215, pole: new THREE.Vector3(-0.4, -1.0,  0.1)  }    // левая, цевьё
    ];
    for (const s of sides){
      // Наплечник висит на корпусе, а НЕ на суставе руки: локоть при хвате
      // уходит градусов на семьдесят, и уехавшая вместе с ним «нашивка»
      // превращалась бы в летящий сбоку кубик.
      part(this.aim, 0.14, 0.13, 0.15, vest, s.x, -0.015, -0.02);

      const shoulder = joint(this.aim, s.x, -0.03, -0.02);
      part(shoulder, 0.11, UPPER - 0.03, 0.115, cloth, 0, -UPPER / 2 - 0.01, 0);
      const elbow = joint(shoulder, 0, -UPPER, 0);
      part(elbow, 0.095, FORE - 0.02, 0.095, cloth, 0, -FORE / 2, 0);
      part(elbow, 0.08, 0.085, 0.09, glove, 0, -FORE - 0.035, 0);  // кисть
      this.arms.push({ shoulder, elbow, pole: s.pole, origin: new THREE.Vector3(s.x, -0.03, -0.02) });
    }

    this.walk = 0;
    this.recoil = 0;
    this.breath = Math.random() * Math.PI * 2;   // чтобы отряд не дышал в такт
    this.fall = Math.random() < 0.5 ? -1 : 1;    // в какую сторону падать
    this._tmp = new THREE.Vector3();
    this._solveHands();
  }

  /** Сменить ствол в руках, когда человек переключился. */
  setWeapon(weaponId){
    if (weaponId === this.weaponId || !weaponId) return;
    this.weaponId = weaponId;
    this.gunMount.remove(this.gun);
    this.gun.traverse(n => { n.geometry?.dispose?.(); n.material?.dispose?.(); });
    const built = buildGun(this.gunMount, weaponId);
    this.gun = built.group;
    this.grip = { rear: built.rear, front: built.front };
    this._solveHands();
  }

  /** Отдача: ствол дёргается вверх-назад. Видно, что человек стреляет. */
  kick(){ this.recoil = 1; }

  /**
   * Подвести обе кисти к фактическим точкам хвата.
   *
   * Точки заданы в системе ствола, а руки растут из плеч — значит, надо
   * перегнать их в систему aim (общую для ствола и плеч) через матрицу
   * gunMount. Делается это каждый кадр именно потому, что gunMount за кадр
   * успевает сместиться: отдача, смена оружия, покачивание на бегу.
   */
  _solveHands(){
    this.gunMount.updateMatrix();
    const targets = [this.grip.rear, this.grip.front];
    for (let i = 0; i < this.arms.length; i++){
      const arm = this.arms[i];
      const t = this._tmp.copy(targets[i]).applyMatrix4(this.gunMount.matrix).sub(arm.origin);
      reachTo(arm.shoulder, arm.elbow, UPPER, FORE + WRIST, t, arm.pole);
    }
  }

  /**
   * @param dt     секунд с прошлого кадра
   * @param speed  скорость по земле, м/с — от неё зависит походка
   * @param pitch  куда смотрит, в радианах (вверх положительный)
   * @param dead   лежит ли
   */
  update(dt, speed, pitch, dead){
    if (dead){
      // Смерть: заваливаемся набок, поворачиваясь вокруг ступней — как падает
      // человек, а не как проваливается модель. Опускать при этом ещё и всю
      // фигуру нельзя: лежащий боец и так уже на земле, лишние полметра вниз
      // просто прячут тело под грунт, и труп исчезает.
      const goal = (Math.PI / 2) * this.fall;
      this.root.rotation.z += (goal - this.root.rotation.z) * Math.min(1, dt * 6);
      this.root.position.y = Math.max(-0.05, this.root.position.y - dt * 0.4);
      // Тело обмякает: колени и спина подгибаются, голова падает.
      this.chest.rotation.x += (-0.3 - this.chest.rotation.x) * Math.min(1, dt * 4);
      this.head.rotation.x += (-0.45 - this.head.rotation.x) * Math.min(1, dt * 4);
      this.aim.rotation.x += (-0.5 - this.aim.rotation.x) * Math.min(1, dt * 3);
      for (const leg of this.legs){
        leg.hip.rotation.x += (-0.25 - leg.hip.rotation.x) * Math.min(1, dt * 4);
        leg.knee.rotation.x += (-0.55 - leg.knee.rotation.x) * Math.min(1, dt * 4);
      }
      this._solveHands();
      return;
    }
    this.root.rotation.z = 0;
    this.root.position.y = 0;

    // ---- походка ------------------------------------------------------------
    // Частота растёт со скоростью, размах — тоже, но с потолком: иначе на бегу
    // боец начинает делать шпагат.
    const moving = speed > 0.6;
    this.walk += dt * (moving ? 2.2 + speed * 0.95 : 0);
    const swing = moving ? Math.min(0.85, speed * 0.1) : 0;
    const ease = moving ? 1 : Math.max(0, 1 - dt * 8);

    const a = Math.sin(this.walk);
    const b = Math.sin(this.walk + Math.PI);

    this.legs[0].hip.rotation.x = a * swing * ease;
    this.legs[1].hip.rotation.x = b * swing * ease;
    // Колено гнётся только когда нога идёт назад — вперёд оно так не гнётся.
    this.legs[0].knee.rotation.x = -Math.max(0, -a) * swing * 1.4 * ease;
    this.legs[1].knee.rotation.x = -Math.max(0, -b) * swing * 1.4 * ease;
    // Стопа догоняет голень, чтобы подошва не втыкалась носком в землю.
    for (let i = 0; i < 2; i++){
      const leg = this.legs[i];
      leg.ankle.rotation.x = -(leg.hip.rotation.x + leg.knee.rotation.x) * 0.55;
    }

    // Корпус чуть покачивается в такт шагам, тело слегка приседает и наклоняется
    // вперёд на бегу — стоящий прямо спринтер выглядит неживым.
    this.breath += dt * 1.6;
    const idle = Math.sin(this.breath) * 0.012 * (1 - swing);
    this.hips.position.y = 0.95 - Math.abs(a) * 0.035 * swing * ease + idle;
    this.chest.rotation.z = a * 0.045 * swing * ease;
    this.hips.rotation.y = b * 0.06 * swing * ease;        // таз доворачивается за шагом

    // ---- прицел -------------------------------------------------------------
    // Корпус наклоняется на треть, руки — на остальное: так человек, целящийся
    // в небо, не превращается в запрокинутую доску.
    // Знак здесь не косметика: pitch у нас как у камеры — вверх положительный
    // (controls.pitch, main.js). Перепутанный знак даёт бойца, который целится
    // в землю, когда стреляет по крыше, и попадания «из ниоткуда».
    const look = Math.max(-1.2, Math.min(1.2, pitch));
    const lean = look * 0.33 - swing * ease * 0.12;   // на бегу корпус вперёд
    this.chest.rotation.x += (lean - this.chest.rotation.x) * Math.min(1, dt * 10);
    this.aim.rotation.x += (look * 0.7 - this.aim.rotation.x) * Math.min(1, dt * 14);
    this.aim.rotation.z = -a * 0.05 * swing * ease + idle * 1.5;
    this.head.rotation.x += (look * 0.25 - this.head.rotation.x) * Math.min(1, dt * 12);

    // ---- отдача -------------------------------------------------------------
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.gunMount.rotation.x = this.recoil * 0.28;
    this.gunMount.position.z = -0.30 + this.recoil * 0.05;

    // Руки — последними: они цепляются за ствол там, где он оказался ИМЕННО
    // сейчас, уже с отдачей и покачиванием.
    this._solveHands();
  }

  dispose(){
    this.root.traverse(node => {
      node.geometry?.dispose?.();
      if (node.material?.map) node.material.map.dispose();
      node.material?.dispose?.();
    });
  }
}

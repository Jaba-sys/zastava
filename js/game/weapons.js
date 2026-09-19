// weapons.js — оружие: характеристики, цены, отдача, перезарядка, урон.
//
// Стрельба — лучом, а не летящей пулей: на дистанциях этих карт разница
// незаметна, а расхождений между тем, что видит стрелок, и тем, что видит
// цель, на порядок меньше. Урон считает СТРЕЛЯЮЩИЙ и сообщает жертве. Это
// доверие к клиенту, и оно осознанное: без своего сервера проверить выстрел
// негде. Что из этого следует — написано в README, в разделе про доверие.
//
// Цены и баланс. Пять стволов подобраны так, чтобы ни один не был «лучше
// всех»: у каждого есть дистанция, на которой он выигрывает, и дистанция, на
// которой проигрывает. Дорогой пулемёт не сильнее автомата в прямой
// перестрелке — он просто дольше не требует перезарядки. Иначе покупка
// превращается в «кто дольше играл, тот и побеждает», а это скучно.

export const WEAPONS = {
  rifle: {
    id: "rifle",
    name: "Автомат",
    short: "АК",           // для полосы слотов: там места мало
    about: "Ровный середняк: годится везде, нигде не лучший",
    price: 0,                // выдаётся сразу, его нельзя не иметь
    damage: 24,
    rpm: 620,                // выстрелов в минуту
    magazine: 30,
    reload: 2.1,
    spread: 0.011,           // разброс в покое, радианы
    spreadMoving: 0.035,
    recoil: 0.009,
    falloffStart: 45,        // с какой дистанции урон начинает падать
    falloffEnd: 120,
    falloffMin: 0.55,
    pellets: 1,
    zoom: 1.35               // во сколько раз приближает прицеливание
  },

  smg: {
    id: "smg",
    name: "Пистолет-пулемёт",
    short: "ПП",           // для полосы слотов: там места мало
    about: "Очень скорострельный, но дальше двадцати метров бесполезен",
    price: 250,
    damage: 15,
    rpm: 950,
    magazine: 32,
    reload: 1.7,
    spread: 0.022,
    spreadMoving: 0.05,
    recoil: 0.006,
    falloffStart: 18,
    falloffEnd: 55,
    falloffMin: 0.32,
    pellets: 1,
    zoom: 1.25
  },

  shotgun: {
    id: "shotgun",
    name: "Дробовик",
    short: "Дробовик",           // для полосы слотов: там места мало
    about: "Вплотную убивает с одного выстрела, дальше — щекочет",
    price: 400,
    damage: 13,              // на дробину; вплотную все восемь — это 104
    rpm: 78,
    magazine: 6,
    reload: 3.0,
    spread: 0.055,
    spreadMoving: 0.075,
    recoil: 0.035,
    falloffStart: 9,
    falloffEnd: 30,
    falloffMin: 0.12,
    pellets: 8,
    zoom: 1.15
  },

  sniper: {
    id: "sniper",
    name: "Винтовка",
    short: "Винтовка",           // для полосы слотов: там места мало
    about: "Два попадания — и готово, но между выстрелами целая секунда",
    price: 750,
    damage: 58,
    rpm: 45,
    magazine: 5,
    reload: 3.4,
    spread: 0.0016,          // почти точно — но только стоя на месте
    spreadMoving: 0.06,      // на бегу стрелять бессмысленно
    recoil: 0.05,
    falloffStart: 130,
    falloffEnd: 240,
    falloffMin: 0.85,
    pellets: 1,
    zoom: 3.4                // единственный ствол с настоящим прицелом
  },

  lmg: {
    id: "lmg",
    name: "Пулемёт",
    short: "Пулемёт",           // для полосы слотов: там места мало
    about: "Сто патронов подряд; перезарядка — пять секунд беспомощности",
    price: 1100,
    damage: 20,
    rpm: 700,
    magazine: 100,
    reload: 5.2,
    spread: 0.03,
    spreadMoving: 0.075,
    recoil: 0.012,
    falloffStart: 35,
    falloffEnd: 110,
    falloffMin: 0.5,
    pellets: 1,
    zoom: 1.2
  }
};

// Порядок в оружейной: от бесплатного к дорогому.
export const WEAPON_ORDER = ["rifle", "smg", "shotgun", "sniper", "lmg"];

// Что есть у игрока с самого начала и с чем он идёт в бой, пока ничего не
// выбрал. Автомат бесплатный, поэтому второго слота поначалу просто нет.
export const STARTER_OWNED = ["rifle"];
export const DEFAULT_LOADOUT = ["rifle"];

export const LOADOUT_SLOTS = 2;

export function weaponById(id){
  return WEAPONS[id] || WEAPONS.rifle;
}

/** Сколько монет за убийство этим стволом. Дорогой ствол не кормит лучше. */
export const COINS_PER_KILL = 12;
export const COINS_PER_MATCH = 25;   // просто за то, что доиграл до конца

// ---------------------------------------------------------------------------
// Состояние оружия в бою
// ---------------------------------------------------------------------------

export class Arsenal {
  /** ids — набор, выбранный в лобби; пустой или кривой заменяется автоматом. */
  constructor(ids){
    const clean = (Array.isArray(ids) ? ids : [])
      .filter(id => WEAPONS[id])
      .slice(0, LOADOUT_SLOTS);
    this.order = clean.length ? clean : ["rifle"];

    this.index = 0;
    this.ammo = {};
    for (const id of this.order) this.ammo[id] = WEAPONS[id].magazine;

    this.reloadingUntil = 0;
    this.nextShotAt = 0;
  }

  get current(){ return WEAPONS[this.order[this.index]]; }
  get inMagazine(){ return this.ammo[this.current.id]; }
  get reloading(){ return performance.now() / 1000 < this.reloadingUntil; }

  select(index){
    if (index < 0 || index >= this.order.length || index === this.index) return false;
    this.index = index;
    this.reloadingUntil = 0;              // смена оружия отменяет перезарядку
    this.nextShotAt = performance.now() / 1000 + 0.25;
    return true;
  }

  next(){ return this.select((this.index + 1) % this.order.length); }

  startReload(){
    const w = this.current;
    if (this.reloading || this.ammo[w.id] >= w.magazine) return false;
    this.reloadingUntil = performance.now() / 1000 + w.reload;
    return true;
  }

  /** Успела ли закончиться перезарядка — вызывать каждый кадр. */
  tick(){
    if (this.reloadingUntil && performance.now() / 1000 >= this.reloadingUntil){
      const w = this.current;
      this.ammo[w.id] = w.magazine;
      this.reloadingUntil = 0;
      return true;                        // чтобы щёлкнуть затвором
    }
    return false;
  }

  /**
   * Можно ли стрелять прямо сейчас. Если магазин пуст — сама ставит
   * перезарядку: человеку не надо помнить про R, когда уже поздно.
   */
  canFire(){
    const now = performance.now() / 1000;
    if (this.reloading || now < this.nextShotAt) return false;
    if (this.inMagazine <= 0){ this.startReload(); return false; }
    return true;
  }

  consume(){
    const w = this.current;
    this.ammo[w.id]--;
    this.nextShotAt = performance.now() / 1000 + 60 / w.rpm;
  }
}

/** Урон с учётом падения на дистанции. */
export function damageAt(weapon, distance){
  if (distance <= weapon.falloffStart) return weapon.damage;
  if (distance >= weapon.falloffEnd)   return weapon.damage * weapon.falloffMin;
  const t = (distance - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart);
  return weapon.damage * (1 - t * (1 - weapon.falloffMin));
}

/** Случайное отклонение внутри конуса разброса. */
export function scatter(dir, spread, THREE){
  if (spread <= 0) return dir;
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * spread;
  const up = Math.abs(dir.y) > 0.95
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
  return dir.clone()
    .addScaledVector(right,  Math.cos(angle) * radius)
    .addScaledVector(realUp, Math.sin(angle) * radius)
    .normalize();
}

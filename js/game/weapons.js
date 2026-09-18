// weapons.js — оружие, отдача, перезарядка, урон.
//
// Стрельба — лучом, а не летящей пулей: на дистанциях этих карт разница
// незаметна, а расхождений между тем, что видит стрелок, и тем, что видит
// цель, на порядок меньше. Урон считает СТРЕЛЯЮЩИЙ и сообщает жертве. Это
// доверие к клиенту, и оно осознанное: без своего сервера проверить выстрел
// негде, а серверов у нас нет. Что из этого следует для честности игры —
// написано в README, в разделе про доверие.

export const WEAPONS = {
  rifle: {
    id: "rifle",
    name: "Автомат",
    damage: 24,
    rpm: 620,               // выстрелов в минуту
    magazine: 30,
    reload: 2.1,
    spread: 0.011,          // разброс в покое, радианы
    spreadMoving: 0.035,
    recoil: 0.009,
    falloffStart: 45,       // с какой дистанции урон начинает падать
    falloffEnd: 120,
    falloffMin: 0.55,
    pellets: 1
  },
  shotgun: {
    id: "shotgun",
    name: "Дробовик",
    damage: 13,             // на дробину; вплотную все восемь — это 104
    rpm: 78,
    magazine: 6,
    reload: 3.0,
    spread: 0.055,
    spreadMoving: 0.075,
    recoil: 0.035,
    falloffStart: 9,
    falloffEnd: 30,
    falloffMin: 0.12,
    pellets: 8
  }
};

export class Arsenal {
  constructor(){
    this.order = ["rifle", "shotgun"];
    this.index = 0;
    this.ammo = { rifle: WEAPONS.rifle.magazine, shotgun: WEAPONS.shotgun.magazine };
    this.reloadingUntil = 0;
    this.nextShotAt = 0;
  }

  get current(){ return WEAPONS[this.order[this.index]]; }
  get inMagazine(){ return this.ammo[this.current.id]; }
  get reloading(){ return performance.now() / 1000 < this.reloadingUntil; }

  select(index){
    if (index < 0 || index >= this.order.length || index === this.index) return;
    this.index = index;
    this.reloadingUntil = 0;              // смена оружия отменяет перезарядку
    this.nextShotAt = performance.now() / 1000 + 0.25;
  }

  next(){ this.select((this.index + 1) % this.order.length); }

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
    }
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

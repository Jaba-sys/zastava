// bomb.js — бомба, точки закладки и то, что вокруг них происходит.
//
// Весь режим держится на одном: у сторон РАЗНЫЕ задачи, и потому они ведут
// себя по-разному. Террористы должны дойти до точки и потратить три секунды
// стоя на месте — то есть в какой-то момент обязаны перестать стрелять и стать
// мишенью. Спецназ должен угадать, на какую из двух точек идут, и успеть.
// Отсюда и напряжение, которого нет в перестрелке «до сорока убийств».
//
// Где что живёт:
//
//   meta.round, meta.scoreA/B  — счёт МАТЧА (выигранные раунды), общий для всех
//   rooms/{id}/bomb            — состояние бомбы прямо сейчас
//
// Состояние бомбы — в базе, а не у каждого в голове, потому что на него
// смотрят все сразу и спорить тут нельзя: заложена или нет, на какой точке, и
// когда рванёт. Закладывает и разминирует КЛИЕНТ и он же пишет в базу — как и
// с уроном, проверить это без своего сервера негде (см. README).

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
import { BOMB } from "./modes.js";

export const BOMB_STATE = {
  CARRIED: "carried",     // у террористов на руках
  PLANTED: "planted",     // лежит и тикает
  DEFUSED: "defused",
  EXPLODED: "exploded"
};

/**
 * Зона закладки: видимая площадка с буквой.
 *
 * Буква нарисована прямо на земле, а не висит значком над точкой: значок надо
 * искать глазами по экрану, а надпись под ногами видно тогда, когда ты уже
 * пришёл, — то есть ровно когда она нужна.
 */
export function buildSite(site, letter){
  const group = new THREE.Group();
  const color = 0xe8a317;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(BOMB.siteRadius - 0.35, BOMB.siteRadius, 44),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(site[0], site[1] + 0.06, site[2]);
  group.add(ring);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(232,163,23,0.92)";
  ctx.font = "700 104px 'Oswald', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, opacity: 0.75, depthWrite: false
    })
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(site[0], site[1] + 0.07, site[2]);
  group.add(plate);

  // Столбик с буквой — чтобы точку было видно издали, а не только под ногами.
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 2.4, 0.18),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 })
  );
  post.position.set(site[0], site[1] + 1.2, site[2]);
  group.add(post);

  // Та же буква ещё раз, но СТОЯ — табличкой на столбике.
  //
  // Буква под ногами хороша ровно тогда, когда ты уже пришёл: с высоты глаз
  // она лежит почти в плоскости взгляда и сжимается в полоску. Проверено
  // снимками со стенда — сверху «A» читается прекрасно, а с роста человека её
  // не видно вовсе. А знать, на какую точку бежишь, надо ИЗДАЛЕКА.
  //
  // Табличка — Sprite, а не плоскость: спрайт всегда повёрнут к камере, и
  // разворачивает его сам рендер, без единой строчки в цикле кадра. Две
  // скрещенные плоскости, которые тут стояли сначала, с угла накладывались
  // друг на друга и превращали «A» в кляксу.
  const sign = new THREE.Sprite(new THREE.SpriteMaterial({
    map: signTexture(letter, color), transparent: true, depthWrite: false
  }));
  // Табличка стоит НАД столбиком, а не на нём: пока она висела на середине,
  // столбик проходил ровно сквозь перекладину «A», и буква читалась стрелкой.
  sign.position.set(site[0], site[1] + 3.15, site[2]);
  sign.scale.set(1.4, 1.4, 1);
  group.add(sign);

  return group;
}

/**
 * Табличка с буквой: тёмный квадрат с рамкой и буква поверх.
 *
 * Именно подложка и делает её читаемой. Одна буква без фона тонет и в светлом
 * небе «Карьера», и в ночном «Депо» — а тёмный квадрат с оранжевой каймой
 * читается на любом фоне, потому что несёт контраст с собой.
 */
function signTexture(letter, color){
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const hex = "#" + color.toString(16).padStart(6, "0");

  ctx.fillStyle = "rgba(16,18,20,0.82)";
  ctx.fillRect(10, 10, 108, 108);
  ctx.strokeStyle = hex;
  ctx.lineWidth = 7;
  ctx.strokeRect(10, 10, 108, 108);

  ctx.fillStyle = hex;
  ctx.font = "700 82px 'Oswald', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, 64, 68);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Сама бомба: ящик с мигающим огоньком. */
export function buildBomb(){
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.22, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.7, metalness: 0.35 })
  );
  body.position.y = 0.11;
  body.castShadow = true;
  group.add(body);

  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.05, 0.07),
    new THREE.MeshBasicMaterial({ color: 0xff3b2f })
  );
  lamp.position.set(0.12, 0.24, 0);
  group.add(lamp);

  const glow = new THREE.PointLight(0xff3b2f, 0, 6, 2);
  glow.position.set(0.12, 0.3, 0);
  group.add(glow);

  group.userData = { lamp, glow };
  return group;
}

/**
 * Мигание: чем ближе взрыв, тем чаще.
 *
 * Это единственный способ понять, сколько осталось, не глядя на часы, — и он
 * работает на звук и на глаз одновременно. Частоту считаем от доли оставшегося
 * времени, а не от секунд: тогда ритм одинаков и при длинном запале, и при
 * коротком.
 */
export function blink(bombGroup, left, total){
  const { lamp, glow } = bombGroup.userData;
  const k = Math.max(0.05, left / total);
  const period = 0.18 + k * 0.9;
  const phase = (performance.now() / 1000) % period;
  const on = phase < period * 0.4;

  lamp.material.color.setHex(on ? 0xff6a4a : 0x5a1a12);
  glow.intensity = on ? 9 : 0;
  return on;
}

/** В какой зоне стоит игрок: 0 — точка A, 1 — точка B, -1 — нигде. */
export function siteAt(pos, sites){
  if (!sites) return -1;
  for (let i = 0; i < sites.length; i++){
    const s = sites[i];
    const dx = pos.x - s[0], dz = pos.z - s[2];
    const dy = pos.y - s[1];
    // По высоте допуск отдельный: на «Плотине» точки на разных уровнях, и
    // круглая зона по всем трём осям пускала бы закладывать с этажа выше.
    if (Math.abs(dy) > 3.5) continue;
    if (dx * dx + dz * dz <= BOMB.siteRadius * BOMB.siteRadius) return i;
  }
  return -1;
}

/**
 * Сколько секунд до взрыва. Возвращает null, если бомба не заложена.
 *
 * Считаем от ВРЕМЕНИ ЗАКЛАДКИ, записанного в базу, а не от своего секундомера:
 * иначе у зашедшего в середине раунда бомба тикала бы заново, и он видел бы
 * не то, что все.
 */
export function fuseLeft(bomb, now = Date.now()){
  if (!bomb || bomb.state !== BOMB_STATE.PLANTED) return null;
  return Math.max(0, BOMB.fuse - (now - (bomb.at || now)) / 1000);
}

/** Текст для табло: что сейчас происходит. */
export function bombLine(bomb, mine){
  if (!bomb) return "";
  if (bomb.state === BOMB_STATE.PLANTED){
    const left = fuseLeft(bomb);
    return `Бомба на точке ${bomb.site === 1 ? "B" : "A"} — ${Math.ceil(left)} с`;
  }
  if (bomb.state === BOMB_STATE.DEFUSED) return "Бомба обезврежена";
  if (bomb.state === BOMB_STATE.EXPLODED) return "Бомба взорвалась";
  return mine ? "Бомба у тебя — иди на точку" : "Бомба у террористов";
}

/**
 * Кто несёт бомбу в этом раунде.
 *
 * Выбираем не случайно, а по наименьшему ключу сессии среди живых
 * террористов — тем же приёмом, что и ведущего раундов. Случайный выбор
 * пришлось бы согласовывать между клиентами (у каждого свой Math.random), а
 * так все считают одинаково и приходят к одному человеку.
 */
export function bombCarrier(sessions){
  if (!sessions.length) return null;
  let best = sessions[0];
  for (const s of sessions) if (s < best) best = s;
  return best;
}

/**
 * Полоса «закладываю» / «разминирую».
 *
 * Отдельный кусок интерфейса, потому что это единственное в игре действие,
 * которое ЗАНИМАЕТ ВРЕМЯ и которое можно прервать. Человек должен видеть, что
 * процесс идёт и сколько осталось, иначе три секунды неподвижности ощущаются
 * как зависшая игра.
 */
export class ActionBar {
  constructor(){
    const box = document.createElement("div");
    box.id = "actionBar";
    box.innerHTML = `<b></b><u><i></i></u>`;
    document.body.append(box);
    this.box = box;
    this.label = box.querySelector("b");
    this.fill = box.querySelector("i");
  }

  show(text, progress){
    this.box.classList.add("show");
    this.label.textContent = text;
    this.fill.style.width = Math.round(Math.max(0, Math.min(1, progress)) * 100) + "%";
  }

  hide(){ this.box.classList.remove("show"); }
}

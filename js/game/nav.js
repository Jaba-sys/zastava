// nav.js — по каким местам карты можно ходить и как туда пройти.
//
// Боту мало знать, где враг: ему надо ЗНАТЬ ДОРОГУ. Без этого он идёт по
// прямой, упирается в вагон и стоит в него носом до конца раунда — зрелище,
// знакомое всякому, кто видел плохих ботов.
//
// Как устроено. Карта раскладывается на сетку, и узлом графа считается клетка
// ВМЕСТЕ с высотой пола: в одной точке этажей бывает несколько — под навесом
// можно пройти и по навесу тоже. Между соседними узлами есть ребро, если
// разница высот по силам (вверх — на ступень, вниз — на прыжок с уступа) и если
// над обоими хватает места встать.
//
// Правила прохода тут НАМЕРЕННО те же самые, что в проверке проходимости карт
// (tests/index.html): те же шаг, подъём и просвет. Это не совпадение и не
// дублирование по лени — это одно свойство карты, записанное там, где оно
// нужно обоим. Если однажды бот не сможет куда-то дойти, та же проверка на
// карте загорится красным, и чинить придётся карту, а не бота.
//
// Скорость постройки важна: граф строится при загрузке карты, и лишняя секунда
// тут — это секунда чёрного экрана. Поэтому коллайдеры сперва раскладываются
// по крупным клеткам, и поиск «что рядом» перебирает десяток коробок вместо
// полутора тысяч.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
import { PLAYER } from "./physics.js";

// Сторона клетки. Ровно та же, что в проверке проходимости карт, и это не
// вкусовщина: на «Плотине» лестничный пандус поднимается на 0.64 метра с
// каждого метра длины, и при шаге 2.0 разница высот между соседними клетками
// становится 1.28 — впритык к пределу подъёма. Округление доводит её до
// непроходимой, и бот не может подняться на гребень, хотя человек поднимается
// спокойно. При 1.5 разница выходит 0.96 и запас есть. Постройка графа от
// этого дорожает втрое — то есть с трёх миллисекунд до девяти.
const STEP = 1.5;            // сторона клетки, метры
const MAX_UP = 1.3;          // насколько можно подняться между клетками
const MAX_DROP = 14;         // и спрыгнуть
const BUCKET = 10;           // сторона клетки в сетке коллайдеров
const CLEAR = 0.06;          // на столько коробка должна не доставать до пола

/**
 * Сетка коллайдеров: по какому квадрату какие коробки проходят.
 *
 * Без неё каждый запрос «что находится в точке» перебирал бы все коллайдеры
 * карты, а их полторы тысячи, и запросов при постройке — десятки тысяч.
 */
class Buckets {
  constructor(colliders){
    this.map = new Map();
    this.min = new THREE.Vector3(Infinity, Infinity, Infinity);
    this.max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    for (const collider of colliders){
      const box = collider.box;
      this.min.min(box.min);
      this.max.max(box.max);
      const i0 = Math.floor(box.min.x / BUCKET), i1 = Math.floor(box.max.x / BUCKET);
      const j0 = Math.floor(box.min.z / BUCKET), j1 = Math.floor(box.max.z / BUCKET);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++){
        const key = i + "," + j;
        let list = this.map.get(key);
        if (!list) this.map.set(key, list = []);
        list.push(box);
      }
    }
  }

  /** Коробки, накрывающие точку с запасом на ширину бойца. */
  at(x, z){
    const list = this.map.get(Math.floor(x / BUCKET) + "," + Math.floor(z / BUCKET));
    if (!list) return [];
    const half = PLAYER.width / 2;
    const out = [];
    for (const box of list){
      if (x >= box.min.x - half && x <= box.max.x + half &&
          z >= box.min.z - half && z <= box.max.z + half) out.push(box);
    }
    return out;
  }
}

/**
 * Двоичная куча: очередь, из которой всегда достаётся самый дешёвый узел.
 *
 * Сначала тут стоял честный перебор с припиской «очередь маленькая, куча
 * выиграет доли миллисекунды». Приписка оказалась неправдой: на «Карьере»
 * дорога снизу на уступ разворачивает поиск на тысячи узлов, перебор
 * становится квадратичным, и путь либо ищется десятки миллисекунд, либо
 * упирается в предел и не находится вовсе — бот просто стоял и смотрел в скалу.
 */
class Heap {
  constructor(){ this.items = []; }
  get size(){ return this.items.length; }
  push(item){
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0){
      const parent = (i - 1) >> 1;
      if (a[parent].f <= a[i].f) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(){
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length){
      a[0] = last;
      let i = 0;
      for (;;){
        const l = i * 2 + 1, r = l + 1;
        let small = i;
        if (l < a.length && a[l].f < a[small].f) small = l;
        if (r < a.length && a[r].f < a[small].f) small = r;
        if (small === i) break;
        [a[small], a[i]] = [a[i], a[small]];
        i = small;
      }
    }
    return top;
  }
}

export class Nav {
  constructor(map){
    const started = performance.now();
    this.colliders = map.colliders;
    this.buckets = new Buckets(map.colliders);

    // Границы берём от самой карты, а не числом из головы: карты разного
    // размера, и лишние сто метров пустой сетки — это впустую потраченное
    // время на загрузке.
    const pad = STEP * 2;
    this.minX = this.buckets.min.x - pad;
    this.minZ = this.buckets.min.z - pad;
    this.cols = Math.ceil((this.buckets.max.x - this.buckets.min.x + pad * 2) / STEP);
    this.rows = Math.ceil((this.buckets.max.z - this.buckets.min.z + pad * 2) / STEP);

    // Для каждой клетки — список высот, на которых боец помещается стоя.
    this.levels = new Map();
    for (let i = 0; i <= this.cols; i++){
      for (let j = 0; j <= this.rows; j++){
        const ls = this._levelsAt(this.x(i), this.z(j));
        if (ls.length) this.levels.set(i + "," + j, ls);
      }
    }
    // Где вообще идёт игра.
    //
    // В сетку попадает не только пол, но и всё, на чём формально можно стоять:
    // верх забора, крыша будки, карниз за стеной карты. Человек туда не попадёт
    // никогда, а бот, получив такое место в цель, честно не найдёт дороги — и
    // будет стоять. Поэтому один раз обходим граф от точек возрождения и
    // запоминаем, куда с них можно дойти. Всё остальное для ботов не
    // существует: целей там не бывает, и пути туда не ищутся.
    const spawns = map.spawns.map(s => s.pos);
    this.reach = this._spread(spawns);

    // И ещё раз, задом наперёд: откуда можно ВЕРНУТЬСЯ к точкам возрождения.
    //
    // Рёбра тут односторонние: спрыгнуть с уступа можно на четырнадцать метров,
    // а забраться — на полтора. Значит, бывают места, куда дойти можно, а выйти
    // нельзя: яма, канава, приямок. Человек туда попадёт разве что по
    // невнимательности, а бот на прогулке назначит себе такое место целью,
    // дойдёт — и останется там до конца раунда.
    const back = this._spread(spawns, true);
    this.reachKeys = [...this.reach].filter(k => back.has(k));
    this.oneWay = this.reach.size - this.reachKeys.length;

    this.buildMs = Math.round(performance.now() - started);
  }

  /**
   * Обход в ширину от нескольких точек разом.
   *
   * reverse — идти по рёбрам против шерсти: не «куда отсюда можно», а «откуда
   * сюда можно». Так находится множество мест, из которых есть путь обратно.
   */
  _spread(starts, reverse = false){
    const seen = new Set();
    const queue = [];
    for (const pos of starts){
      const node = this._nearestAny(new THREE.Vector3(pos[0], pos[1], pos[2]));
      if (!node) continue;
      const k = nodeKey(node);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(node);
    }
    while (queue.length){
      const current = queue.shift();
      for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const ni = current.i + di, nj = current.j + dj;
        const ls = this.levels.get(ni + "," + nj);
        if (!ls) continue;
        for (const y of ls){
          const k = `${ni},${nj}@${y}`;
          if (seen.has(k)) continue;
          const step = reverse
            ? this._canStep({ i: ni, j: nj, y }, current.i, current.j, current.y)
            : this._canStep(current, ni, nj, y);
          if (!step) continue;
          seen.add(k);
          queue.push({ i: ni, j: nj, y });
        }
      }
    }
    return seen;
  }

  x(i){ return this.minX + i * STEP; }
  z(j){ return this.minZ + j * STEP; }
  i(x){ return Math.round((x - this.minX) / STEP); }
  j(z){ return Math.round((z - this.minZ) / STEP); }

  /** Высоты пола в точке, на которых помещается стоящий боец. */
  _levelsAt(x, z){
    const boxes = this.buckets.at(x, z);
    const candidates = new Set([0]);
    for (const box of boxes) if (box.max.y >= 0 && box.max.y < 60) candidates.add(+box.max.y.toFixed(3));

    const out = [];
    for (const y of candidates){
      // Пол есть, а над ним ничего не нависает на рост бойца.
      let blocked = false;
      for (const box of boxes){
        if (box.max.y > y + CLEAR && box.min.y < y + PLAYER.height){ blocked = true; break; }
      }
      if (!blocked) out.push(y);
    }
    return out.sort((a, b) => a - b);
  }

  /** Ближайший узел, до которого игра вообще доходит. */
  nearest(pos){
    return this._nearestAny(pos, true) || this._nearestAny(pos, false);
  }

  /** Ближайший узел к точке: клетка плюс подходящая высота. */
  _nearestAny(pos, onlyReachable = false){
    let best = null, bestScore = Infinity;
    const ci = this.i(pos.x), cj = this.j(pos.z);
    // Смотрим не только свою клетку: точка может оказаться в стене или в
    // воздухе, и тогда надо взять ближайшее место, где стоять можно.
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++){
      const i = ci + di, j = cj + dj;
      const ls = this.levels.get(i + "," + j);
      if (!ls) continue;
      for (const y of ls){
        if (onlyReachable && this.reach && !this.reach.has(`${i},${j}@${y}`)) continue;
        const dy = Math.abs(y - pos.y);
        const flat = Math.hypot(this.x(i) - pos.x, this.z(j) - pos.z);
        // Высота весит больше: этаж перепутать хуже, чем промахнуться на метр.
        const score = flat + dy * 3;
        if (score < bestScore){ bestScore = score; best = { i, j, y }; }
      }
    }
    return best;
  }

  /** Можно ли шагнуть из узла в соседнюю клетку на высоту y. */
  _canStep(from, ni, nj, y){
    const up = y - from.y;
    if (up > MAX_UP || up < -MAX_DROP) return false;
    // Между этажами надо пролезть: проверяем просвет на БОЛЬШЕЙ из двух высот.
    const top = Math.max(from.y, y);
    for (const box of this.buckets.at(this.x(ni), this.z(nj))){
      if (box.max.y > top + CLEAR && box.min.y < top + PLAYER.height) return false;
    }
    return true;
  }

  /**
   * Путь от точки до точки: список точек, по которым идти.
   *
   * Поиск — A* по сетке. Возвращает null, если дороги нет вообще: бот тогда
   * не пойдёт никуда, и это лучше, чем идти в стену.
   */
  path(from, to, limit = 40000){
    const start = this.nearest(from), goal = this.nearest(to);
    if (!start || !goal) return null;

    const key = n => `${n.i},${n.j}@${n.y}`;
    const goalKey = key(goal);
    const startKey = key(start);
    if (startKey === goalKey) return [new THREE.Vector3(this.x(goal.i), goal.y, this.z(goal.j))];

    const heuristic = n =>
      Math.hypot(this.x(n.i) - this.x(goal.i), this.z(n.j) - this.z(goal.j)) + Math.abs(n.y - goal.y);

    const open = new Heap();
    open.push({ node: start, g: 0, f: heuristic(start) });
    const came = new Map([[startKey, null]]);
    const best = new Map([[startKey, 0]]);
    let seen = 0;

    while (open.size){
      const current = open.pop();
      const currentKey = key(current.node);
      // Узел мог попасть в очередь дважды — со старой, худшей ценой. Дешевле
      // пропустить его тут, чем удалять из кучи при каждом улучшении.
      if (best.get(currentKey) < current.g) continue;

      if (currentKey === goalKey) return this._unwind(came, goal);
      if (++seen > limit) return null;          // карта большая, а времени мало

      for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const ni = current.node.i + di, nj = current.node.j + dj;
        const ls = this.levels.get(ni + "," + nj);
        if (!ls) continue;
        for (const y of ls){
          if (!this._canStep(current.node, ni, nj, y)) continue;
          const next = { i: ni, j: nj, y };
          const nextKey = key(next);
          const g = current.g + STEP + Math.abs(y - current.node.y) * 0.5;
          if (best.has(nextKey) && best.get(nextKey) <= g) continue;
          best.set(nextKey, g);
          came.set(nextKey, { from: currentKey, node: current.node });
          open.push({ node: next, g, f: g + heuristic(next) });
        }
      }
    }
    return null;
  }

  _unwind(came, goal){
    const key = n => `${n.i},${n.j}@${n.y}`;
    const points = [];
    let node = goal, k = key(goal);
    while (node){
      points.push(new THREE.Vector3(this.x(node.i), node.y, this.z(node.j)));
      const step = came.get(k);
      if (!step) break;
      node = step.node;
      k = step.from;
    }
    points.reverse();
    return this._straighten(points);
  }

  /**
   * Спрямление пути.
   *
   * Сетка даёт лесенку из поворотов на девяносто градусов — по ней бот ходит
   * как робот-пылесос. Выбрасываем каждую точку, которую можно пропустить: если
   * из позапрошлой точки в следующую есть прямая дорога, средняя не нужна.
   */
  _straighten(points){
    if (points.length < 3) return points;
    const out = [points[0]];
    let anchor = 0;
    for (let k = 1; k < points.length - 1; k++){
      if (this.clearWalk(points[anchor], points[k + 1])) continue;
      out.push(points[k]);
      anchor = k;
    }
    out.push(points[points.length - 1]);
    return out;
  }

  /** Пройдёт ли боец по прямой отсюда туда, не задев угол. */
  clearWalk(a, b){
    const dx = b.x - a.x, dz = b.z - a.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.001) return true;
    const steps = Math.ceil(distance / (STEP * 0.5));
    for (let s = 1; s <= steps; s++){
      const t = s / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      const y = a.y + (b.y - a.y) * t;
      const ls = this._levelsAt(x, z);
      // Пол на этой высоте есть? Полметра допуска — на пандусы и рельсы.
      if (!ls.some(level => Math.abs(level - y) < 0.55)) return false;
    }
    return true;
  }

  /**
   * Случайное место, где можно стоять. Нужно, когда идти конкретно некуда.
   *
   * Берём только из достижимой части карты. Пока брали из всей сетки, каждая
   * пятая «прогулка» назначалась на верх забора, бот не находил туда дороги и
   * вместо прогулки стоял.
   */
  randomSpot(random = Math.random){
    if (!this.reachKeys.length) return null;
    const k = this.reachKeys[Math.floor(random() * this.reachKeys.length)];
    const [cell, y] = k.split("@");
    const [i, j] = cell.split(",").map(Number);
    return new THREE.Vector3(this.x(i), Number(y), this.z(j));
  }
}

const nodeKey = n => `${n.i},${n.j}@${n.y}`;

// Граф строится один раз на карту и живёт, пока живёт вкладка: пересобирать
// его нечего — геометрия карты не меняется.
const cache = new Map();

export function navFor(map, id){
  if (!cache.has(id)) cache.set(id, new Nav(map));
  return cache.get(id);
}

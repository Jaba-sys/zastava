// touch.js — управление с телефона и планшета.
//
// Мышь на телефоне не захватишь, клавиатуры нет, поэтому весь ввод строится
// заново, но кладётся в ТОТ ЖЕ объект Controls, что и клавиатура с мышью.
// Благодаря этому вся остальная игра ничего не знает о телефоне: цикл матча,
// стрельба и физика читают controls.keys, controls.yaw и controls.firing и не
// различают, откуда они взялись.
//
// Раскладка обычная для мобильного шутера и выбрана не случайно:
//   левая половина экрана  — стик движения; появляется там, где палец коснулся,
//                            а не в заранее нарисованном кружке: попадать в
//                            фиксированную точку вслепую неудобно;
//   правая половина        — обзор перетаскиванием;
//   кнопки справа снизу    — огонь, прыжок, присесть, перезарядка, смена ствола;
//   кнопка прицела слева от огня — держать не надо, она переключается.
//
// Стрельба висит на отдельной кнопке, а не на касании правой половины: иначе
// невозможно просто осмотреться, не открыв огонь.
//
// ---- про то, что кнопки двигаются ------------------------------------------
//
// Раскладка «из коробки» не может подойти всем: у людей разные телефоны и
// разные руки, и то, что удобно на шестидюймовом экране с большим пальцем
// правой руки, неудобно на планшете двумя руками. Поэтому кнопки не прибиты
// сеткой, а лежат каждая на своих координатах, и эти координаты человек может
// поменять прямо в матче: «Настроить кнопки» в паузе, перетащил, растянул
// ползунком, «Готово».
//
// Координаты хранятся ДОЛЯМИ экрана, а не пикселями. Это важно: телефон
// поворачивают, окно меняет размер, и раскладка в пикселях после поворота
// уехала бы за край. В долях она просто растягивается вместе с экраном.
// Лежит всё в localStorage — на этом устройстве, без всякой сети.

const STICK_RADIUS = 58;      // на сколько пикселей от центра стик доходит до упора
const LOOK_SPEED = 0.0055;    // чувствительность обзора пальцем
const LAYOUT_KEY = "zastava.touchLayout";

/**
 * Раскладка по умолчанию: смещения ЦЕНТРА кнопки от угла экрана в пикселях и
 * базовый размер. Пиксели тут только чтобы один раз посчитать доли на текущем
 * экране — дальше живут доли.
 */
const DEFAULTS = {
  fire:   { corner: "br", dx:  60, dy:  60, size: 88, label: "Огонь" },
  jump:   { corner: "br", dx: 150, dy:  52, size: 68, label: "Прыжок" },
  crouch: { corner: "br", dx: 228, dy:  52, size: 68, label: "Присесть" },
  aim:    { corner: "br", dx:  60, dy: 150, size: 68, label: "Прицел" },
  swap:   { corner: "br", dx: 150, dy: 150, size: 68, label: "Ствол" },
  reload: { corner: "br", dx: 228, dy: 150, size: 68, label: "Заряд" },
  pause:  { corner: "tl", dx:  38, dy:  38, size: 44, label: "Пауза" }
};
const ORDER = ["fire", "jump", "crouch", "aim", "swap", "reload", "pause"];

export function isTouchDevice(){
  return (navigator.maxTouchPoints || 0) > 0
    || window.matchMedia?.("(pointer: coarse)").matches
    || "ontouchstart" in window;
}

/** Доли экрана для кнопки по умолчанию — считаются от текущего размера окна. */
function defaultSpot(act){
  const d = DEFAULTS[act];
  const W = Math.max(320, innerWidth), H = Math.max(320, innerHeight);
  const x = d.corner === "br" ? (W - d.dx) / W : d.dx / W;
  const y = d.corner === "br" ? (H - d.dy) / H : d.dy / H;
  return { x: clamp01(x), y: clamp01(y), s: 1 };
}

const clamp01 = v => Math.max(0.05, Math.min(0.95, v));

function loadLayout(){
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    const out = {};
    for (const act of ORDER){
      const s = saved[act];
      out[act] = (s && typeof s.x === "number" && typeof s.y === "number")
        ? { x: clamp01(s.x), y: clamp01(s.y), s: Math.max(0.6, Math.min(1.9, s.s || 1)) }
        : defaultSpot(act);
    }
    return out;
  } catch {
    // Приватный режим, запрещённое хранилище — не повод остаться без кнопок.
    const out = {};
    for (const act of ORDER) out[act] = defaultSpot(act);
    return out;
  }
}

export class TouchControls {
  /**
   * @param controls - тот же Controls, что у клавиатуры
   * @param hooks - { onReload, onSwap, onPause, onEditDone }
   */
  constructor(controls, hooks = {}){
    this.controls = controls;
    this.hooks = hooks;
    this.moveTouch = null;     // id пальца на стике
    this.lookTouch = null;     // id пальца обзора
    this.lookLast = { x: 0, y: 0 };
    this.layout = loadLayout();
    this.editing = false;
    this.picked = "fire";

    this._buildDom();
    this._applyLayout();
    this._bind();

    document.body.classList.add("touch");
    addEventListener("resize", () => this._applyLayout());
  }

  _buildDom(){
    const root = document.createElement("div");
    root.id = "touchUi";
    root.innerHTML = `
      <div id="stick"><i></i></div>
      <div id="touchButtons">
        <button class="tbtn" data-act="aim"    type="button">Прицел</button>
        <button class="tbtn tbtn-fire" data-act="fire" type="button">Огонь</button>
        <button class="tbtn" data-act="jump"   type="button">Прыжок</button>
        <button class="tbtn" data-act="crouch" type="button">Присесть</button>
        <button class="tbtn" data-act="reload" type="button">Заряд</button>
        <button class="tbtn" data-act="swap"   type="button">Ствол</button>
        <button class="tbtn tbtn-pause" data-act="pause" type="button">II</button>
      </div>

      <div id="touchEdit">
        <div class="edit-head">
          <div>
            <b>Настройка кнопок</b>
            <i>Перетащи кнопку пальцем. Ползунок меняет размер выбранной.</i>
          </div>
          <button class="edit-flip" id="editFlip" type="button" title="Переставить окно">⇅</button>
        </div>
        <div class="edit-pick" id="editPick"></div>
        <label class="edit-size">
          <span>Размер</span>
          <input id="editSize" type="range" min="60" max="190" step="5">
          <b id="editSizeValue">100%</b>
        </label>
        <div class="edit-actions">
          <button class="btn btn-ghost" id="editReset" type="button">Сбросить всё</button>
          <button class="btn btn-main" id="editDone" type="button">Готово</button>
        </div>
      </div>`;
    document.body.append(root);

    this.root = root;
    this.stick = root.querySelector("#stick");
    this.knob = this.stick.querySelector("i");
    this.buttons = {};
    for (const button of root.querySelectorAll(".tbtn[data-act]")){
      this.buttons[button.dataset.act] = button;
    }
    this.panel = root.querySelector("#touchEdit");
  }

  /** Развесить кнопки по сохранённым долям экрана. */
  _applyLayout(){
    for (const act of ORDER){
      const button = this.buttons[act];
      if (!button) continue;
      const spot = this.layout[act];
      const size = Math.round(DEFAULTS[act].size * spot.s);
      button.style.left = (spot.x * 100) + "%";
      button.style.top  = (spot.y * 100) + "%";
      button.style.width = size + "px";
      button.style.height = size + "px";
      button.style.fontSize = Math.max(9, Math.round(size * 0.165)) + "px";
    }
  }

  _save(){
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout)); }
    catch { /* хранилище может быть запрещено — тогда настройка живёт до выхода */ }
  }

  _bind(){
    const c = this.controls;

    // ---- кнопки -----------------------------------------------------------
    for (const act of ORDER){
      const button = this.buttons[act];

      const press = event => {
        // В режиме настройки кнопка не стреляет, а таскается. Иначе человек,
        // двигая «Огонь», расстреливал бы полмагазина.
        if (this.editing){ this._grab(event, act); return; }
        event.preventDefault();
        event.stopPropagation();
        if (act === "pause"){ this.hooks.onPause?.(); return; }
        button.classList.add("down");
        if (act === "fire")   c.firing = true;
        if (act === "jump")   c.keys.jump = true;
        if (act === "crouch") this._toggle(button, "crouch");
        if (act === "aim")    this._toggle(button, "aim");
        if (act === "reload") this.hooks.onReload?.();
        if (act === "swap")   this.hooks.onSwap?.();
      };
      const release = event => {
        if (this.editing) return;
        event.preventDefault();
        button.classList.remove("down");
        if (act === "fire") c.firing = false;
        if (act === "jump") c.keys.jump = false;
      };

      button.addEventListener("touchstart", press, { passive: false });
      button.addEventListener("touchend", release, { passive: false });
      button.addEventListener("touchcancel", release, { passive: false });
      // Мышь тоже вешаем: так кнопки работают в отладке на компьютере.
      button.addEventListener("mousedown", press);
      button.addEventListener("mouseup", release);
    }

    // ---- панель настройки --------------------------------------------------
    this.sizeInput = this.root.querySelector("#editSize");
    this.sizeValue = this.root.querySelector("#editSizeValue");
    this.sizeInput.addEventListener("input", () => {
      const spot = this.layout[this.picked];
      spot.s = Number(this.sizeInput.value) / 100;
      this.sizeValue.textContent = this.sizeInput.value + "%";
      this._applyLayout();
      this._save();
    });
    this.root.querySelector("#editReset").addEventListener("click", () => {
      for (const act of ORDER) this.layout[act] = defaultSpot(act);
      this._applyLayout();
      this._save();
      this._pick(this.picked);
    });
    this.root.querySelector("#editDone").addEventListener("click", () => this.endEdit());
    // Окно настройки само закрывает часть экрана, а двигать надо в том числе
    // кнопки под ним. Поэтому его можно перекинуть вниз и обратно.
    this.root.querySelector("#editFlip").addEventListener("click", () => {
      this.panel.classList.toggle("low");
    });

    // ---- стик и обзор -----------------------------------------------------
    // Слушаем на всём документе, а не на канвасе: палец легко соскальзывает за
    // пределы элемента, и жест не должен от этого обрываться.
    document.addEventListener("touchstart", e => this._start(e), { passive: false });
    document.addEventListener("touchmove", e => this._move(e), { passive: false });
    document.addEventListener("touchend", e => this._end(e), { passive: false });
    document.addEventListener("touchcancel", e => this._end(e), { passive: false });
  }

  /** Кнопки-переключатели: нажал — включилось, нажал ещё раз — выключилось. */
  _toggle(button, what){
    const c = this.controls;
    if (what === "crouch"){
      c.keys.crouch = !c.keys.crouch;
      button.classList.toggle("on", !!c.keys.crouch);
    } else {
      c.aiming = !c.aiming;
      button.classList.toggle("on", c.aiming);
    }
    button.classList.remove("down");
  }

  // -------------------------------------------------------------------------
  // Режим настройки
  // -------------------------------------------------------------------------

  startEdit(){
    this.editing = true;
    this.controls.firing = false;
    this.root.classList.remove("hidden");
    this.root.classList.add("editing");
    this._renderPicker();
    this._pick(this.picked);
  }

  endEdit(){
    this.editing = false;
    this.root.classList.remove("editing");
    this._save();
    this.hooks.onEditDone?.();
  }

  _renderPicker(){
    const box = this.root.querySelector("#editPick");
    box.innerHTML = "";
    for (const act of ORDER){
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "edit-chip";
      chip.dataset.act = act;
      chip.textContent = DEFAULTS[act].label;
      chip.onclick = () => this._pick(act);
      box.append(chip);
    }
  }

  _pick(act){
    this.picked = act;
    for (const chip of this.root.querySelectorAll(".edit-chip")){
      chip.classList.toggle("on", chip.dataset.act === act);
    }
    for (const other of ORDER) this.buttons[other].classList.toggle("picked", other === act);
    const pct = Math.round(this.layout[act].s * 100);
    this.sizeInput.value = pct;
    this.sizeValue.textContent = pct + "%";
  }

  /**
   * Взять кнопку пальцем и таскать.
   *
   * Слушатели вешаются на документ, а не на саму кнопку: кнопка едет за
   * пальцем, палец легко оказывается за её краем, и жест на самой кнопке
   * оборвался бы на первом же быстром движении.
   */
  _grab(event, act){
    event.preventDefault();
    event.stopPropagation();
    this._pick(act);

    const point = e => (e.touches?.[0] || e.changedTouches?.[0] || e);
    const move = e => {
      const p = point(e);
      if (p.clientX === undefined) return;
      e.preventDefault();
      this.layout[act].x = clamp01(p.clientX / innerWidth);
      this.layout[act].y = clamp01(p.clientY / innerHeight);
      this._applyLayout();
    };
    const up = () => {
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      this._save();
    };
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", up);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // -------------------------------------------------------------------------
  // Стик и обзор
  // -------------------------------------------------------------------------

  _isUi(target){
    return !!target.closest?.(
      "#touchButtons, #touchEdit, #start, #finish, #loading, #chat, #board");
  }

  _start(event){
    if (this.editing) return;
    for (const t of event.changedTouches){
      if (this._isUi(t.target)) continue;
      event.preventDefault();

      if (t.clientX < innerWidth * 0.45 && this.moveTouch === null){
        this.moveTouch = t.identifier;
        this.stickOrigin = { x: t.clientX, y: t.clientY };
        this.stick.style.left = t.clientX + "px";
        this.stick.style.top = t.clientY + "px";
        this.stick.classList.add("show");
        this._knob(0, 0);
      } else if (this.lookTouch === null){
        this.lookTouch = t.identifier;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  _move(event){
    if (this.editing) return;
    const c = this.controls;
    for (const t of event.changedTouches){
      if (t.identifier === this.moveTouch){
        event.preventDefault();
        const dx = t.clientX - this.stickOrigin.x;
        const dy = t.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy) || 1;
        const clamped = Math.min(len, STICK_RADIUS);
        const nx = dx / len * clamped / STICK_RADIUS;
        const ny = dy / len * clamped / STICK_RADIUS;
        this._knob(dx / len * clamped, dy / len * clamped);

        // Мёртвая зона: без неё боец дёргается от дрожания пальца.
        const dead = 0.22;
        c.keys.fwd   = ny < -dead;
        c.keys.back  = ny >  dead;
        c.keys.left  = nx < -dead;
        c.keys.right = nx >  dead;
        // Отклонил до упора — побежал. Отдельной кнопки бега не нужно.
        c.keys.sprint = Math.hypot(nx, ny) > 0.85;
      }

      if (t.identifier === this.lookTouch){
        event.preventDefault();
        c.yaw   -= (t.clientX - this.lookLast.x) * LOOK_SPEED / c.zoomFactor;
        c.pitch -= (t.clientY - this.lookLast.y) * LOOK_SPEED / c.zoomFactor;
        const limit = Math.PI / 2 - 0.02;
        c.pitch = Math.max(-limit, Math.min(limit, c.pitch));
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  _end(event){
    const c = this.controls;
    for (const t of event.changedTouches){
      if (t.identifier === this.moveTouch){
        this.moveTouch = null;
        this.stick.classList.remove("show");
        c.keys.fwd = c.keys.back = c.keys.left = c.keys.right = false;
        c.keys.sprint = false;
      }
      if (t.identifier === this.lookTouch) this.lookTouch = null;
    }
  }

  _knob(x, y){
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Спрятать кнопки на паузе и на итоговом экране. */
  setVisible(on){
    if (this.editing) return;          // в настройке они нужны видимыми
    this.root.classList.toggle("hidden", !on);
  }
}

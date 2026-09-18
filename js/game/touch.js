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

const STICK_RADIUS = 58;      // на сколько пикселей от центра стик доходит до упора
const LOOK_SPEED = 0.0055;    // чувствительность обзора пальцем

export function isTouchDevice(){
  return (navigator.maxTouchPoints || 0) > 0
    || window.matchMedia?.("(pointer: coarse)").matches
    || "ontouchstart" in window;
}

export class TouchControls {
  /**
   * @param controls - тот же Controls, что у клавиатуры
   * @param hooks - { onReload, onSwap, onPause }
   */
  constructor(controls, hooks = {}){
    this.controls = controls;
    this.hooks = hooks;
    this.moveTouch = null;     // id пальца на стике
    this.lookTouch = null;     // id пальца обзора
    this.lookLast = { x: 0, y: 0 };

    this._buildDom();
    this._bind();

    document.body.classList.add("touch");
  }

  _buildDom(){
    const root = document.createElement("div");
    root.id = "touchUi";
    root.innerHTML = `
      <div id="stick"><i></i></div>
      <div id="touchButtons">
        <button class="tbtn tbtn-aim"    data-act="aim"    type="button">Прицел</button>
        <button class="tbtn tbtn-fire"   data-act="fire"   type="button">Огонь</button>
        <button class="tbtn tbtn-jump"   data-act="jump"   type="button">Прыжок</button>
        <button class="tbtn tbtn-crouch" data-act="crouch" type="button">Присесть</button>
        <button class="tbtn tbtn-reload" data-act="reload" type="button">Заряд</button>
        <button class="tbtn tbtn-swap"   data-act="swap"   type="button">Ствол</button>
      </div>
      <button class="tbtn tbtn-pause" id="touchPause" type="button">II</button>`;
    document.body.append(root);

    this.root = root;
    this.stick = root.querySelector("#stick");
    this.knob = this.stick.querySelector("i");
  }

  _bind(){
    const c = this.controls;

    // ---- кнопки -----------------------------------------------------------
    for (const button of this.root.querySelectorAll(".tbtn[data-act]")){
      const act = button.dataset.act;

      const press = event => {
        event.preventDefault();
        event.stopPropagation();
        button.classList.add("down");
        if (act === "fire")   c.firing = true;
        if (act === "jump")   c.keys.jump = true;
        if (act === "crouch") this._toggle(button, "crouch");
        if (act === "aim")    this._toggle(button, "aim");
        if (act === "reload") this.hooks.onReload?.();
        if (act === "swap")   this.hooks.onSwap?.();
      };
      const release = event => {
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

    this.root.querySelector("#touchPause")
      .addEventListener("click", () => this.hooks.onPause?.());

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

  _isUi(target){
    return !!target.closest?.("#touchButtons, #touchPause, #start, #finish, #loading, #chat, #board");
  }

  _start(event){
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
    this.root.classList.toggle("hidden", !on);
  }
}

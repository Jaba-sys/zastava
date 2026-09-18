// controls.js — мышь и клавиши.
//
// Мышь захватывается браузером (Pointer Lock), иначе целиться невозможно: без
// захвата курсор упирается в край окна и обзор перестаёт крутиться. Захват
// браузер даёт только по клику человека — поэтому игра начинается с экрана
// "нажми, чтобы играть", а не сама.

const KEYS = {
  KeyW: "fwd",   ArrowUp:    "fwd",
  KeyS: "back",  ArrowDown:  "back",
  KeyA: "left",  ArrowLeft:  "left",
  KeyD: "right", ArrowRight: "right",
  Space: "jump",
  ShiftLeft: "sprint", ShiftRight: "sprint",
  ControlLeft: "crouch", KeyC: "crouch"
};

export class Controls {
  constructor(canvas){
    this.canvas = canvas;
    this.keys = {};
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022;
    this.locked = false;
    this.firing = false;
    this.onChat = null;        // вызывается по Enter — открыть строку чата
    this.onLockChange = null;
    this.blocked = false;      // true, пока человек печатает в чат

    this._bind();
  }

  _bind(){
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys = {};          // иначе "залипнет" бег
      this.onLockChange?.(this.locked);
    });

    document.addEventListener("mousemove", e => {
      if (!this.locked) return;
      this.yaw   -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      // Чуть меньше прямого угла: ровно 90° дают дрожание камеры на полюсе.
      const limit = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    });

    this.canvas.addEventListener("mousedown", e => {
      if (!this.locked) return;
      if (e.button === 0) this.firing = true;
    });
    document.addEventListener("mouseup", e => {
      if (e.button === 0) this.firing = false;
    });

    document.addEventListener("keydown", e => {
      if (this.blocked) return;
      if (e.code === "Enter"){ this.onChat?.(); return; }
      const key = KEYS[e.code];
      if (key){ this.keys[key] = true; e.preventDefault(); }
    });
    document.addEventListener("keyup", e => {
      const key = KEYS[e.code];
      if (key) this.keys[key] = false;
    });

    // Уходя из вкладки, снимаем все клавиши: вернувшись, человек не должен
    // обнаружить себя бегущим в стену.
    window.addEventListener("blur", () => { this.keys = {}; this.firing = false; });
  }

  requestLock(){
    this.canvas.requestPointerLock?.();
  }

  releaseLock(){
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

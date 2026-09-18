// sound.js — весь звук игры.
//
// Ни одного звукового файла в проекте нет, и это не экономия: выстрел,
// собранный из шума и огибающей прямо в браузере, весит ноль байт, звучит
// одинаково у всех и не заставляет ждать загрузки перед первым боем. Пять
// стволов отличаются на слух — низкий рык пулемёта, сухой треск ПП, хлопок
// дробовика, — и всё это три десятка строк вместо пяти мегабайт.
//
// Важная тонкость: браузер не даёт запустить звук, пока человек ничего не
// нажал. Поэтому контекст создаётся лениво, при первом же вызове после клика
// по экрану «Нажми, чтобы играть», а до этого все функции — тихий пустой ход.

let ctx = null;
let master = null;
let muted = false;

const VOLUME_KEY = "zastava.volume";

function readVolume(){
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    return saved === null ? 0.7 : Math.max(0, Math.min(1, Number(saved)));
  } catch { return 0.7; }
}
let volume = readVolume();

/** Поднимает звуковой контекст. Зовётся из обработчика клика, не раньше. */
export function wakeSound(){
  if (ctx) {
    if (ctx.state === "suspended") ctx.resume();
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;                       // звука нет — игра всё равно работает
  ctx = new Ctx();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(ctx.destination);
}

export function setVolume(value){
  volume = Math.max(0, Math.min(1, value));
  try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* ignore */ }
  if (master) master.gain.value = muted ? 0 : volume;
}

export function getVolume(){ return volume; }

export function setMuted(on){
  muted = !!on;
  if (master) master.gain.value = muted ? 0 : volume;
}

export function isMuted(){ return muted; }

// ---------------------------------------------------------------------------
// Кирпичики
// ---------------------------------------------------------------------------

/** Короткий кусок белого шума — основа всех выстрелов и шагов. */
function noiseBuffer(seconds){
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Шумовой удар: рывок громкости и спад. Из него собраны все выстрелы —
 * отличаются срезом фильтра, длиной хвоста и громкостью.
 */
function burst({ duration = 0.18, cutoff = 1800, q = 1, gain = 0.6, type = "lowpass" } = {}){
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(duration);

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = cutoff;
  filter.Q.value = q;

  const env = ctx.createGain();
  const now = ctx.currentTime;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0008, now + duration);

  src.connect(filter).connect(env).connect(master);
  src.start(now);
  src.stop(now + duration + 0.02);
}

/** Тон с огибающей — для щелчков, попаданий и мелодий. */
function tone({ freq = 440, duration = 0.12, gain = 0.25, type = "sine", slideTo = null, delay = 0 } = {}){
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  const now = ctx.currentTime + delay;
  osc.frequency.setValueAtTime(freq, now);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0008, now + duration);

  osc.connect(env).connect(master);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

// ---------------------------------------------------------------------------
// Голоса оружия
// ---------------------------------------------------------------------------

const VOICES = {
  //                длина  срез фильтра  резонанс  громкость
  rifle:   { duration: 0.17, cutoff: 2200, q: 1.2, gain: 0.55, thump: 120 },
  smg:     { duration: 0.10, cutoff: 3200, q: 0.9, gain: 0.38, thump: 170 },
  shotgun: { duration: 0.34, cutoff: 1100, q: 1.6, gain: 0.85, thump: 70  },
  sniper:  { duration: 0.46, cutoff: 1500, q: 2.2, gain: 0.95, thump: 55  },
  lmg:     { duration: 0.22, cutoff: 1500, q: 1.4, gain: 0.7,  thump: 85  }
};

export function playShot(weaponId){
  if (!ctx) return;
  const v = VOICES[weaponId] || VOICES.rifle;
  burst({ duration: v.duration, cutoff: v.cutoff, q: v.q, gain: v.gain });
  // Низкий «толчок» под шумом — без него выстрел звучит как шипение.
  tone({ freq: v.thump, slideTo: v.thump * 0.45, duration: v.duration * 0.8,
         gain: v.gain * 0.5, type: "triangle" });
}

/** Чужой выстрел: тот же голос, но тише и глуше — он же вдалеке. */
export function playRemoteShot(weaponId, distance = 40){
  if (!ctx) return;
  const v = VOICES[weaponId] || VOICES.rifle;
  const far = Math.max(0.08, Math.min(1, 1 - distance / 140));
  burst({ duration: v.duration * 1.2, cutoff: v.cutoff * (0.35 + far * 0.5),
          q: v.q, gain: v.gain * far * 0.55 });
}

// ---------------------------------------------------------------------------
// Всё остальное
// ---------------------------------------------------------------------------

/** Попал по человеку — короткий высокий щелчок, самый важный звук в игре. */
export function playHit(){
  tone({ freq: 1500, slideTo: 2100, duration: 0.07, gain: 0.3, type: "square" });
}

/** Прилетело тебе — глухой удар и лёгкий звон. */
export function playHurt(){
  burst({ duration: 0.25, cutoff: 600, gain: 0.5 });
  tone({ freq: 220, slideTo: 90, duration: 0.3, gain: 0.35, type: "sine" });
}

/** Перезарядка: щелчок вынутого магазина и щелчок вставленного. */
export function playReloadOut(){
  tone({ freq: 620, duration: 0.05, gain: 0.22, type: "square" });
}
export function playReloadIn(){
  tone({ freq: 380, duration: 0.06, gain: 0.26, type: "square" });
  tone({ freq: 900, duration: 0.04, gain: 0.18, type: "square", delay: 0.07 });
}

export function playSwitch(){
  tone({ freq: 700, slideTo: 1100, duration: 0.05, gain: 0.18, type: "square" });
}

/** Ты умер — тяжёлый спад. */
export function playDeath(){
  burst({ duration: 0.5, cutoff: 400, gain: 0.5 });
  tone({ freq: 160, slideTo: 55, duration: 0.7, gain: 0.35, type: "sine" });
}

export function playSpawn(){
  tone({ freq: 300, slideTo: 620, duration: 0.18, gain: 0.2, type: "triangle" });
}

/** Ты кого-то убил — короткая восходящая двойка, ни с чем не спутаешь. */
export function playKill(){
  tone({ freq: 700, duration: 0.09, gain: 0.3, type: "triangle" });
  tone({ freq: 1050, duration: 0.14, gain: 0.3, type: "triangle", delay: 0.09 });
}

/** Покупка в оружейной — монетный перезвон. */
export function playPurchase(){
  tone({ freq: 880, duration: 0.09, gain: 0.25, type: "triangle" });
  tone({ freq: 1320, duration: 0.12, gain: 0.22, type: "triangle", delay: 0.08 });
  tone({ freq: 1760, duration: 0.18, gain: 0.18, type: "triangle", delay: 0.17 });
}

export function playClick(){
  tone({ freq: 520, duration: 0.04, gain: 0.14, type: "square" });
}

export function playDenied(){
  tone({ freq: 240, slideTo: 150, duration: 0.18, gain: 0.25, type: "sawtooth" });
}

/** Конец матча — три ноты вниз, чтобы было слышно и с отвёрнутой головой. */
export function playMatchEnd(){
  tone({ freq: 660, duration: 0.3, gain: 0.28, type: "triangle" });
  tone({ freq: 520, duration: 0.3, gain: 0.28, type: "triangle", delay: 0.22 });
  tone({ freq: 392, duration: 0.6, gain: 0.3,  type: "triangle", delay: 0.44 });
}

/** Шаг. Зовётся из цикла по таймеру, поэтому нарочно очень тихий. */
export function playStep(){
  burst({ duration: 0.09, cutoff: 900, gain: 0.12 });
}

export function playChat(){
  tone({ freq: 980, duration: 0.06, gain: 0.16, type: "sine" });
}

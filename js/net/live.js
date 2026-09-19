// live.js — всё, что происходит в матче, идёт через Realtime Database.
//
// Почему не Firestore: там бесплатный лимит 20 000 записей в СУТКИ. Один игрок
// шлёт свою позицию 12 раз в секунду — это 43 200 записей в час. Firestore
// кончился бы через двадцать минут первого же матча. У Realtime Database лимит
// по трафику, а не по числу записей, и такой поток для неё — норма.
//
// Схема:
//   /roomIndex/{id}                 карточка комнаты для списка в лобби
//   /rooms/{id}/meta                карта, режим, хозяин, состояние
//   /rooms/{id}/players/{session}   позиция, поворот, здоровье, счёт
//   /rooms/{id}/events/{push}       выстрелы, попадания, смерти
//   /rooms/{id}/chat/{push}         чат матча
//
// Ключ игрока — id анонимной сессии, а не uid из MyPeal: у одного человека
// может быть открыто две вкладки, и это два разных бойца. Настоящий uid лежит
// полем внутри.

import { rtdb } from "../firebase.js";
// Длины раундов и запала живут в modes.js — одним списком на всю игру. Держать
// здесь свою копию числа уже однажды вышло боком: «135» стояло в двух местах,
// и поправить оба разом никто бы не вспомнил.
import { BOMB } from "../game/modes.js";
import {
  ref, push, set, update, remove, onValue, onChildAdded, onChildRemoved,
  onDisconnect, serverTimestamp, query, limitToLast, get
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

export const ROOM_STATE = { LOBBY: "lobby", LIVE: "live", OVER: "over" };

/** Короткий человеческий код комнаты — его удобно продиктовать голосом. */
export function roomCode(){
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // без похожих 0/O, 1/I
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Список комнат
// ---------------------------------------------------------------------------

/** Через сколько без единого удара пульса комната считается брошенной. */
const STALE_MS = 60_000;

/**
 * Постоянный сервер — комната с заранее известным именем, которая не
 * закрывается никогда.
 *
 * Своего сервера у игры нет, и «постоянный» тут значит не «где-то крутится
 * процесс», а «ветка в базе, которую никто не сносит». Пустую комнату
 * подметает первый зашедший в лобби — эту не подметает никто, поэтому зайти в
 * неё можно в любое время и оказаться там, где уже кто-то есть. Раунды крутит
 * тот из присутствующих, чей ключ сессии меньше всех: выбирать никого не надо,
 * все клиенты приходят к одному ответу сами, и смена ведущего при уходе
 * происходит молча.
 */
export const MAIN_ROOM = "main";
export const MAIN = {
  id: MAIN_ROOM,
  name: "Застава — общий",
  // Общий сервер играет в заминирование: у режима есть начало и конец раунда,
  // а значит, зашедший в любую минуту попадает не в середину чужой бесконечной
  // перестрелки, а в понятную ситуацию — «идёт раунд, бомба ещё не заложена».
  mode: "bomb",
  maxPlayers: 16,
  killsToWin: 15,          // для командного боя: сколько убийств за раунд
  roundSeconds: 360,       // ...или шесть минут, что раньше
  mapsPerCycle: 5,         // каждые пять раундов — новая карта
  maps: ["karier", "depo", "teplitsy", "plotina"]
};

/** Какая карта на этом раунде. Круг по списку, номер раунда с единицы. */
export function mapForRound(round){
  const step = Math.floor((Math.max(1, round) - 1) / MAIN.mapsPerCycle);
  return MAIN.maps[step % MAIN.maps.length];
}

export function watchRooms(callback){
  return onValue(ref(rtdb, "roomIndex"), snap => {
    const all = snap.val() || {};
    const rows = Object.entries(all).map(([id, meta]) => ({ id, ...meta }));

    // Брошенные комнаты не просто прячем, а подметаем: раньше они висели в
    // базе вечно, потому что убрать их мог только хозяин, а хозяин как раз и
    // ушёл. Теперь любой, кто открыл лобби, сносит пустые — правила базы это
    // разрешают ровно для комнат, в которых не осталось ни одного игрока.
    const live = [];
    for (const room of rows){
      if (Date.now() - (room.beat || 0) > STALE_MS) sweepRoom(room.id);
      else live.push(room);
    }

    live.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    callback(live);
  });
}

/**
 * Сколько детей у снимка.
 *
 * Считаем по val(), а не методом снимка, и вот почему: в старой, «неймспейсной»
 * библиотеке Firebase у DataSnapshot был numChildren(), а в модульной (той, что
 * здесь, v9+) его убрали — осталось свойство size. Вызов numChildren() в ней
 * падает на ровном месте: "snap.numChildren is not a function". Подсчёт по
 * объекту не зависит от того, какую версию подсунут, и лишнего запроса не
 * стоит — узел уже загружен.
 */
function countOf(snap){
  const value = snap?.val?.();
  return value && typeof value === "object" ? Object.keys(value).length : 0;
}

/** Тихо убрать комнату, в которой никого не осталось. Ошибки прав — не беда. */
export async function sweepRoom(roomId){
  // Постоянный сервер не подметается никогда: он на то и постоянный, чтобы
  // человек мог зайти в любое время и оказаться не один.
  if (roomId === MAIN_ROOM) return false;
  try {
    const players = await get(ref(rtdb, `rooms/${roomId}/players`));
    if (countOf(players) > 0) return false;
    await remove(ref(rtdb, `rooms/${roomId}`)).catch(() => {});
    await remove(ref(rtdb, `roomIndex/${roomId}`)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function findRoomByCode(code){
  const snap = await get(ref(rtdb, "roomIndex"));
  const all = snap.val() || {};
  const found = Object.entries(all).find(([, m]) => m.code === code.toUpperCase());
  return found ? found[0] : null;
}

// ---------------------------------------------------------------------------
// Комната
// ---------------------------------------------------------------------------

export async function createRoom({ map, mode, hostUid, hostSession, hostName, maxPlayers, priv }){
  const id = push(ref(rtdb, "rooms")).key;
  const code = roomCode();
  const meta = {
    map, mode, code,
    host: hostUid,
    // Ключ сессии создателя. Именно по нему правила базы решают, кому можно
    // менять и закрывать комнату: uid из мессенджера для этого не годится —
    // в Realtime Database сверять можно только с auth.uid, а он анонимный.
    hostSession,
    hostName,
    maxPlayers: Math.max(2, Math.min(16, maxPlayers | 0 || 4)),
    // Закрытая комната не показывается в списке. Это не «безопасность» — id и
    // код всё равно лежат в базе, — а способ играть своей компанией, не собирая
    // случайных людей. Кто знает код, тот войдёт.
    priv: !!priv,
    state: ROOM_STATE.LOBBY,
    createdAt: Date.now(),
    beat: Date.now(),
    count: 0
  };
  // Заминирование живёт раундами, и первый раунд надо завести прямо здесь.
  // Без round и roundEnds комната рождается с «временем раунда = 0», и первая
  // же проверка объявляет, что время вышло, — раунд кончается, не начавшись.
  if (mode === "bomb"){
    meta.round = 1;
    meta.roundStart = Date.now();
    meta.roundEnds = Date.now() + BOMB.roundSeconds * 1000;
    meta.scoreA = 0;
    meta.scoreB = 0;
  }
  await set(ref(rtdb, `rooms/${id}/meta`), meta);
  await set(ref(rtdb, `roomIndex/${id}`), meta);
  return { id, code, meta };
}

/**
 * Пульс комнаты. Его подаёт ЛЮБОЙ находящийся в ней игрок, а не только хозяин.
 *
 * Раньше пульс был обязанностью хозяина, и на нём же висело обещание базе
 * снести комнату при обрыве связи. Из-за этого стоило хозяину закрыть вкладку —
 * и матч заканчивался у всех остальных посреди боя. Теперь наоборот: комната
 * живёт, пока в ней есть хоть кто-то, и исчезает, когда не осталось никого.
 */
export function roomHeartbeat(roomId, playersCount){
  const beat = () => {
    update(ref(rtdb, `roomIndex/${roomId}`), {
      beat: Date.now(),
      count: playersCount?.() ?? 0
    }).catch(() => {});
  };
  beat();
  const timer = setInterval(beat, 15_000);
  return () => clearInterval(timer);
}

/** Сколько человек сейчас в комнате. */
export async function countPlayers(roomId){
  return countOf(await get(ref(rtdb, `rooms/${roomId}/players`)));
}

/**
 * Дождаться обещания, но не дольше отведённого. Без этого на плохой связи
 * игра просто зависала: get() ходит на сервер В ОБХОД кэша и своего срока
 * ожидания не имеет — в метро или в едущей машине он может не ответить
 * никогда.
 */
function within(promise, ms, fallback){
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

/**
 * Есть ли куда войти: комната есть, места остались.
 *
 * Если ответа нет за пару секунд — ПУСКАЕМ. Проверка мест удобство, а не
 * охрана (лимит и так держится на честности, см. README), и запирать человека
 * перед входом в матч из-за того, что у него моргнул интернет, — худшее из
 * возможных решений.
 */
export async function roomCapacity(roomId){
  const SLOW = 2500;
  const [metaSnap, count] = await Promise.all([
    within(get(ref(rtdb, `rooms/${roomId}/meta`)).catch(() => null), SLOW, null),
    within(countPlayers(roomId).catch(() => -1), SLOW, -1)
  ]);

  const meta = metaSnap?.val?.() ?? null;
  // Сеть не ответила — не мешаем: комнату всё равно проверит сам матч, когда
  // получит meta по подписке.
  if (!metaSnap || count < 0) return { ok: true, slow: true, meta, count: 0, max: 0 };
  if (!meta) return { ok: false, reason: "Комната уже закрылась." };

  const max = meta.maxPlayers || 4;
  if (count >= max) return { ok: false, reason: `В комнате уже ${count} из ${max} — мест нет.`, meta, count };
  return { ok: true, meta, count, max };
}

/**
 * Закрыть комнату насовсем: хозяин так заканчивает матч, не дожидаясь, пока
 * разойдутся остальные. Всем, кто внутри, придёт state = over, и игра покажет
 * итог — выкидывать людей молча было бы грубо.
 */
export async function closeRoom(roomId){
  await setRoomState(roomId, ROOM_STATE.OVER, { winner: "Комнату закрыл хозяин", closedAt: Date.now() })
    .catch(() => {});
  // Дать клиентам мгновение увидеть итог и уйти самим, и только потом стирать.
  setTimeout(() => sweepRoom(roomId), 4000);
}

/**
 * Если ушёл последний — комнаты больше нет.
 *
 * Зовётся тем, кто выходит, уже ПОСЛЕ того, как убрал себя: раньше проверять
 * бессмысленно, он сам ещё числится в списке.
 */
export async function closeIfEmpty(roomId){
  // Тоже под сроком: человек нажал «Выйти в лобби», и ждать из-за него ответа
  // сети неизвестно сколько нельзя. Не ответила — считаем, что кто-то есть, и
  // комнату не трогаем: её потом подметёт лобби, когда пульс протухнет.
  const count = await within(countPlayers(roomId).catch(() => 1), 2500, 1);
  if (count > 0) return false;
  return sweepRoom(roomId);
}

export function watchMeta(roomId, callback){
  return onValue(ref(rtdb, `rooms/${roomId}/meta`), snap => callback(snap.val()));
}

export function setRoomState(roomId, state, extra = {}){
  const patch = { state, ...extra };
  return Promise.all([
    update(ref(rtdb, `rooms/${roomId}/meta`), patch),
    update(ref(rtdb, `roomIndex/${roomId}`), patch)
  ]);
}

// ---------------------------------------------------------------------------
// Игроки
// ---------------------------------------------------------------------------

/**
 * Зеркало своей карточки: то, что мы в последний раз отправили про себя.
 *
 * Нужно ради переподключения — см. joinRoom ниже. Ключ тот же, что и путь в
 * базе, так что две вкладки одного человека друг другу не мешают.
 */
const mine = new Map();

/**
 * Входит в комнату и обещает базе убрать себя, если связь оборвётся.
 *
 * onDisconnect — единственное, что спасает от «призраков»: человек закрыл
 * вкладку, а его боец так и стоит посреди карты. Обещание даётся серверу
 * ЗАРАНЕЕ, поэтому срабатывает даже при выдернутом кабеле.
 *
 * И вот из-за этого же обещания игра ломалась на плохой связи — так, что
 * человека переставали ВИДЕТЬ остальные, хотя у себя он бегал как ни в чём не
 * бывало. Цепочка такая:
 *
 *   1. связь моргнула (метро, лифт, машина) — сервер выполняет обещание и
 *      стирает карточку игрока целиком;
 *   2. связь вернулась, но обещание уже ИСПОЛНЕНО и больше не действует:
 *      onDisconnect срабатывает один раз, его надо давать заново;
 *   3. игра продолжает слать только координаты (pushState), а в них нет ни
 *      uid, ни имени. Правило базы требует, чтобы у карточки они были, — и
 *      каждая такая запись отвергается. Карточки нет и не появится.
 *
 * Итог: боец жив у себя на экране и не существует для всех остальных, пока не
 * перезайдёт. Поэтому здесь мы следим за служебным путём `.info/connected` и
 * на КАЖДОЕ восстановление связи заново даём обещание и заново пишем ПОЛНУЮ
 * карточку — с именем, здоровьем и счётом, какими они стали к этой секунде.
 */
export async function joinRoom(roomId, sessionUid, player){
  const path = `rooms/${roomId}/players/${sessionUid}`;
  const me = ref(rtdb, path);

  const state = {
    ...player,
    hp: 100, kills: 0, deaths: 0,
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0
  };
  mine.set(path, state);

  const rejoin = () => onDisconnect(me).remove()
    .then(() => set(me, { ...mine.get(path), t: serverTimestamp() }));

  await rejoin();

  // Первое срабатывание — это уже установленная связь, её мы только что
  // обработали сами; дальше каждое true означает, что связь ВЕРНУЛАСЬ.
  let first = true;
  const stopConn = onValue(ref(rtdb, ".info/connected"), snap => {
    if (snap.val() !== true) return;
    if (first){ first = false; return; }
    rejoin().catch(() => {});
  });

  // Выход: перестать следить за связью, убрать себя и, если больше никого не
  // осталось, закрыть комнату. Проверку делает именно уходящий — на сервере
  // некому.
  return async () => {
    stopConn();
    mine.delete(path);
    await remove(me).catch(() => {});
    await closeIfEmpty(roomId).catch(() => {});
  };
}

/**
 * Связь с базой: есть или нет.
 *
 * Отдельно от игры это знать нельзя, а знать надо: на плохой связи чужие бойцы
 * замирают, и без подсказки это выглядит как «игра сломалась» или «никого нет»,
 * а не как «пропал интернет».
 */
export function watchConnection(callback){
  return onValue(ref(rtdb, ".info/connected"), snap => callback(snap.val() === true));
}

export function watchPlayers(roomId, { onJoin, onUpdate, onLeave }){
  const base = ref(rtdb, `rooms/${roomId}/players`);
  const seen = new Set();

  const stopValue = onValue(base, snap => {
    const all = snap.val() || {};
    for (const [id, data] of Object.entries(all)){
      if (!seen.has(id)){ seen.add(id); onJoin?.(id, data); }
      else onUpdate?.(id, data);
    }
  });

  const stopGone = onChildRemoved(base, snap => {
    seen.delete(snap.key);
    onLeave?.(snap.key);
  });

  return () => { stopValue(); stopGone(); };
}

/**
 * Записать что-то про себя и запомнить это в зеркале.
 *
 * Зеркало — не кэш ради скорости, а то, чем восстанавливается карточка после
 * обрыва связи (см. joinRoom). Поэтому проходить через него обязаны ВСЕ записи
 * о себе: если хоть одна пойдёт мимо, после переподключения у бойца окажется,
 * скажем, вчерашнее здоровье или обнулённый счёт.
 */
function pushMine(roomId, sessionUid, patch){
  const path = `rooms/${roomId}/players/${sessionUid}`;
  const state = mine.get(path);
  if (state) Object.assign(state, patch);
  return update(ref(rtdb, path), patch).catch(() => {});
}

/** Позиция. Шлём часто и мелкими порциями — только то, что меняется. */
export function pushState(roomId, sessionUid, state){
  return pushMine(roomId, sessionUid, state);
}

export function pushScore(roomId, sessionUid, patch){
  return pushMine(roomId, sessionUid, patch);
}

// ---------------------------------------------------------------------------
// События: выстрелы, попадания, смерти
// ---------------------------------------------------------------------------

/**
 * Урон считает СТРЕЛЯЮЩИЙ, а применяет к себе ЖЕРТВА. Так у здоровья всегда
 * один хозяин, и не бывает состояния "у него на экране я жив, у меня мёртв".
 * Цена — доверие к чужому клиенту; без своего сервера иначе никак, см. README.
 */
export function sendEvent(roomId, event){
  return push(ref(rtdb, `rooms/${roomId}/events`), { ...event, t: Date.now() }).catch(() => {});
}

export function watchEvents(roomId, callback){
  const recent = query(ref(rtdb, `rooms/${roomId}/events`), limitToLast(50));
  const started = Date.now();
  return onChildAdded(recent, snap => {
    const event = snap.val();
    // Всё, что случилось до нашего прихода, нас не касается: иначе входящий
    // в комнату получит залпом полсотни чужих выстрелов.
    if (!event || event.t < started - 2000) return;
    callback(event, snap.key);
  });
}

/** Хозяин комнаты подчищает старые события, чтобы ветка не росла вечно. */
export function pruneEvents(roomId){
  return get(ref(rtdb, `rooms/${roomId}/events`)).then(snap => {
    const all = snap.val() || {};
    const old = Date.now() - 15_000;
    const dead = {};
    for (const [key, event] of Object.entries(all)) if (event.t < old) dead[key] = null;
    if (Object.keys(dead).length) return update(ref(rtdb, `rooms/${roomId}/events`), dead);
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Чат матча
// ---------------------------------------------------------------------------

export function sendChat(roomId, { uid, name, tag, text }){
  return push(ref(rtdb, `rooms/${roomId}/chat`), {
    uid, name, tag: tag || null,
    text: String(text).slice(0, 200),
    at: Date.now()
  });
}

export function watchChat(roomId, callback){
  const recent = query(ref(rtdb, `rooms/${roomId}/chat`), limitToLast(30));
  return onChildAdded(recent, snap => callback({ id: snap.key, ...snap.val() }));
}

// ---------------------------------------------------------------------------
// Присутствие: кто сейчас играет и где
// ---------------------------------------------------------------------------
//
// Лежит в Realtime Database под ключом СЕССИИ, а не аккаунта: сверять личность
// правила тут умеют только с auth.uid, а он анонимный. Uid из мессенджера идёт
// полем внутри — значит, теоретически можно объявить себя чужим человеком.
// Это тот же уровень доверия, что и у урона (см. README), и для строчки «кто
// сейчас играет» его достаточно; ничего, кроме показа в списке, на этом поле
// не держится.
//
// Две вкладки одного человека дают две записи — и правильно: это два разных
// бойца в двух разных комнатах.

/** Объявить о себе. Возвращает функцию «убрать себя». */
export async function announce(sessionUid, info){
  const me = ref(rtdb, `presence/${sessionUid}`);
  const write = () => onDisconnect(me).remove()
    .then(() => set(me, { ...info, at: Date.now() }));

  await write().catch(() => {});

  // То же, что и с карточкой бойца: обещание onDisconnect одноразовое, и после
  // обрыва связи присутствие надо объявлять заново, иначе человек пропадает из
  // списка до перезахода.
  let first = true;
  const stop = onValue(ref(rtdb, ".info/connected"), snap => {
    if (snap.val() !== true) return;
    if (first){ first = false; return; }
    write().catch(() => {});
  });

  return () => { stop(); remove(me).catch(() => {}); };
}

/** Поменять то, что о себе объявлено (сменил комнату, карту, ник). */
export function updateAnnounce(sessionUid, patch){
  return update(ref(rtdb, `presence/${sessionUid}`), { ...patch, at: Date.now() })
    .catch(() => {});
}

/**
 * Кто сейчас в игре. Записи старше трёх минут отбрасываем: onDisconnect
 * срабатывает не всегда (убитая вкладка, спящий телефон), и без этого список
 * постепенно заполнился бы призраками.
 */
export function watchPresence(callback){
  return onValue(ref(rtdb, "presence"), snap => {
    const all = snap.val() || {};
    const fresh = [];
    for (const [session, row] of Object.entries(all)){
      if (!row || !row.uid) continue;
      if (Date.now() - (row.at || 0) > 180_000) continue;
      fresh.push({ session, ...row });
    }
    fresh.sort((a, b) => (b.at || 0) - (a.at || 0));
    callback(fresh);
  });
}

// ---------------------------------------------------------------------------
// Постоянный сервер: раунды и смена карты
// ---------------------------------------------------------------------------

/**
 * Поднять постоянную комнату, если её ещё нет.
 *
 * Зовут это все подряд, а не какой-то один «главный»: комнаты может не быть
 * просто потому, что в неё сегодня никто не заходил. Запись идёт с проверкой
 * «а нет ли уже» — двое, зашедшие одновременно, в худшем случае напишут одно и
 * то же.
 */
export async function ensureMainRoom(){
  const metaRef = ref(rtdb, `rooms/${MAIN_ROOM}/meta`);
  const snap = await get(metaRef).catch(() => null);
  if (snap?.exists()) return snap.val();

  const meta = {
    map: mapForRound(1),
    mode: MAIN.mode,
    code: "OBSHIY",
    host: "server",
    hostSession: "server",
    hostName: MAIN.name,
    maxPlayers: MAIN.maxPlayers,
    priv: false,
    permanent: true,
    state: ROOM_STATE.LIVE,
    round: 1,
    // Длина раунда зависит от режима: в заминировании она своя и короткая.
    roundEnds: Date.now() + (MAIN.mode === "bomb" ? BOMB.roundSeconds : MAIN.roundSeconds) * 1000,
    roundStart: Date.now(),
    scoreA: 0,
    scoreB: 0,
    createdAt: Date.now(),
    beat: Date.now(),
    count: 0
  };
  await set(metaRef, meta).catch(() => {});
  await set(ref(rtdb, `roomIndex/${MAIN_ROOM}`), meta).catch(() => {});
  await resetBomb(MAIN_ROOM);
  return meta;
}

/**
 * Начать следующий раунд: счёт обнуляется, номер растёт, карта берётся по
 * номеру. Зовёт это только ведущий — тот, чей ключ сессии меньше всех в
 * комнате (см. isRoundKeeper ниже), иначе четверо разом начали бы четыре
 * раунда подряд.
 */
export async function nextRound(meta){
  const round = (meta.round || 1) + 1;
  const patch = {
    round,
    map: mapForRound(round),
    roundEnds: Date.now() + MAIN.roundSeconds * 1000,
    scoreA: 0,
    scoreB: 0,
    state: ROOM_STATE.LIVE
  };
  await Promise.all([
    update(ref(rtdb, `rooms/${MAIN_ROOM}/meta`), patch).catch(() => {}),
    update(ref(rtdb, `roomIndex/${MAIN_ROOM}`), patch).catch(() => {})
  ]);
  return patch;
}

/** Счёт раунда. Пишет тот, кто убил, — по своей команде. */
export function addRoundKill(team){
  const field = team === "b" ? "scoreB" : "scoreA";
  return get(ref(rtdb, `rooms/${MAIN_ROOM}/meta/${field}`))
    .then(snap => update(ref(rtdb, `rooms/${MAIN_ROOM}/meta`), {
      [field]: (Number(snap.val()) || 0) + 1
    }))
    .catch(() => {});
}

/**
 * Ведёт ли раунды именно эта сессия.
 *
 * Не голосование и не выборы: просто наименьший ключ среди присутствующих.
 * Все клиенты видят один и тот же список игроков и приходят к одному ответу; а
 * когда ведущий уходит, следующий по порядку берёт дело на себя сам, без
 * всякой передачи полномочий.
 */
export function isRoundKeeper(sessionUid, sessions){
  if (!sessions.length) return false;
  let best = sessions[0];
  for (const s of sessions) if (s < best) best = s;
  return best === sessionUid;
}

// ---------------------------------------------------------------------------
// Заминирование: бомба
// ---------------------------------------------------------------------------
//
// Состояние бомбы лежит в базе, а не у каждого в голове, потому что на него
// смотрят все сразу и разойтись во мнениях тут нельзя: заложена или нет, на
// какой точке, когда рванёт. Пишет его клиент — как и урон; своего сервера у
// игры нет, и это та же честность на доверии (см. README).

/**
 * Сколько бойцов на каждой стороне прямо сейчас.
 *
 * Нужно ровно для одного: показать это человеку, когда он выбирает сторону.
 * Считаем и людей, и ботов — выбирающему важно, сколько стволов на каждой
 * стороне, а не кто их держит.
 */
export async function teamCounts(roomId){
  const people = { a: 0, b: 0 }, bots = { a: 0, b: 0 };
  const count = (rows, into) => {
    for (const row of Object.values(rows || {})){
      if (row?.team === "a" || row?.team === "b") into[row.team]++;
    }
  };
  count((await get(ref(rtdb, `rooms/${roomId}/players`)).catch(() => null))?.val(), people);
  count((await get(ref(rtdb, `rooms/${roomId}/bots`)).catch(() => null))?.val(), bots);
  return { people, bots };
}

/**
 * Живой счёт ЛЮДЕЙ по сторонам.
 *
 * Пока человек выбирает сторону, в комнату может кто-то зайти, и выбор,
 * правильный секунду назад, станет неправильным. Подписываемся только на
 * players: боты меняются восемь раз в секунду, и слушать их ради счёта — значит
 * перерисовывать экран впустую.
 */
export function watchTeamCounts(roomId, callback){
  return onValue(ref(rtdb, `rooms/${roomId}/players`), snap => {
    const people = { a: 0, b: 0 };
    for (const row of Object.values(snap.val() || {})){
      if (row?.team === "a" || row?.team === "b") people[row.team]++;
    }
    callback(people);
  });
}

/**
 * Боты комнаты.
 *
 * Отдельная ветка, а не players, и на то есть причина в правилах базы: в
 * players каждый может писать ТОЛЬКО в своего бойца (auth.uid === ключ), и
 * иначе быть не должно — иначе любой писал бы в чужого. Но бот не «свой» ни
 * для кого: его ведёт то один клиент, то другой, по мере того как ведущий
 * меняется. Поэтому боты живут своей веткой, куда пишет любой вошедший, —
 * та же честность на доверии, что с уроном и с бомбой.
 */
export function watchBots(roomId, callback){
  return onValue(ref(rtdb, `rooms/${roomId}/bots`), snap => callback(snap.val() || {}));
}

/**
 * Выложить ботов. Приходит НЕ весь отряд, а только изменившиеся (см.
 * BotCrew.snapshot), поэтому update, а не set: set стёр бы всех остальных.
 * Чтобы убрать бота, в patch кладут null — база понимает это как «удалить».
 */
export function pushBots(roomId, patch){
  if (!patch || !Object.keys(patch).length) return Promise.resolve();
  return update(ref(rtdb, `rooms/${roomId}/bots`), patch).catch(() => {});
}

export function clearBots(roomId){
  return remove(ref(rtdb, `rooms/${roomId}/bots`)).catch(() => {});
}

export function watchBomb(roomId, callback){
  return onValue(ref(rtdb, `rooms/${roomId}/bomb`), snap => callback(snap.val()));
}

/** Заложить: с этой секунды запал и тикает у всех одинаково. */
export function plantBomb(roomId, { site, x, y, z, by, byName }){
  return set(ref(rtdb, `rooms/${roomId}/bomb`), {
    state: "planted", site, x, y, z, by, byName: byName || null, at: Date.now()
  }).catch(() => {});
}

export function defuseBomb(roomId, { by, byName }){
  return update(ref(rtdb, `rooms/${roomId}/bomb`), {
    state: "defused", defusedBy: by, defusedName: byName || null, defusedAt: Date.now()
  }).catch(() => {});
}

export function explodeBomb(roomId){
  return update(ref(rtdb, `rooms/${roomId}/bomb`), {
    state: "exploded", explodedAt: Date.now()
  }).catch(() => {});
}

/** Новый раунд — бомба снова на руках. Зовёт ведущий вместе с nextRound. */
export function resetBomb(roomId){
  return set(ref(rtdb, `rooms/${roomId}/bomb`), {
    state: "carried", at: Date.now()
  }).catch(() => {});
}

/**
 * Следующий раунд в любой комнате, а не только на общем сервере.
 *
 * Раньше раунды были свойством постоянной комнаты. С заминированием они стали
 * свойством РЕЖИМА: обычная комната в этом режиме тоже живёт раундами, иначе
 * бомбу некуда было бы возвращать после взрыва.
 */
export async function nextRoundIn(roomId, meta, { seconds, winner }){
  const round = (meta.round || 1) + 1;
  const patch = {
    round,
    roundEnds: Date.now() + seconds * 1000,
    roundStart: Date.now(),
    lastWinner: winner || null,
    state: ROOM_STATE.LIVE
  };
  // На общем сервере карта меняется по расписанию; в обычной комнате остаётся
  // та, которую выбрал создатель.
  if (roomId === MAIN_ROOM) patch.map = mapForRound(round);

  await Promise.all([
    update(ref(rtdb, `rooms/${roomId}/meta`), patch).catch(() => {}),
    update(ref(rtdb, `roomIndex/${roomId}`), patch).catch(() => {})
  ]);
  await resetBomb(roomId);
  return patch;
}

/** Победа в раунде: очко стороне. */
export function addRoundWin(roomId, team){
  const field = team === "b" ? "scoreB" : "scoreA";
  return get(ref(rtdb, `rooms/${roomId}/meta/${field}`))
    .then(snap => update(ref(rtdb, `rooms/${roomId}/meta`), {
      [field]: (Number(snap.val()) || 0) + 1
    }))
    .catch(() => {});
}

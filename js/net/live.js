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

/** Тихо убрать комнату, в которой никого не осталось. Ошибки прав — не беда. */
export async function sweepRoom(roomId){
  try {
    const players = await get(ref(rtdb, `rooms/${roomId}/players`));
    if (players.exists() && players.numChildren() > 0) return false;
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
  const snap = await get(ref(rtdb, `rooms/${roomId}/players`));
  return snap.exists() ? snap.numChildren() : 0;
}

/** Есть ли куда войти: код есть, комната есть, места остались. */
export async function roomCapacity(roomId){
  const [metaSnap, count] = await Promise.all([
    get(ref(rtdb, `rooms/${roomId}/meta`)),
    countPlayers(roomId)
  ]);
  const meta = metaSnap.val();
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
  const count = await countPlayers(roomId).catch(() => 1);
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
 * Входит в комнату и обещает базе убрать себя, если связь оборвётся.
 * onDisconnect — единственное, что спасает от "призраков": человек закрыл
 * вкладку, а его боец так и стоит посреди карты. Обещание даётся серверу
 * ЗАРАНЕЕ, поэтому срабатывает даже при выдернутом кабеле.
 */
export async function joinRoom(roomId, sessionUid, player){
  const me = ref(rtdb, `rooms/${roomId}/players/${sessionUid}`);
  await onDisconnect(me).remove();
  await set(me, {
    ...player,
    hp: 100, kills: 0, deaths: 0,
    x: 0, y: 0, z: 0, yaw: 0,
    t: serverTimestamp()
  });
  // Выход: убрать себя и, если больше никого не осталось, закрыть комнату.
  // Проверку делает именно уходящий — на сервере некому.
  return async () => {
    await remove(me).catch(() => {});
    await closeIfEmpty(roomId).catch(() => {});
  };
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

/** Позиция. Шлём часто и мелкими порциями — только то, что меняется. */
export function pushState(roomId, sessionUid, state){
  return update(ref(rtdb, `rooms/${roomId}/players/${sessionUid}`), state).catch(() => {});
}

export function pushScore(roomId, sessionUid, patch){
  return update(ref(rtdb, `rooms/${roomId}/players/${sessionUid}`), patch).catch(() => {});
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

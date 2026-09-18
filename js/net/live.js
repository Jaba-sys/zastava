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

export function watchRooms(callback){
  return onValue(ref(rtdb, "roomIndex"), snap => {
    const all = snap.val() || {};
    const list = Object.entries(all)
      .map(([id, meta]) => ({ id, ...meta }))
      // Комнаты, про которые давно ничего не слышно, показывать незачем:
      // хозяин мог закрыть вкладку так, что onDisconnect не сработал.
      .filter(r => Date.now() - (r.beat || 0) < 60_000)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    callback(list);
  });
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

export async function createRoom({ map, mode, hostUid, hostSession, hostName, maxPlayers }){
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
    maxPlayers,
    state: ROOM_STATE.LOBBY,
    createdAt: Date.now(),
    beat: Date.now(),
    count: 0
  };
  await set(ref(rtdb, `rooms/${id}/meta`), meta);
  await set(ref(rtdb, `roomIndex/${id}`), meta);
  return { id, code, meta };
}

/** Комната живёт, пока хозяин подаёт признаки жизни. */
export function hostHeartbeat(roomId){
  const stop = setInterval(() => {
    update(ref(rtdb, `roomIndex/${roomId}`), { beat: Date.now() }).catch(() => {});
  }, 15_000);

  onDisconnect(ref(rtdb, `roomIndex/${roomId}`)).remove();
  onDisconnect(ref(rtdb, `rooms/${roomId}`)).remove();

  return () => clearInterval(stop);
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
  return () => remove(me).catch(() => {});
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

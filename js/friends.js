// friends.js — друзья и заявки в друзья.
//
// Почему не «подписки», как в соцсетях, а именно взаимная дружба: список нужен
// не ради счётчика, а чтобы видеть, где играет свой человек, и зайти к нему
// одной кнопкой — в том числе в закрытую комнату. Такое право нельзя давать в
// одну сторону, иначе кто угодно набьёт себе список и будет ходить за людьми
// по чужим матчам.
//
// Отсюда устройство из двух коллекций:
//
//   gameFriendReq/{кому}_{откого}   заявка. Создаёт ТОЛЬКО отправитель (правила
//                                   проверяют, что он — это он), удалить может
//                                   любой из двоих: получатель отказом,
//                                   отправитель — передумав.
//   gameFriends/{меньший}_{больший} сама дружба. Создаётся, когда заявка уже
//                                   есть; правила это проверяют. Ключ из двух
//                                   uid по порядку — так пара имеет ровно одно
//                                   имя, с какой стороны на неё ни смотри, и
//                                   двух записей об одной дружбе не бывает.
//
// Один документ на пару, а не по списку у каждого, — потому что писать в чужую
// карточку правила не дают и дать не могут: иначе «добавить в друзья»
// превратилось бы в право менять чужие данные.

import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, deleteDoc, collection, query, where, limit,
  getDocs, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/** Имя документа пары: два uid по порядку, через подчёркивание. */
export function pairId(a, b){
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

const reqId = (to, from) => `${to}_${from}`;

// ---------------------------------------------------------------------------
// Заявки
// ---------------------------------------------------------------------------

/**
 * Позвать в друзья. Если встречная заявка уже лежит — сразу дружим: человек
 * позвал того, кто уже позвал его, и спрашивать второй раз незачем.
 */
export async function invite(me, other){
  if (!other?.uid || other.uid === me.uid) return { ok: false, reason: "Это ты сам." };

  const already = await getDoc(doc(db, "gameFriends", pairId(me.uid, other.uid)));
  if (already.exists()) return { ok: false, reason: "Вы уже друзья." };

  const incoming = await getDoc(doc(db, "gameFriendReq", reqId(me.uid, other.uid)));
  if (incoming.exists()){
    await accept(me, { uid: other.uid, ...incoming.data() });
    return { ok: true, becameFriends: true };
  }

  await setDoc(doc(db, "gameFriendReq", reqId(other.uid, me.uid)), {
    from: me.uid,
    to: other.uid,
    nick: me.nick,
    tag: me.tag || null,
    at: serverTimestamp()
  });
  return { ok: true, becameFriends: false };
}

/** Принять заявку: создаём дружбу и убираем заявку. */
export async function accept(me, request){
  const other = request.from;
  await setDoc(doc(db, "gameFriends", pairId(me.uid, other)), {
    a: me.uid < other ? me.uid : other,
    b: me.uid < other ? other : me.uid,
    at: serverTimestamp()
  });
  await deleteDoc(doc(db, "gameFriendReq", reqId(me.uid, other))).catch(() => {});
  return { ok: true };
}

/** Отказать или отменить свою заявку. */
export async function dropRequest(toUid, fromUid){
  await deleteDoc(doc(db, "gameFriendReq", reqId(toUid, fromUid))).catch(() => {});
}

/** Заявки, пришедшие мне. Слушаем, а не читаем: приходят они когда угодно. */
export function watchRequests(uid, callback){
  return onSnapshot(
    query(collection(db, "gameFriendReq"), where("to", "==", uid), limit(30)),
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    () => callback([])
  );
}

// ---------------------------------------------------------------------------
// Сами друзья
// ---------------------------------------------------------------------------

/**
 * Список uid друзей.
 *
 * Два запроса, а не один: пара записана как {a, b} с a меньше b, и я могу
 * оказаться на любой из двух сторон. Условия «или» по разным полям Firestore
 * не поддерживает так, чтобы это работало без составного индекса, — а два
 * простых запроса по одиночным полям индексируются сами.
 */
export function watchFriends(uid, callback){
  const state = { a: null, b: null };

  const merge = () => {
    if (!state.a || !state.b) return;
    const out = new Set();
    for (const row of [...state.a, ...state.b]) out.add(row.a === uid ? row.b : row.a);
    callback([...out]);
  };

  const stopA = onSnapshot(
    query(collection(db, "gameFriends"), where("a", "==", uid), limit(200)),
    snap => { state.a = snap.docs.map(d => d.data()); merge(); },
    () => { state.a = []; merge(); }
  );
  const stopB = onSnapshot(
    query(collection(db, "gameFriends"), where("b", "==", uid), limit(200)),
    snap => { state.b = snap.docs.map(d => d.data()); merge(); },
    () => { state.b = []; merge(); }
  );

  return () => { stopA(); stopB(); };
}

export async function unfriend(meUid, otherUid){
  await deleteDoc(doc(db, "gameFriends", pairId(meUid, otherUid))).catch(() => {});
}

/**
 * Карточки друзей пачкой. Firestore умеет отдавать до тридцати документов по
 * списку идентификаторов за один запрос — этим и пользуемся, вместо тридцати
 * отдельных чтений.
 */
export async function loadCards(uids){
  const out = new Map();
  const list = [...uids];
  const { documentId } = await import(
    "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js");

  for (let i = 0; i < list.length; i += 30){
    const chunk = list.slice(i, i + 30);
    if (!chunk.length) continue;
    const snap = await getDocs(query(
      collection(db, "gamePlayers"), where(documentId(), "in", chunk)
    )).catch(() => ({ docs: [] }));
    for (const d of snap.docs) out.set(d.id, { uid: d.id, ...d.data() });
  }
  return out;
}

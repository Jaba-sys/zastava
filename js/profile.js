// profile.js — карточка игрока: gamePlayers/{uid}, где uid — это uid из
// MyPeal, а не id анонимной сессии игры.
//
// Почему так, а не по сессии: анонимная сессия своя в каждом браузере. Зайдёшь
// с телефона — она будет другая, и очки, набранные на компьютере, потерялись
// бы. Ключ по аккаунту мессенджера решает это разом: где бы человек ни вошёл,
// карточка одна.
//
// Писать в чужую карточку правила не дают: они проверяют, что authLinks этой
// сессии указывает именно на этот uid (см. mypeal-auth.js и
// firestore.rules.add.txt).

import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, increment, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const ref = uid => doc(db, "gamePlayers", uid);

/**
 * Читает карточку, а если игрок новый — создаёт её.
 * name и tag берутся из пропуска, то есть из профиля в мессенджере: отдельный
 * позывной в игре не заводим специально — человека должны узнавать под тем же
 * именем, под которым он пишет в чате.
 */
export async function ensurePlayer(uid, { name, tag } = {}){
  const snap = await getDoc(ref(uid));

  if (snap.exists()){
    const data = snap.data();
    // Имя в мессенджере могли сменить — подтягиваем, но только если пришло
    // свежее из пропуска и оно правда отличается (лишняя запись не нужна).
    if (name && name !== data.name){
      await updateDoc(ref(uid), { name, tag: tag || data.tag || null });
      return { ...data, name, tag: tag || data.tag || null };
    }
    return data;
  }

  const fresh = {
    name: name || "Боец",
    tag: tag || null,
    points: 0,
    kills: 0,
    deaths: 0,
    matches: 0,
    createdAt: serverTimestamp(),
    lastPlayedAt: null
  };
  await setDoc(ref(uid), fresh);
  return fresh;
}

export async function readPlayer(uid){
  const snap = await getDoc(ref(uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Итоги матча. Пишутся один раз в конце, а не по ходу боя: каждое убийство
 * отдельной записью — это и лишний расход бесплатного лимита Firestore, и
 * лишняя задержка в самый неподходящий момент.
 */
export async function addMatchResult(uid, { points = 0, kills = 0, deaths = 0 } = {}){
  await updateDoc(ref(uid), {
    points:  increment(points),
    kills:   increment(kills),
    deaths:  increment(deaths),
    matches: increment(1),
    lastPlayedAt: serverTimestamp()
  });
}

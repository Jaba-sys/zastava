// profile.js — карточка игрока в Firestore, коллекция "players", id = uid.
// Сюда же потом будем писать результаты матчей и выданные кейсы.

import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, increment, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ref = uid => doc(db, "players", uid);

/** Читает профиль, а если игрок новый — создаёт его. */
export async function ensureProfile(user, nickname){
  const snap = await getDoc(ref(user.uid));
  if (snap.exists()) return snap.data();

  const profile = {
    nickname: nickname || user.displayName || ("Боец-" + user.uid.slice(0, 4)),
    points: 0,
    kills: 0,
    deaths: 0,
    matches: 0,
    cases: 0,
    createdAt: serverTimestamp()
  };

  await setDoc(ref(user.uid), profile);
  return profile;
}

/** Дописывает итоги матча. Пригодится, когда появится сама игра. */
export async function addMatchResult(uid, { points = 0, kills = 0, deaths = 0 } = {}){
  await updateDoc(ref(uid), {
    points:  increment(points),
    kills:   increment(kills),
    deaths:  increment(deaths),
    matches: increment(1),
    lastPlayedAt: serverTimestamp()
  });
}

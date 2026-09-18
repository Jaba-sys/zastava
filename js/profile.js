// profile.js — карточка игрока: gamePlayers/{uid}, где uid — это uid из
// MyPeal, а не id анонимной сессии игры.
//
// Почему так: анонимная сессия своя в каждом браузере. Зайдёшь с телефона —
// она будет другая, и купленное на компьютере пропало бы. Ключ по аккаунту
// мессенджера решает это разом: где бы человек ни вошёл, карточка одна.
//
// Два счётчика, и они разные нарочно:
//   points — рейтинг. Только растёт, тратить нельзя, по нему меряются.
//   coins  — кошелёк. Тоже копится за убийства, но его тратят в оружейной.
// Если бы счётчик был один, каждая покупка отбрасывала бы человека вниз
// таблицы, и копить было бы выгоднее, чем играть.
//
// Писать в чужую карточку правила не дают: они проверяют, что authLinks этой
// сессии указывает именно на этот uid (см. mypeal-auth.js и firestore.rules).

import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, updateDoc, increment, arrayUnion, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  WEAPONS, STARTER_OWNED, DEFAULT_LOADOUT, LOADOUT_SLOTS
} from "./game/weapons.js";

const ref = uid => doc(db, "gamePlayers", uid);

/** Приводит карточку к нынешнему виду: у старых нет ни монет, ни оружия. */
function withDefaults(data){
  return {
    ...data,
    coins: data.coins ?? 0,
    owned: Array.isArray(data.owned) && data.owned.length ? data.owned : [...STARTER_OWNED],
    loadout: Array.isArray(data.loadout) && data.loadout.length
      ? data.loadout.slice(0, LOADOUT_SLOTS)
      : [...DEFAULT_LOADOUT]
  };
}

/**
 * Читает карточку, а если игрок новый — создаёт её.
 * name и tag берутся из пропуска, то есть из профиля в мессенджере: отдельный
 * позывной в игре не заводим специально — человека должны узнавать под тем же
 * именем, под которым он пишет в чате.
 */
export async function ensurePlayer(uid, { name, tag } = {}){
  const snap = await getDoc(ref(uid));

  if (snap.exists()){
    const data = withDefaults(snap.data());
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
    coins: 0,
    kills: 0,
    deaths: 0,
    matches: 0,
    owned: [...STARTER_OWNED],
    loadout: [...DEFAULT_LOADOUT],
    createdAt: serverTimestamp(),
    lastPlayedAt: null
  };
  await setDoc(ref(uid), fresh);
  return fresh;
}

export async function readPlayer(uid){
  const snap = await getDoc(ref(uid));
  return snap.exists() ? withDefaults(snap.data()) : null;
}

/**
 * Итоги матча. Пишутся один раз в конце, а не по ходу боя: каждое убийство
 * отдельной записью — это и лишний расход бесплатного лимита Firestore, и
 * лишняя задержка в самый неподходящий момент.
 */
export async function addMatchResult(uid, { points = 0, coins = 0, kills = 0, deaths = 0 } = {}){
  await updateDoc(ref(uid), {
    points:  increment(points),
    coins:   increment(coins),
    kills:   increment(kills),
    deaths:  increment(deaths),
    matches: increment(1),
    lastPlayedAt: serverTimestamp()
  });
}

// ---------------------------------------------------------------------------
// Оружейная
// ---------------------------------------------------------------------------

/**
 * Покупка. Списание и выдача идут ОДНОЙ записью: разнеси их на две, и
 * оборвавшаяся связь между ними оставит человека либо без денег, либо с
 * бесплатным стволом. То же требуют и правила — они не пропустят запись, где
 * оружие прибавилось, а монеты не убавились.
 */
export async function buyWeapon(uid, player, weaponId){
  const weapon = WEAPONS[weaponId];
  if (!weapon) return { ok: false, reason: "Такого оружия нет." };
  if (player.owned.includes(weaponId)) return { ok: false, reason: "Уже куплено." };
  if ((player.coins || 0) < weapon.price){
    return { ok: false, reason: `Не хватает ${weapon.price - (player.coins || 0)} монет.` };
  }

  await updateDoc(ref(uid), {
    coins: increment(-weapon.price),
    owned: arrayUnion(weaponId)
  });

  return {
    ok: true,
    player: { ...player, coins: player.coins - weapon.price, owned: [...player.owned, weaponId] }
  };
}

/** Набор в бой: до двух стволов, и только из купленных. */
export async function setLoadout(uid, player, ids){
  const clean = ids.filter(id => WEAPONS[id] && player.owned.includes(id)).slice(0, LOADOUT_SLOTS);
  if (!clean.length) return { ok: false, reason: "Выбери хотя бы один ствол." };
  await updateDoc(ref(uid), { loadout: clean });
  return { ok: true, player: { ...player, loadout: clean } };
}

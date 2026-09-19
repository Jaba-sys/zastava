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
  doc, getDoc, setDoc, updateDoc, increment, arrayUnion, serverTimestamp,
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  WEAPONS, STARTER_OWNED, DEFAULT_LOADOUT, LOADOUT_SLOTS
} from "./game/weapons.js";

const ref = uid => doc(db, "gamePlayers", uid);

/**
 * Позывной, под которым человека видят в бою.
 *
 * Отдельно от имени в мессенджере — и это не прихоть. Имя в MyPeal люди пишут
 * для переписки («Владимир Петрович»), а над головой в бою нужен короткий
 * позывной, который читается за полсекунды. Раньше в игру тянулось имя из
 * мессенджера, и сменить его можно было только там — то есть заодно во всех
 * чатах. Теперь ник живёт в игре, а имя из мессенджера остаётся как было.
 */
export const NICK_MIN = 2;
export const NICK_MAX = 18;

/** Ник, под которым игрока показывают. Старым карточкам подставляем имя. */
export function displayName(player){
  return (player?.nick || player?.name || "Боец").slice(0, NICK_MAX);
}

/** Приводит карточку к нынешнему виду: у старых нет ни монет, ни оружия. */
function withDefaults(data){
  return {
    ...data,
    nick: data.nick || data.name || "Боец",
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
    // Первый ник — имя из мессенджера, обрезанное до читаемой длины. Дальше
    // человек меняет его сам в лобби.
    nick: (name || "Боец").slice(0, NICK_MAX),
    nickLower: (name || "Боец").slice(0, NICK_MAX).toLowerCase(),
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
 * Сменить игровой ник.
 *
 * Занятость проверяем запросом по nickLower — но именно ПРОВЕРЯЕМ, а не
 * гарантируем: между чтением и записью двое могут взять один ник, и без
 * транзакции на весь список этого не избежать. Совпавшие ники не ломают
 * ничего (человек всё равно узнаётся по тегу @), поэтому городить блокировки
 * ради такой мелочи не стоит — но сказать «занят», когда он очевидно занят,
 * дёшево и вежливо.
 */
export async function setNick(uid, player, wanted){
  const nick = String(wanted || "").trim().replace(/\s+/g, " ");

  if (nick.length < NICK_MIN) return { ok: false, reason: `Ник короче ${NICK_MIN} символов.` };
  if (nick.length > NICK_MAX) return { ok: false, reason: `Ник длиннее ${NICK_MAX} символов.` };
  if (/[<>@]/.test(nick)) return { ok: false, reason: "В нике нельзя < > и @ — @ путают с тегом." };
  if (nick === player.nick) return { ok: true, player };

  const lower = nick.toLowerCase();
  const taken = await getDocs(query(
    collection(db, "gamePlayers"), where("nickLower", "==", lower), limit(2)
  ));
  if (taken.docs.some(d => d.id !== uid)){
    return { ok: false, reason: "Такой ник уже занят. Возьми другой." };
  }

  await updateDoc(ref(uid), { nick, nickLower: lower });
  return { ok: true, player: { ...player, nick, nickLower: lower } };
}

/**
 * Найти игрока, чтобы позвать в друзья: по тегу @ или по нику.
 *
 * Тег надёжнее (он в мессенджере один на всех), ник — привычнее. Ищем и так и
 * так, точным совпадением без учёта регистра: поиск «по кусочку слова» в
 * Firestore без отдельной поисковой службы не делается, а городить её ради
 * списка друзей незачем.
 */
export async function findPlayers(text){
  const needle = String(text || "").trim().replace(/^@/, "").toLowerCase();
  if (needle.length < 2) return [];

  const players = collection(db, "gamePlayers");
  const [byTag, byNick] = await Promise.all([
    getDocs(query(players, where("tag", "==", needle), limit(5))).catch(() => ({ docs: [] })),
    getDocs(query(players, where("nickLower", "==", needle), limit(5))).catch(() => ({ docs: [] }))
  ]);

  const found = new Map();
  for (const d of [...byTag.docs, ...byNick.docs]){
    found.set(d.id, { uid: d.id, ...withDefaults(d.data()) });
  }
  return [...found.values()];
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

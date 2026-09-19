// lobby.js — экран между входом и боем: кто ты, во что играем, с кем.

import { isConfigured, hasRealtimeDb } from "./firebase.js";
import { resolvePlayer, forgetPlayer } from "./mypeal-auth.js";
import {
  ensurePlayer, buyWeapon, buyGear, setLoadout, setNick, findPlayers, displayName, NICK_MAX
} from "./profile.js";
import * as friends from "./friends.js";
import { MAP_LIST } from "./game/maps/index.js";
import { WEAPONS, WEAPON_ORDER, LOADOUT_SLOTS } from "./game/weapons.js";
import { GRENADES, GRENADE_ORDER } from "./game/grenades.js";
import { MODES, MODE_ORDER, SIDES, SIDE_ORDER, isTeamMode, modeName, modeShort } from "./game/modes.js";
import { MAX_PLAYERS, MYPEAL_ORIGIN } from "./config.js";
import { wakeSound, playPurchase, playClick, playDenied } from "./game/sound.js";
import * as net from "./net/live.js";
import { registerServiceWorker, wireInstallButton } from "./pwa.js";

const $ = id => document.getElementById(id);

let me = null;
let chosenMap = "karier";
let chosenMode = "dm";
// Сколько человек пускать. Двое — это «позвал друга», шестнадцать — свалка;
// MAX_PLAYERS из config.js остаётся значением по умолчанию.
const SIZES = [2, 4, 6, 8, 12, 16];
let chosenSize = SIZES.includes(MAX_PLAYERS) ? MAX_PLAYERS : 4;
let chosenPrivate = false;
// Сторона: пусто — «как получится», иначе «a» или «b». Выбор есть только в
// командных режимах, в свалке сторон не бывает.
let chosenSide = "";

// Друзья и присутствие живут подписками: и то и другое меняется само собой,
// пока человек смотрит на лобби.
let friendIds = [];
let friendCards = new Map();
let presence = [];
let requests = [];
let stopAnnounce = null;

registerServiceWorker();
wireInstallButton(document.getElementById("installBtn"));

boot().catch(error => say(error.message));

async function boot(){
  if (!isConfigured){ say("Ключи Firebase не вписаны — смотри js/config.js."); return; }

  const resolved = await resolvePlayer();
  if (!resolved.uid){ location.href = "index.html"; return; }

  const profile = await ensurePlayer(resolved.uid, resolved.fresh || {});
  me = { ...resolved, ...profile };

  $("who").textContent = displayName(profile);
  $("tag").textContent = profile.tag ? "@" + profile.tag : "";
  $("nickInput").value = displayName(profile);
  $("sPoints").textContent = profile.points ?? 0;
  $("sKills").textContent  = profile.kills ?? 0;
  $("sMatches").textContent = profile.matches ?? 0;
  $("sRatio").textContent = ratio(profile.kills, profile.deaths);

  renderMaps();
  renderModes();
  renderSizes();
  renderArmory();
  wire();

  if (!hasRealtimeDb){
    $("rtdbNote").classList.add("show");
    $("createBtn").disabled = true;
    $("joinBtn").disabled = true;
    return;
  }

  net.watchRooms(renderRooms);

  // Объявляем о себе: «в лобби». Без комнаты — значит, свободен и его можно
  // позвать; друзья увидят это у себя в списке.
  stopAnnounce = await net.announce(me.sessionUid, {
    uid: me.uid, nick: displayName(me), tag: me.tag || null, room: null
  });
  addEventListener("pagehide", () => stopAnnounce?.());

  net.watchPresence(rows => { presence = rows; renderFriends(); renderMainServer(); });
  friends.watchFriends(me.uid, async ids => {
    friendIds = ids;
    friendCards = await friends.loadCards(ids);
    renderFriends();
  });
  friends.watchRequests(me.uid, rows => { requests = rows; renderRequests(); });
}

const ratio = (k = 0, d = 0) => (d === 0 ? (k || 0).toFixed(2) : (k / d).toFixed(2));

function say(text, kind = "err"){
  const note = $("note");
  note.textContent = text;
  note.className = "note show " + kind;
}

// ---------------------------------------------------------------------------
// Выбор карты и режима
// ---------------------------------------------------------------------------

function renderMaps(){
  $("maps").innerHTML = "";
  for (const meta of MAP_LIST){
    const card = document.createElement("button");
    card.type = "button";
    card.className = "map-card" + (meta.id === chosenMap ? " on" : "");
    card.dataset.map = meta.id;
    card.innerHTML = `
      <span class="map-art ${meta.id}"></span>
      <b>${meta.name}</b>
      <i>${meta.subtitle}</i>`;
    card.onclick = () => {
      chosenMap = meta.id;
      renderMaps();
    };
    $("maps").append(card);
  }
}

function renderSizes(){
  const box = $("sizes");
  box.innerHTML = "";
  for (const n of SIZES){
    const button = document.createElement("button");
    button.type = "button";
    button.className = "size" + (n === chosenSize ? " on" : "");
    button.textContent = n;
    button.onclick = () => { chosenSize = n; playClick(); renderSizes(); };
    box.append(button);
  }
}

/** Режимы и выбор стороны — оба списка рисуются из modes.js, а не из вёрстки. */
function renderModes(){
  const box = $("modes");
  box.innerHTML = "";
  for (const id of MODE_ORDER){
    const mode = MODES[id];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode" + (id === chosenMode ? " on" : "");
    button.dataset.mode = id;
    button.innerHTML = `<b>${mode.name}</b><i>${mode.hint}</i>`;
    button.onclick = () => { chosenMode = id; playClick(); renderModes(); renderSides(); };
    box.append(button);
  }
  renderSides();
}

function renderSides(){
  const wrap = $("sidePick");
  wrap.hidden = !isTeamMode(chosenMode);
  if (wrap.hidden){ chosenSide = ""; return; }

  const box = $("sides");
  box.innerHTML = "";
  const options = [{ id: "", name: "Как получится", hint: "стороны наберутся поровну" },
    ...SIDE_ORDER.map(id => ({ id, name: SIDES[id].name, hint: SIDES[id].goal }))];

  for (const option of options){
    const button = document.createElement("button");
    button.type = "button";
    button.className = "side" + (option.id === chosenSide ? " on" : "") +
      (option.id ? " side-" + option.id : "");
    button.dataset.side = option.id || "auto";
    button.innerHTML = `<b>${option.name}</b><i>${option.hint}</i>`;
    button.onclick = () => { chosenSide = option.id; playClick(); renderSides(); };
    box.append(button);
  }
}

function wire(){
  $("mainServerBtn").onclick = enterMainServer;
  $("nickBtn").onclick = changeNick;
  $("nickInput").addEventListener("keydown", e => { if (e.key === "Enter") changeNick(); });
  $("findBtn").onclick = searchPeople;
  $("findInput").addEventListener("keydown", e => { if (e.key === "Enter") searchPeople(); });

  $("privInput").onchange = e => { chosenPrivate = e.target.checked; };

  $("createBtn").onclick = createRoom;
  $("joinBtn").onclick = joinByCode;
  $("outBtn").onclick = async () => {
    await forgetPlayer(me.sessionUid);
    location.href = "index.html";
  };
  $("mypealBtn").onclick = () => open(MYPEAL_ORIGIN, "_blank", "noopener");
  // Звук браузер разрешает только после действия человека, поэтому будим его
  // на первом же клике по странице — к матчу он уже готов.
  document.addEventListener("pointerdown", wakeSound, { once: true });
  $("codeInput").addEventListener("keydown", e => { if (e.key === "Enter") joinByCode(); });
}

// ---------------------------------------------------------------------------
// Оружейная
// ---------------------------------------------------------------------------

function shopSay(text, kind = "err"){
  const note = $("shopNote");
  note.textContent = text;
  note.className = "note show " + kind;
  clearTimeout(shopSay._timer);
  shopSay._timer = setTimeout(() => { note.className = "note"; }, 4000);
}

function renderArmory(){
  const box = $("weapons");
  box.innerHTML = "";
  $("sCoins").textContent = me.coins ?? 0;

  for (const id of WEAPON_ORDER){
    const w = WEAPONS[id];
    const owned = me.owned.includes(id);
    const inUse = me.loadout.includes(id);
    const slot = me.loadout.indexOf(id) + 1;

    const card = document.createElement("div");
    card.className = "weapon" + (owned ? " owned" : "") + (inUse ? " on" : "");
    card.innerHTML = `
      <div class="weapon-head">
        <b>${w.name}</b>
        ${inUse ? `<span class="slot">слот ${slot}</span>` : ""}
      </div>
      <i>${w.about}</i>
      <div class="bars">
        ${bar("урон", w.damage * w.pellets, 110)}
        ${bar("темп", w.rpm, 950)}
        ${bar("точность", 1 / (w.spread + 0.004), 220)}
        ${bar("запас", w.magazine, 100)}
      </div>
      <div class="weapon-foot"></div>`;

    const foot = card.querySelector(".weapon-foot");
    if (!owned){
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = w.price + " монет";
      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "btn btn-ghost";
      buy.textContent = "Купить";
      buy.disabled = (me.coins ?? 0) < w.price;
      buy.onclick = () => purchase(id);
      foot.append(price, buy);
    } else {
      const state = document.createElement("span");
      state.className = "price owned-mark";
      state.textContent = inUse ? "в бою" : "куплено";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "btn btn-ghost";
      pick.textContent = inUse ? "Убрать" : "В бой";
      pick.onclick = () => toggleSlot(id);
      foot.append(state, pick);
    }
    box.append(card);
  }

  renderGear();
}

/** Гранаты. Купил один раз — выдаются каждую жизнь, слотов не занимают. */
function renderGear(){
  const box = $("gear");
  box.innerHTML = "";

  for (const id of GRENADE_ORDER){
    const item = GRENADES[id];
    const has = me.owned.includes(id);

    const card = document.createElement("div");
    card.className = "weapon" + (has ? " owned" : "");
    card.dataset.gear = id;
    card.innerHTML = `
      <div class="weapon-head"><b>${item.name}</b></div>
      <i>${item.about}</i>
      <div class="weapon-foot"></div>`;

    const foot = card.querySelector(".weapon-foot");
    if (has){
      const state = document.createElement("span");
      state.className = "price owned-mark";
      state.textContent = "по одной за жизнь";
      foot.append(state);
    } else {
      const price = document.createElement("span");
      price.className = "price";
      price.textContent = item.price + " монет";
      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "btn btn-ghost";
      buy.textContent = "Купить";
      buy.disabled = (me.coins ?? 0) < item.price;
      buy.onclick = () => purchaseGear(id);
      foot.append(price, buy);
    }
    box.append(card);
  }
}

async function purchaseGear(id){
  try {
    const result = await buyGear(me.uid, me, id);
    if (!result.ok){ playDenied(); return shopSay(result.reason); }
    me = { ...me, ...result.player };
    playPurchase();
    shopSay(`${GRENADES[id].name} куплена. Выдаётся каждую жизнь.`, "ok");
    renderArmory();
  } catch (error){
    playDenied();
    shopSay("Не получилось купить: " + error.message);
  }
}

/** Полоска характеристики. Чисто на глаз: точные числа тут никому не нужны. */
function bar(label, value, max){
  const pct = Math.max(4, Math.min(100, Math.round(value / max * 100)));
  return `<div class="bar"><span>${label}</span><u><i style="width:${pct}%"></i></u></div>`;
}

async function purchase(id){
  const w = WEAPONS[id];
  try {
    const result = await buyWeapon(me.uid, me, id);
    if (!result.ok){ playDenied(); return shopSay(result.reason); }
    me = { ...me, ...result.player };
    playPurchase();
    shopSay(`${w.name} куплен. Нажми «В бой», чтобы взять его с собой.`, "ok");
    renderArmory();
  } catch (error){
    playDenied();
    shopSay("Не получилось купить: " + error.message);
  }
}

async function toggleSlot(id){
  let next;
  if (me.loadout.includes(id)){
    next = me.loadout.filter(x => x !== id);
    if (!next.length) { playDenied(); return shopSay("Нельзя идти в бой без оружия."); }
  } else if (me.loadout.length < LOADOUT_SLOTS){
    next = [...me.loadout, id];
  } else {
    // Слоты заняты — меняем второй, а не отказываем: отказ заставил бы сначала
    // что-то убирать, и это лишний клик на ровном месте.
    next = [me.loadout[0], id];
  }

  try {
    const result = await setLoadout(me.uid, me, next);
    if (!result.ok){ playDenied(); return shopSay(result.reason); }
    me = { ...me, ...result.player };
    playClick();
    renderArmory();
  } catch (error){
    playDenied();
    shopSay("Не получилось сохранить набор: " + error.message);
  }
}


// ---------------------------------------------------------------------------
// Позывной
// ---------------------------------------------------------------------------

function nickSay(text, kind = "err"){
  const note = $("nickNote");
  note.textContent = text;
  note.className = "note show " + kind;
  clearTimeout(nickSay._timer);
  nickSay._timer = setTimeout(() => { note.className = "note"; }, 4000);
}

async function changeNick(){
  const wanted = $("nickInput").value;
  $("nickBtn").disabled = true;
  try {
    const result = await setNick(me.uid, me, wanted);
    if (!result.ok){ playDenied(); return nickSay(result.reason); }
    me = { ...me, ...result.player };
    $("who").textContent = displayName(me);
    $("nickInput").value = displayName(me);
    // Присутствие пишется отдельно от карточки: список друзей должен показать
    // новый позывной сразу, а не когда человек в следующий раз зайдёт.
    net.updateAnnounce(me.sessionUid, { nick: displayName(me) });
    playClick();
    nickSay("Теперь ты " + displayName(me) + ".", "ok");
    renderFriends();
  } catch (error){
    playDenied();
    nickSay("Не получилось сменить: " + error.message);
  } finally {
    $("nickBtn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Друзья
// ---------------------------------------------------------------------------

function friendSay(text, kind = "err"){
  const note = $("friendNote");
  note.textContent = text;
  note.className = "note show " + kind;
  clearTimeout(friendSay._timer);
  friendSay._timer = setTimeout(() => { note.className = "note"; }, 5000);
}

/** Где человек сейчас — по записям присутствия, самой свежей из его вкладок. */
function whereIs(uid){
  let best = null;
  for (const row of presence){
    if (row.uid !== uid) continue;
    if (!best || (row.at || 0) > (best.at || 0)) best = row;
  }
  return best;
}

function mapName(id){
  return MAP_LIST.find(m => m.id === id)?.name || id || "";
}

async function searchPeople(){
  const text = $("findInput").value;
  if (String(text).trim().replace(/^@/, "").length < 2){
    return friendSay("Введи хотя бы два символа — тег @ или ник целиком.");
  }
  $("findBtn").disabled = true;
  $("findResult").innerHTML = `<p class="empty">Ищем…</p>`;
  try {
    const found = (await findPlayers(text)).filter(p => p.uid !== me.uid);
    if (!found.length){
      $("findResult").innerHTML =
        `<p class="empty">Никого. Ник и тег ищутся целиком, не по кусочку.</p>`;
      return;
    }
    $("findResult").innerHTML = "";
    for (const person of found) $("findResult").append(personRow(person, "find"));
  } catch (error){
    friendSay("Поиск не получился: " + error.message);
    $("findResult").innerHTML = "";
  } finally {
    $("findBtn").disabled = false;
  }
}

/**
 * Строчка человека. Одна и та же для находки, заявки и друга — меняется только
 * набор кнопок справа: так список читается как один список, а не три разных.
 */
function personRow(person, kind){
  const row = document.createElement("div");
  row.className = "person";

  const at = whereIs(person.uid);
  const online = !!at;
  const place = !at ? "не в игре"
    : at.room ? `${mapName(at.map)} · ${modeShort(at.mode)}`
    : "в лобби";

  row.innerHTML = `
    <span class="dot${online ? " on" : ""}"></span>
    <div class="person-who">
      <b>${escape(displayName(person))}</b>
      <i>${person.tag ? "@" + escape(person.tag) : ""}${person.tag && kind !== "find" ? " · " : ""}${kind === "find" ? "" : escape(place)}</i>
    </div>
    <div class="person-act"></div>`;

  const act = row.querySelector(".person-act");
  const button = (text, cls, onclick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-ghost tiny " + (cls || "");
    b.textContent = text;
    b.onclick = onclick;
    act.append(b);
    return b;
  };

  if (kind === "find"){
    if (friendIds.includes(person.uid)) act.innerHTML = `<span class="price owned-mark">уже друг</span>`;
    else button("Позвать", "", async () => {
      try {
        const result = await friends.invite({ ...me, nick: displayName(me) }, person);
        if (!result.ok) return friendSay(result.reason);
        playClick();
        friendSay(result.becameFriends
          ? `Вы уже звали друг друга — теперь друзья.`
          : `Позвал ${displayName(person)}. Ждём согласия.`, "ok");
        $("findResult").innerHTML = "";
        $("findInput").value = "";
      } catch (error){
        playDenied();
        friendSay("Не получилось позвать: " + error.message);
      }
    });
  }

  if (kind === "request"){
    button("Принять", "accept", async () => {
      await friends.accept(me, person.request).catch(() => {});
      playClick();
    });
    button("Отказать", "", async () => {
      await friends.dropRequest(me.uid, person.uid);
    });
  }

  if (kind === "friend"){
    // Зайти можно и в закрытую комнату: в этом и смысл дружбы.
    if (at?.room) button("Зайти", "go", () => enterRoom(at.room));
    button("Убрать", "", async () => {
      await friends.unfriend(me.uid, person.uid);
      playClick();
    });
  }

  return row;
}

function renderRequests(){
  const box = $("requests");
  $("requestsBox").hidden = requests.length === 0;
  box.innerHTML = "";
  for (const request of requests){
    box.append(personRow(
      { uid: request.from, nick: request.nick, tag: request.tag, request },
      "request"
    ));
  }
}

function renderFriends(){
  const box = $("friends");
  if (!friendIds.length){
    box.innerHTML = `<p class="empty">Друзей пока нет. Найди по тегу @ — он тот же, что в мессенджере.</p>`;
    return;
  }

  // Сначала те, кто в игре: список нужен, чтобы к кому-то пойти, а не чтобы
  // любоваться на список.
  const rows = friendIds
    .map(uid => friendCards.get(uid) || { uid, nick: "Боец" })
    .sort((a, b) => {
      const pa = whereIs(a.uid), pb = whereIs(b.uid);
      const wa = pa ? (pa.room ? 2 : 1) : 0;
      const wb = pb ? (pb.room ? 2 : 1) : 0;
      if (wa !== wb) return wb - wa;
      return displayName(a).localeCompare(displayName(b));
    });

  box.innerHTML = "";
  for (const person of rows) box.append(personRow(person, "friend"));
}

// ---------------------------------------------------------------------------
// Общий сервер
// ---------------------------------------------------------------------------

function renderMainServer(){
  const here = presence.filter(row => row.room === net.MAIN_ROOM).length;
  $("mainServerSeats").textContent = `${here} / ${net.MAIN.maxPlayers}`;
  $("mainServerLine").textContent =
    `Заминирование · террористы против спецназа `
    + `· каждые ${net.MAIN.mapsPerCycle} раундов новая карта`;
}

async function enterMainServer(){
  $("mainServerBtn").disabled = true;
  try {
    await net.ensureMainRoom();
    location.href = gameLink(net.MAIN_ROOM);
  } catch (error){
    say("Не получилось зайти на общий: " + error.message);
    $("mainServerBtn").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Комнаты
// ---------------------------------------------------------------------------

async function createRoom(){
  $("createBtn").disabled = true;
  try {
    const { id, code } = await net.createRoom({
      map: chosenMap,
      mode: chosenMode,
      hostUid: me.uid,
      hostSession: me.sessionUid,
      hostName: me.name,
      maxPlayers: chosenSize,
      priv: chosenPrivate
    });
    // Код закрытой комнаты нигде больше не показать — она не попадёт в список,
    // а человек уже уходит на страницу боя. Кладём его в адрес, чтобы игра
    // вывела его на табло, и запоминаем на случай, если человек вернётся.
    try { sessionStorage.setItem("zastava.lastCode", code); } catch { /* ignore */ }
    // Матч начинается сразу: ждать в пустой комнате скучнее, чем бегать по
    // карте одному в ожидании, пока подтянутся остальные.
    await net.setRoomState(id, net.ROOM_STATE.LIVE, { startedAt: Date.now() });
    location.href = gameLink(id);
  } catch (error){
    say("Не получилось создать комнату: " + error.message);
    $("createBtn").disabled = false;
  }
}

async function joinByCode(){
  const code = $("codeInput").value.trim().toUpperCase();
  if (code.length < 4) return say("Код комнаты — пять символов.");
  $("joinBtn").disabled = true;
  try {
    const id = await net.findRoomByCode(code);
    if (!id) return say("Комнаты с таким кодом нет. Может, она уже закрылась.");
    await enterRoom(id);
  } catch (error){
    say("Не получилось: " + error.message);
  } finally {
    $("joinBtn").disabled = false;
  }
}

/**
 * Вход в комнату с проверкой мест.
 *
 * Проверять здесь — не формальность: правила базы всё равно не дадут войти
 * лишнему, но отказ прилетел бы уже на странице боя, после загрузки карты, и
 * выглядел бы как поломка. Лучше сказать честно и сразу.
 */
async function enterRoom(id){
  const check = await net.roomCapacity(id);
  if (!check.ok){ playDenied(); return say(check.reason); }
  location.href = gameLink(id);
}

/** Адрес матча. Сторона едет в нём же — игра прочитает её при входе. */
function gameLink(id){
  return `game.html?room=${id}` + (chosenSide ? `&team=${chosenSide}` : "");
}

function renderRooms(rooms){
  const list = $("rooms");
  // Закрытые комнаты в списке не показываем — в этом и весь их смысл. Общий
  // сервер тоже: у него своя кнопка выше, и дублировать его строчкой в общем
  // списке значит показать одно и то же дважды.
  const open = rooms.filter(r =>
    r.state !== net.ROOM_STATE.OVER && !r.priv && r.id !== net.MAIN_ROOM);

  if (!open.length){
    list.innerHTML = `<p class="empty">Открытых комнат нет. Создай свою — код можно продиктовать или отправить ссылкой.</p>`;
    return;
  }

  list.innerHTML = "";
  for (const room of open){
    const card = document.createElement("div");
    card.className = "room";
    const mapName = MAP_LIST.find(m => m.id === room.map)?.name || room.map;
    const max = room.maxPlayers || 4;
    const busy = (room.count || 0) >= max;
    card.innerHTML = `
      <div>
        <b>${escape(room.hostName || "Боец")}</b>
        <i>${mapName} · ${modeName(room.mode).toLowerCase()}</i>
      </div>
      <span class="seats${busy ? " full" : ""}">${room.count || 0}/${max}</span>
      <span class="code">${room.code}</span>
      <button class="btn btn-ghost" type="button"${busy ? " disabled" : ""}>${busy ? "Полно" : "Войти"}</button>`;
    card.querySelector("button").onclick = () => enterRoom(room.id);
    list.append(card);
  }
}

function escape(text){
  return String(text ?? "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

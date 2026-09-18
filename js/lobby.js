// lobby.js — экран между входом и боем: кто ты, во что играем, с кем.

import { isConfigured, hasRealtimeDb } from "./firebase.js";
import { resolvePlayer, forgetPlayer } from "./mypeal-auth.js";
import { ensurePlayer, buyWeapon, setLoadout } from "./profile.js";
import { MAP_LIST } from "./game/maps/index.js";
import { WEAPONS, WEAPON_ORDER, LOADOUT_SLOTS } from "./game/weapons.js";
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

registerServiceWorker();
wireInstallButton(document.getElementById("installBtn"));

boot().catch(error => say(error.message));

async function boot(){
  if (!isConfigured){ say("Ключи Firebase не вписаны — смотри js/config.js."); return; }

  const resolved = await resolvePlayer();
  if (!resolved.uid){ location.href = "index.html"; return; }

  const profile = await ensurePlayer(resolved.uid, resolved.fresh || {});
  me = { ...resolved, ...profile };

  $("who").textContent = profile.name;
  $("tag").textContent = profile.tag ? "@" + profile.tag : "";
  $("sPoints").textContent = profile.points ?? 0;
  $("sKills").textContent  = profile.kills ?? 0;
  $("sMatches").textContent = profile.matches ?? 0;
  $("sRatio").textContent = ratio(profile.kills, profile.deaths);

  renderMaps();
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

function wire(){
  $("privInput").onchange = e => { chosenPrivate = e.target.checked; };

  for (const button of document.querySelectorAll("[data-mode]")){
    button.onclick = () => {
      chosenMode = button.dataset.mode;
      for (const other of document.querySelectorAll("[data-mode]")){
        other.classList.toggle("on", other === button);
      }
    };
  }

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
    location.href = `game.html?room=${id}`;
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
  location.href = `game.html?room=${id}`;
}

function renderRooms(rooms){
  const list = $("rooms");
  // Закрытые комнаты в списке не показываем — в этом и весь их смысл.
  const open = rooms.filter(r => r.state !== net.ROOM_STATE.OVER && !r.priv);

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
        <i>${mapName} · ${room.mode === "team" ? "команда на команду" : "каждый сам за себя"}</i>
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

// lobby.js — экран между входом и боем: кто ты, во что играем, с кем.

import { isConfigured, hasRealtimeDb } from "./firebase.js";
import { resolvePlayer, forgetPlayer } from "./mypeal-auth.js";
import { ensurePlayer } from "./profile.js";
import { MAP_LIST } from "./game/maps/index.js";
import { MAX_PLAYERS, MYPEAL_ORIGIN } from "./config.js";
import * as net from "./net/live.js";

const $ = id => document.getElementById(id);

let me = null;
let chosenMap = "karier";
let chosenMode = "dm";

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

function wire(){
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
  $("codeInput").addEventListener("keydown", e => { if (e.key === "Enter") joinByCode(); });
}

// ---------------------------------------------------------------------------
// Комнаты
// ---------------------------------------------------------------------------

async function createRoom(){
  $("createBtn").disabled = true;
  try {
    const { id } = await net.createRoom({
      map: chosenMap,
      mode: chosenMode,
      hostUid: me.uid,
      hostSession: me.sessionUid,
      hostName: me.name,
      maxPlayers: MAX_PLAYERS
    });
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
    location.href = `game.html?room=${id}`;
  } catch (error){
    say("Не получилось: " + error.message);
  } finally {
    $("joinBtn").disabled = false;
  }
}

function renderRooms(rooms){
  const list = $("rooms");
  const open = rooms.filter(r => r.state !== net.ROOM_STATE.OVER);

  if (!open.length){
    list.innerHTML = `<p class="empty">Открытых комнат нет. Создай свою — код можно продиктовать или отправить ссылкой.</p>`;
    return;
  }

  list.innerHTML = "";
  for (const room of open){
    const card = document.createElement("div");
    card.className = "room";
    const mapName = MAP_LIST.find(m => m.id === room.map)?.name || room.map;
    card.innerHTML = `
      <div>
        <b>${escape(room.hostName || "Боец")}</b>
        <i>${mapName} · ${room.mode === "team" ? "команда на команду" : "каждый сам за себя"}</i>
      </div>
      <span class="code">${room.code}</span>
      <button class="btn btn-ghost" type="button">Войти</button>`;
    card.querySelector("button").onclick = () => { location.href = `game.html?room=${room.id}`; };
    list.append(card);
  }
}

function escape(text){
  return String(text ?? "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// auth-screen.js — экран входа. Своей регистрации у игры нет вовсе: аккаунт
// один и тот же, что в мессенджере. Это не упрощение, а суть задумки — в бою
// тебя видят под тем же именем, под которым ты пишешь друзьям.

import { isConfigured } from "./firebase.js";
import { resolvePlayer, goToMyPeal } from "./mypeal-auth.js";
import { ensurePlayer } from "./profile.js";
import { MYPEAL_ORIGIN } from "./config.js";

const $ = id => document.getElementById(id);

function say(text, kind = "err"){
  const note = $("note");
  note.textContent = text;
  note.className = "note show " + kind;
}

if (!isConfigured){
  $("setup").classList.add("show");
  $("enterBtn").disabled = true;
  say("Ключи Firebase не вписаны — смотри подсказку ниже.");
} else {
  boot();
}

async function boot(){
  $("enterBtn").onclick = () => {
    $("enterBtn").disabled = true;
    $("enterBtn").textContent = "Открываю MyPeal…";
    goToMyPeal();
  };
  $("aboutBtn").onclick = () => open(MYPEAL_ORIGIN, "_blank", "noopener");

  try {
    const resolved = await resolvePlayer();

    if (!resolved.uid){
      // Обычный первый заход: показываем кнопку и ничего больше не делаем.
      $("gate").classList.add("ready");
      return;
    }

    // Либо вернулись с пропуском, либо эта вкладка уже входила раньше.
    const profile = await ensurePlayer(resolved.uid, resolved.fresh || {});
    $("gate").classList.add("ready");
    say(`Вход выполнен: ${profile.name}. Переходим в лобби…`, "ok");
    setTimeout(() => { location.href = "lobby.html"; }, 700);

  } catch (error){
    $("gate").classList.add("ready");
    $("enterBtn").disabled = false;
    $("enterBtn").textContent = "Войти через MyPeal";
    say(error.message);
  }
}

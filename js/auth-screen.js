// auth-screen.js — вся логика страницы входа: вкладки, форма, Google, лобби.

import { auth, isConfigured } from "./firebase.js";
import { ensureProfile }      from "./profile.js";
import { explain }            from "./errors.js";

import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, updateProfile,
  onAuthStateChanged, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const $ = id => document.getElementById(id);
const note = $("note");

const say = (text, kind = "err") => {
  note.textContent = text;
  note.className = "note show " + kind;
};
const clearNote = () => { note.className = "note"; };

/* ---------- конфиг не заполнен: показываем подсказку и дальше не идём ---------- */
if (!isConfigured){
  $("setup").classList.add("show");
  $("submitBtn").disabled = true;
  $("googleBtn").disabled = true;
  say("Ключи Firebase не вписаны — смотри подсказку ниже.");
  throw new Error("firebaseConfig пустой");
}

/* ---------- вкладки: вход / регистрация ---------- */
let mode = "in";

function setMode(next){
  mode = next;
  const up = mode === "up";

  $("tabIn").setAttribute("aria-selected", String(!up));
  $("tabUp").setAttribute("aria-selected", String(up));

  $("nickField").hidden   = !up;
  $("nick").required      = up;
  $("submitBtn").textContent = up ? "Создать аккаунт" : "Войти";
  $("pass").autocomplete  = up ? "new-password" : "current-password";
  $("resetBtn").hidden    = up;

  clearNote();
}

$("tabIn").onclick = () => setMode("in");
$("tabUp").onclick = () => setMode("up");

/* ---------- отправка формы ---------- */
$("form").addEventListener("submit", async event => {
  event.preventDefault();

  const email = $("email").value.trim();
  const pass  = $("pass").value;
  const nick  = $("nick").value.trim();

  if (mode === "up" && nick.length < 2){
    return say("Позывной — минимум 2 символа.");
  }

  $("submitBtn").disabled = true;
  clearNote();

  try {
    if (mode === "up"){
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: nick });
      await ensureProfile(cred.user, nick);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (error){
    say(explain(error));
  } finally {
    $("submitBtn").disabled = false;
  }
});

/* ---------- вход через Google ---------- */
$("googleBtn").onclick = async () => {
  clearNote();
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await ensureProfile(cred.user);
  } catch (error){
    say(explain(error));
  }
};

/* ---------- сброс пароля ---------- */
$("resetBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) return say("Впиши почту в поле выше, туда придёт ссылка.");

  try {
    await sendPasswordResetEmail(auth, email);
    say("Ссылка для нового пароля ушла на " + email, "ok");
  } catch (error){
    say(explain(error));
  }
};

/* ---------- выход ---------- */
$("outBtn").onclick = () => signOut(auth);

/* ---------- реакция на вход и выход ---------- */
onAuthStateChanged(auth, async user => {
  const tabs  = $("tabs");
  const form  = $("form");
  const lobby = $("lobby");

  if (!user){
    tabs.classList.remove("hide");
    form.classList.remove("hide");
    lobby.classList.remove("show");
    return;
  }

  try {
    const p = await ensureProfile(user);

    $("hello").textContent   = p.nickname;
    $("mail").textContent    = user.email || "вход через Google";
    $("sPoints").textContent = p.points;
    $("sKills").textContent  = p.kills;
    $("sCases").textContent  = p.cases;

    tabs.classList.add("hide");
    form.classList.add("hide");
    lobby.classList.add("show");
  } catch (error){
    say(explain(error));
  }
});

setMode("in");

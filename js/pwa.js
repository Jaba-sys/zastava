// pwa.js — установка «Заставы» на телефон и офлайновый запуск.
//
// Две разные вещи, которые обычно путают:
//
//   1. Регистрация служебного работника (sw.js). Она нужна всегда: без неё
//      игра каждый раз тянет весь код заново, а браузер вообще не предлагает
//      её установить.
//   2. Кнопка «Установить». Она появляется ТОЛЬКО там, где браузер сам решил,
//      что установка возможна, и прислал событие beforeinstallprompt — это
//      Chrome на Android и на компьютере. В Safari на iPhone такого события
//      нет и быть не может: там установка делается вручную через «Поделиться →
//      На экран „Домой“», и единственное, что мы можем, — честно это написать.
//
// Отсюда правило, которому здесь всё подчинено: кнопку показываем, только если
// она РАБОТАЕТ. Кнопка «Установить», которая при нажатии говорит «а вы сделайте
// сами вот эти шесть шагов», хуже, чем отсутствие кнопки.

let deferred = null;
const listeners = new Set();

export function registerServiceWorker(){
  if (!("serviceWorker" in navigator)) return;
  // Регистрируем после загрузки страницы: во время неё браузер и так занят
  // разбором игры, а работник нужен не раньше следующего запуска.
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Открыли по file:// или без https — установка не заработает, но игра
      // от этого не ломается, поэтому молчим.
    });
  });
}

/** Уже запущено как приложение, а не вкладкой браузера? */
export function isInstalled(){
  return matchMedia("(display-mode: standalone)").matches
      || matchMedia("(display-mode: fullscreen)").matches
      || navigator.standalone === true;
}

export function isIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
      // iPadOS с 13-й версии представляется настольным Safari, отличить его
      // можно только по тому, что у «Макинтоша» вдруг появился сенсорный ввод.
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

addEventListener("beforeinstallprompt", event => {
  // Браузер спрашивает разрешения показать своё окно установки. Перехватываем,
  // чтобы предложить установку в своём месте и в свой момент.
  event.preventDefault();
  deferred = event;
  for (const fn of listeners) fn(true);
});

addEventListener("appinstalled", () => {
  deferred = null;
  for (const fn of listeners) fn(false);
});

export function canInstall(){ return !!deferred; }

/** Сообщить, когда установка станет (или перестанет быть) возможной. */
export function onInstallable(fn){
  listeners.add(fn);
  fn(canInstall());
  return () => listeners.delete(fn);
}

/**
 * Показать окно установки. Возвращает "accepted", "dismissed" или "unavailable".
 * Событие одноразовое: после показа браузер его не повторяет, поэтому ссылку
 * сбрасываем в любом случае.
 */
export async function promptInstall(){
  if (!deferred) return "unavailable";
  const event = deferred;
  deferred = null;
  for (const fn of listeners) fn(false);
  try {
    event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "dismissed";
  }
}

/**
 * Привязать кнопку установки. Кнопка прячется, если установить нельзя, —
 * кроме iPhone, где вместо неё показывается ссылка на инструкцию.
 */
export function wireInstallButton(button, { instructionsHref = "install.html" } = {}){
  if (!button) return;

  if (isInstalled()){ button.hidden = true; return; }

  if (isIOS()){
    button.hidden = false;
    button.textContent = "Как поставить на iPhone";
    button.onclick = () => { location.href = instructionsHref; };
    return;
  }

  onInstallable(ready => { button.hidden = !ready; });
  button.onclick = async () => {
    const outcome = await promptInstall();
    if (outcome === "unavailable") location.href = instructionsHref;
  };
}

// ---------------------------------------------------------------------------
// Тема оформления MyPeal: тёмная (по умолчанию), светлая и «как в системе».
//
// Хранится в localStorage, а не в профиле Firestore, и это осознанно:
//   * тема нужна ДО того, как приложение узнает, кто вошёл (иначе на экране
//     входа и на загрузке всегда мигала бы тёмная);
//   * телефон и ноутбук — разные условия (ночью в кровати и днём на улице),
//     и одна и та же тема на всех устройствах сразу скорее мешает;
//   * это не данные аккаунта, терять их не страшно.
//
// Применяется установкой атрибута data-theme="light" на <html> — все цвета
// живут в переменных :root / :root[data-theme="light"] в app.css.
// Ровно та же логика продублирована маленьким инлайновым скриптом в
// index.html: он выполняется до первой отрисовки, иначе при каждом открытии
// светлая тема на долю секунды показывалась бы тёмной ("вспышка темы").
// ---------------------------------------------------------------------------

const STORAGE_KEY = "mypeal.theme";
// Ключи из прежних названий приложения. Читаем их, если нового ещё нет:
// иначе после переименования у всех разом сбрасывался бы выбор темы, и
// человек, который специально поставил светлую, снова получил бы тёмную.
const LEGACY_KEYS = ["mayak.theme"];

export const THEME_OPTIONS = ["system", "light", "dark"];

const listeners = new Set();

function mediaQuery() {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: light)");
}

/** Что выбрал пользователь: "system" | "light" | "dark". */
export function getThemePreference() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (THEME_OPTIONS.includes(saved)) return saved;
    for (const key of LEGACY_KEYS) {
      const legacy = localStorage.getItem(key);
      if (!THEME_OPTIONS.includes(legacy)) continue;
      // Переносим под новый ключ, чтобы читать старый пришлось только раз.
      localStorage.setItem(STORAGE_KEY, legacy);
      localStorage.removeItem(key);
      return legacy;
    }
  } catch {
    /* приватный режим / отключённое хранилище — просто системная тема */
  }
  return "system";
}

/** Какая тема реально показывается сейчас: "light" | "dark". */
export function resolveTheme(preference = getThemePreference()) {
  if (preference === "light" || preference === "dark") return preference;
  const mq = mediaQuery();
  return mq && mq.matches ? "light" : "dark";
}

function paint(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  // Подчищаем inline-фон на <html>, если он остался от старой версии
  // index.html (она задавала цвет страницы именно так). Inline-стиль
  // перебивает app.css и не менялся при смене темы — тёмная тема тогда
  // оставляла светлый фон по краям страницы. Теперь цвет задаётся обычным
  // правилом в <style>, а эта строка нужна тем, у кого закеширован старый
  // index.html.
  if (root.style.background) root.style.removeProperty("background");
  // Цвет системной панели в PWA/мобильных браузерах — иначе в светлой теме
  // сверху остаётся тёмная полоса от тёмного манифеста.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f5f2ee" : "#16161a");
}

/** Сменить тему и сразу применить её. */
export function setThemePreference(preference) {
  const next = THEME_OPTIONS.includes(preference) ? preference : "system";
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* не сохранилось — тема всё равно применится до перезагрузки */
  }
  paint(resolveTheme(next));
  listeners.forEach((fn) => fn(next));
}

/**
 * Подписка на смену темы (нужна настройкам, чтобы подсветить активную кнопку,
 * и режиму "как в системе", который меняется без участия приложения).
 * Возвращает функцию отписки.
 */
export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Вызывается один раз при старте (main.jsx). Применяет сохранённую тему и
 * начинает следить за системной — на случай режима "как в системе": на
 * телефоне тема может переключиться по расписанию прямо при открытом
 * приложении.
 */
export function initTheme() {
  paint(resolveTheme());
  const mq = mediaQuery();
  if (!mq) return () => {};
  const onChange = () => {
    if (getThemePreference() !== "system") return;
    paint(resolveTheme("system"));
    listeners.forEach((fn) => fn("system"));
  };
  // Safari младше 14 знает только устаревший addListener.
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
  return () => {
    if (mq.removeEventListener) mq.removeEventListener("change", onChange);
    else if (mq.removeListener) mq.removeListener(onChange);
  };
}

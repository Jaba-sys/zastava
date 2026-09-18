// Показ системного (браузерного/ОС) уведомления о новом сообщении —
// работает без сервера и без email, прямо через встроенный в браузер
// Notification API. Ограничение: сообщение придёт, только пока эта вкладка
// MyPeal открыта в браузере (даже свёрнута или в фоне, на другой вкладке
// или мониторе) — если браузер/вкладка полностью закрыты или телефон
// выключен, уведомление показать некому (для этого нужен push-сервис с
// собственным сервером, а приложение работает на бесплатном Firebase-плане
// без Cloud Functions).

export function isNotificationSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

// "granted" | "denied" | "default" | "unsupported"
export function getNotificationPermission() {
  return isNotificationSupported() ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showMessageNotification({ title, body, tag, chatId }) {
  if (!isNotificationSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      icon: "/favicon.svg",
      tag,
    });
    n.onclick = () => {
      window.focus();
      window.location.href = `${window.location.origin}/chat/${chatId}`;
      n.close();
    };
  } catch {
    // некоторые мобильные браузеры не поддерживают конструктор Notification
    // напрямую (нужен Service Worker) — тихо игнорируем, это необязательная
    // "приятная добавка", а не критичная функция
  }
}

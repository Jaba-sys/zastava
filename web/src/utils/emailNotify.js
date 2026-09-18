// Email-уведомления через EmailJS (emailjs.com) — на бесплатном Firebase
// Spark-плане нет своего сервера, который сам, в фоне, заметил бы новое
// сообщение или звонок и отправил письмо. EmailJS решает это без бэкенда —
// письмо шлёт браузер ТОГО, КТО написал/позвонил, прямо в момент действия —
// получателю при этом не обязательно быть онлайн, письмо всё равно уйдёт.
//
// Как и ключи Firebase (см. firebase.js) и TURN (см. webrtcConfig.js),
// SERVICE_ID/TEMPLATE_ID/PUBLIC_KEY не хранятся прямо в коде (репозиторий
// публичный на GitHub), а подставляются на этапе сборки через переменные
// окружения GitHub Actions (Settings -> Secrets -> Actions в репозитории).
// Если секреты не заданы, функции ниже — осознанный no-op.
//
// Шаблон письма в личном кабинете EmailJS ("Contact Us", переименован под
// MyPeal) использует переменные (в фигурных скобках): {{to_email}},
// {{from_name}}, {{subject_line}}, {{message_line}}, {{reply_link}}.
// message_line теперь содержит ГОТОВЫЙ, полностью отформатированный текст
// письма (см. buildMessageBlock ниже) — сам видимый макет ("--------------------",
// "Вам написал:", "Сообщение:", "Ответить:") задаётся здесь, в коде, а НЕ в
// теле шаблона EmailJS, чтобы результат не зависел от того, что именно
// настроено в личном кабинете. Поэтому в самом теле шаблона EmailJS должно
// быть просто {{message_line}} (без своего дополнительного обрамления —
// иначе оно продублирует уже готовый текст).
import emailjs from "@emailjs/browser";

const SERVICE_ID = import.meta.env.VITE_EMAILJS_SERVICE_ID || ""; // EmailJS -> Email Services (Gmail: sop3chit.xpol.viva0@gmail.com)
const TEMPLATE_ID = import.meta.env.VITE_EMAILJS_TEMPLATE_ID || ""; // EmailJS -> Email Templates -> Contact Us
const PUBLIC_KEY = import.meta.env.VITE_EMAILJS_PUBLIC_KEY || ""; // EmailJS -> Account -> General -> API keys

export const EMAIL_CONFIGURED = Boolean(SERVICE_ID && TEMPLATE_ID && PUBLIC_KEY);

const APP_URL = "https://mypeal.web.app";
const PREVIEW_MAX_CHARS = 200;
const SEPARATOR = "--------------------";

// Письмо — это такое же уведомление, как всплывашка в браузере, поэтому и
// глушиться оно должно теми же двумя тумблерами: общим "не уведомлять меня"
// (SettingsView.jsx -> users/{uid}.notificationsMuted) и "без звука" на
// конкретном чате (ChatWindow.jsx -> chats/{id}.mutedFor.{uid}). Ровно эти же
// две проверки делает hooks/useMessageNotifications.js для push-уведомлений.
//
// Тонкость: письмо отправляет браузер ТОГО, КТО пишет или звонит, поэтому
// смотреть надо в настройки ПОЛУЧАТЕЛЯ — его профиль и его ключ в mutedFor,
// а не свои. Раньше про это забывали в звонках, и человек с выключенными
// уведомлениями всё равно получал письма "вам звонят".
export function emailNotificationsOff(recipient, chat, recipientUid) {
  if (!recipient) return true;
  if (recipient.notificationsMuted === true) return true;
  if (recipientUid && chat && chat.mutedFor && chat.mutedFor[recipientUid]) return true;
  return false;
}

function send(params) {
  if (!EMAIL_CONFIGURED) return Promise.resolve(false);
  return emailjs
    .send(SERVICE_ID, TEMPLATE_ID, params, { publicKey: PUBLIC_KEY })
    .then(() => true)
    .catch(() => false); // сбой почтового сервиса не должен ронять остальной интерфейс
}

// Единый вид тела письма — рамка из разделителей, строка "от кого",
// строка с сутью события и ссылка "Ответить" внизу. Используется и для
// нового сообщения, и для обоих писем о звонке — только вторая строка и
// текст ссылки отличаются по смыслу события.
function buildMessageBlock(fromLine, bodyLine, replyLink) {
  return [SEPARATOR, fromLine, bodyLine, SEPARATOR, `Ответить: "${replyLink}"`].join("\n");
}

// "Вам пишет такой-то" — вызывается ТОЛЬКО если получатель сейчас не в
// сети (см. utils/presence.js -> isOnline), чтобы не расходовать
// ограниченный бесплатный лимит писем впустую, пока оба и так активно
// переписываются в приложении.
export function notifyNewMessage({ toEmail, fromName, preview, chatId }) {
  if (!toEmail || !chatId) return Promise.resolve(false);
  const trimmed = (preview || "").slice(0, PREVIEW_MAX_CHARS);
  const from = fromName || "Кто-то";
  const replyLink = `${APP_URL}/chat/${chatId}`;
  return send({
    to_email: toEmail,
    from_name: from,
    subject_line: `${from} пишет вам в MyPeal`,
    message_line: buildMessageBlock(`Вам написал:"${from}"`, `Сообщение: "${trimmed}"`, replyLink),
    reply_link: replyLink,
  });
}

// "Вам звонят" — вызывается СРАЗУ, как только звонок начал набираться
// (статус 'ringing', см. contexts/CallContext.jsx -> startCall), если
// получатель сейчас не в сети. Отдельное письмо от notifyMissedCall ниже:
// это первое из двух, про сам факт звонка, ещё до того, как известно,
// ответят на него или нет.
export function notifyCallRinging({ toEmail, fromName, chatId }) {
  if (!toEmail || !chatId) return Promise.resolve(false);
  const from = fromName || "Кто-то";
  const replyLink = `${APP_URL}/chat/${chatId}`;
  return send({
    to_email: toEmail,
    from_name: from,
    subject_line: `${from} звонит вам в MyPeal`,
    message_line: buildMessageBlock(`Вам звонит:"${from}"`, `${from} пытается до вас дозвониться.`, replyLink),
    reply_link: replyLink,
  });
}

// "Пропущенный звонок" — второе письмо, вызывается, когда звонок ушёл в
// 'missed' (получатель не ответил за время звонка, см. CallContext.jsx ->
// RING_TIMEOUT_MS и hangUp с wasRingingOut). Реальный live-звонок к этому
// моменту уже закончился (сигнализация работает только пока оба на сайте),
// поэтому ссылка ведёт не "подключиться к звонку", а в чат — перезвонить.
export function notifyMissedCall({ toEmail, fromName, chatId }) {
  if (!toEmail || !chatId) return Promise.resolve(false);
  const from = fromName || "Кто-то";
  const replyLink = `${APP_URL}/chat/${chatId}`;
  return send({
    to_email: toEmail,
    from_name: from,
    subject_line: `Пропущенный звонок от ${from} в MyPeal`,
    message_line: buildMessageBlock(`Вам звонил(а):"${from}"`, `Вы пропустили звонок от ${from}.`, replyLink),
    reply_link: replyLink,
  });
}

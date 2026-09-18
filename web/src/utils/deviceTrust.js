import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { sendSystemNotification } from "./systemChat";

// "Это вы или вас взломали?" — вход в аккаунт с незнакомого устройства
// (браузера) требует подтверждения с уже доверенного устройства, прежде чем
// на новом откроется сам чат. Как и весь остальной проект — клиент-
// доверительная модель без бэкенда: Firebase Auth по-прежнему пускает по
// одним логину/паролю с любого устройства, это лишь дополнительный слой
// ОСВЕДОМЛЕНИЯ владельца аккаунта и способ быстро прервать доступ, если
// вход подозрительный, а не непробиваемая защита (см. firestore.rules).
//
// "Устройство" здесь — конкретный браузер: id генерируется один раз и
// хранится в localStorage, поэтому очистка данных сайта или приватный режим
// снова покажутся новым устройством — приемлемый компромисс той же модели.
const DEVICE_ID_KEY = "mymessage_device_id";

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — считаем каждый
    // заход новым устройством: не критично, просто будет чаще спрашивать
    // подтверждение.
    return "no-storage-" + Math.random().toString(36).slice(2);
  }
}

// Грубое, но достаточное для узнаваемости в уведомлении "Это вы?" описание
// устройства — не для безопасности, только чтобы владелец аккаунта понял,
// о каком именно входе идёт речь ("Chrome, Windows" и т.п.).
export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const isMobile = /Mobi|Android|iPhone|iPad/.test(ua);
  let os = "устройство";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS/.test(ua)) os = "Mac";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "браузер";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return `${browser}, ${os}${isMobile ? " (моб.)" : ""}`;
}

export function approvalDocId(uid, deviceId) {
  return `${uid}_${deviceId}`;
}

// Создаёт (или пересоздаёт после блокировки/повторной попытки) заявку на
// подтверждение входа с этого устройства и шлёт уведомление в СОБСТВЕННЫЕ
// "Системные сообщения" — оно появится на всех уже доверенных устройствах
// этого же аккаунта благодаря их живому подключению к тому же чату (см.
// ChatWindow.jsx -> DeviceApprovalMessage).
// Анти-абьюз: не более одного АККАУНТА с одного устройства/браузера (см.
// firestore.rules -> deviceRegistrations/{deviceId}) — иначе легко
// наштамповать десятки аккаунтов подряд ради бонусных звёзд (например
// claimFirstFriendBonus, см. utils/stars.js). Использует тот же deviceId,
// что и подтверждение входа "Это вы?" выше — то же самое "устройство" в
// понимании проекта (конкретный браузер, а не физическое железо).
//
// Бросает исключение (permission-denied), если документ с этим deviceId уже
// создан ДРУГИМ аккаунтом — правила запрещают повторно писать в уже
// существующий документ (allow update: if false). Register.jsx должен в
// этом случае откатить только что созданный Auth-аккаунт.
export async function claimDeviceForAccount(uid) {
  const deviceId = getDeviceId();
  try {
    await setDoc(doc(db, "deviceRegistrations", deviceId), {
      uid,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    // Документ уже существует. Если он наш же (повторный вызов — например,
    // ключ при регистрации не подошёл и человек пошёл обычным путём через
    // письмо), это не занятое устройство, а просто уже сделанный claim:
    // читаем документ — правила разрешают чтение ТОЛЬКО своего
    // (resource.data.uid == request.auth.uid), поэтому успешное чтение и
    // есть доказательство, что устройство наше. Иначе — устройство
    // действительно занято другим аккаунтом, пробрасываем ошибку дальше.
    const snap = await getDoc(doc(db, "deviceRegistrations", deviceId));
    if (!snap.exists() || snap.data().uid !== uid) throw err;
  }
}

// Освобождает "занятое" этим аккаунтом устройство — нужно ровно в одном
// случае: аккаунт так и не подтвердил почту и удаляется целиком (см.
// utils/pendingAccounts.js). Иначе брошенная регистрация навсегда сожгла бы
// браузер: документ остался бы с несуществующим uid, а новый аккаунт с
// этого браузера создать было бы уже нельзя.
//
// Правила Firestore разрешают такое удаление только пока у аккаунта НЕТ
// профиля users/{uid} (см. firestore.rules -> deviceRegistrations/{deviceId}
// delete) — то есть именно неподтверждённому аккаунту. Полноценный
// (подтверждённый) пользователь снять свою отметку не может, поэтому
// анти-абьюз "один аккаунт на браузер" остаётся в силе.
export async function releaseDeviceClaim(uid) {
  const deviceId = getDeviceId();
  try {
    const ref = doc(db, "deviceRegistrations", deviceId);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().uid === uid) {
      await deleteDoc(ref);
    }
  } catch {
    // не наш документ или правила не дали — ничего страшного, в худшем
    // случае отметка останется и этот браузер больше не сможет
    // зарегистрировать аккаунт (снимается админом вручную)
  }
}

export async function requestDeviceApproval(uid, deviceId) {
  const id = approvalDocId(uid, deviceId);
  const label = deviceLabel();
  await setDoc(doc(db, "deviceApprovals", id), {
    uid,
    deviceId,
    deviceLabel: label,
    status: "pending",
    createdAt: serverTimestamp(),
  });
  await sendSystemNotification(uid, {
    type: "device_login_request",
    text: `🔐 Кто-то входит в аккаунт с нового устройства (${label}) — это вы?`,
    actorUid: uid,
    fromName: label,
    refId: id,
  });
  return id;
}

import { collection, doc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "../firebase";

// Ключи, обходящие ожидание письма-подтверждения ПРИ РЕГИСТРАЦИИ (см.
// firestore.rules -> users/{uid} create + emailKeys/{code}, Register.jsx).
// Администратор заранее выпускает ключ под конкретный email в консоли
// (AdminPanel.jsx) и передаёт его человеку вне системы (просто текстом).
// При регистрации с ТЕМ ЖЕ email ключ можно вставить в отдельное поле —
// тогда аккаунт сразу создаётся подтверждённым (verified:true), минуя
// sendEmailVerification и экран /verify. Ключ одноразовый (used) и его
// можно отозвать (active) — тот же паттерн, что и botKeys/{code} у ботов
// (см. utils/botKeys.js).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих друг на друга символов (0/O, 1/I)

// Один сплошной блок без разделителей — сознательно без дефисов (см.
// обсуждение с пользователем: дефисы в поле ввода сбивали с толку —
// непонятно, ставить их самому или нет). Просто длинная строка, которую
// можно скопировать/вставить целиком.
function randomKey(len = 16) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

// Возможные варианты id документа для введённого человеком кода. Ключи,
// выпущенные ДО этого изменения, хранятся в Firestore с дефисами прямо в id
// документа (формат XXXX-XXXX-XXXX-XXXX) — если их сейчас "очистить" от
// дефисов, id перестанет совпадать с уже существующим документом. Поэтому
// пробуем СНАЧАЛА код ровно как его ввели (только trim + верхний регистр —
// это совпадёт со старыми ключами), и только если это не сработало —
// вариант без разделителей вообще (новый формат, см. randomKey() выше,
// а также опечатки/лишние пробелы).
function candidateCodes(raw) {
  const asTyped = String(raw || "").trim().toUpperCase();
  const stripped = asTyped.replace(/[^A-Z0-9]/g, "");
  return asTyped === stripped ? [asTyped] : [asTyped, stripped];
}

// --- Админ: создать/отозвать/список (см. AdminPanel.jsx -> emailkey ...) ---

export async function createEmailKey(email) {
  const clean = String(email || "").trim().toLowerCase();
  const code = randomKey();
  await setDoc(doc(db, "emailKeys", code), {
    email: clean,
    active: true,
    used: false,
    createdAt: new Date(),
  });
  return code;
}

export async function revokeEmailKey(code) {
  const candidates = candidateCodes(code);
  let lastErr;
  for (const c of candidates) {
    try {
      await updateDoc(doc(db, "emailKeys", c), { active: false });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function reactivateEmailKey(code) {
  const candidates = candidateCodes(code);
  let lastErr;
  for (const c of candidates) {
    try {
      await updateDoc(doc(db, "emailKeys", c), { active: true });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function listEmailKeys(emailFilter) {
  const snap = await getDocs(collection(db, "emailKeys"));
  const all = snap.docs.map((d) => ({ code: d.id, ...d.data() }));
  if (!emailFilter) return all;
  const f = emailFilter.trim().toLowerCase();
  return all.filter((k) => k.email === f);
}

// --- Регистрация: погашение ключа (см. Register.jsx) ---

// Создаёт профиль пользователя СРАЗУ подтверждённым (verified:true) и
// одновременно (одной атомарной пачкой) помечает ключ использованным —
// либо обе записи проходят, либо ни одной (см. firestore.rules —
// users/{uid} create требует emailKeyCode ровно из этого же запроса,
// emailKeys/{code} update требует активный неиспользованный ключ на ТОТ ЖЕ
// email, что и в auth-токене вызывающего). Если код неверный/чужой/уже
// использован/отозван — правила Firestore отклонят всю пачку целиком,
// вызывающий код (Register.jsx) в этом случае просто продолжает обычной
// регистрацией без ключа.
export async function redeemEmailKeyOnRegister(uid, email, code) {
  const candidates = candidateCodes(code).filter(Boolean);
  if (!candidates.length) return false;
  let lastErr;
  for (const clean of candidates) {
    // Новый batch на КАЖДУЮ попытку — использованный (закоммиченный или
    // упавший) writeBatch повторно применить нельзя.
    const batch = writeBatch(db);
    batch.set(doc(db, "users", uid), {
      email,
      verified: true,
      isAdmin: false,
      banned: false,
      profileComplete: false,
      tag: null,
      language: null,
      createdAt: serverTimestamp(),
      emailKeyCode: clean,
    });
    batch.update(doc(db, "emailKeys", clean), { used: true });
    try {
      await batch.commit();
      return true;
    } catch (err) {
      lastErr = err;
    }
  }
  // Ни один вариант кода не подошёл (неверный/чужой/использован/отозван) —
  // вызывающий код (Register.jsx) в этом случае просто продолжает обычной
  // регистрацией без ключа.
  void lastErr;
  return false;
}

// --- Экран /verify: погашение ключа для УЖЕ созданного, но ещё не
// подтверждённого аккаунта (см. VerifyEmail.jsx) ---

// Тот же ключ, что и при регистрации, но применённый уже на экране /verify —
// человек успел зарегистрироваться (и получить письмо) ДО того, как ввёл
// ключ, или первая попытка ключа не подошла.
//
// Профиля в базе при обычной регистрации ещё НЕТ (он создаётся только после
// подтверждения почты, см. VerifyEmail.jsx и pendingAccounts.js), поэтому по
// умолчанию здесь именно СОЗДАНИЕ документа — ровно как в
// redeemEmailKeyOnRegister выше (см. firestore.rules -> users/{uid} create,
// ветка emailKeyCode). Если профиль всё-таки существует (старый аккаунт,
// оставшийся с verified:false ещё с прежней схемы), передаётся
// profileExists:true и делается обычный update (ветка update в тех же
// правилах).
export async function redeemEmailKeyOnVerify(uid, code, { email, profileExists } = {}) {
  const candidates = candidateCodes(code).filter(Boolean);
  if (!candidates.length) return false;
  for (const clean of candidates) {
    const batch = writeBatch(db);
    if (profileExists) {
      batch.update(doc(db, "users", uid), { verified: true, emailKeyCode: clean });
    } else {
      batch.set(doc(db, "users", uid), {
        email,
        verified: true,
        isAdmin: false,
        banned: false,
        profileComplete: false,
        tag: null,
        language: null,
        createdAt: serverTimestamp(),
        emailKeyCode: clean,
      });
    }
    batch.update(doc(db, "emailKeys", clean), { used: true });
    try {
      await batch.commit();
      return true;
    } catch {
      // пробуем следующий вариант кода (см. candidateCodes)
    }
  }
  return false;
}

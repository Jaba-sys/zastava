import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sendEmailVerification } from "firebase/auth";
import { doc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { friendlyAuthError } from "../utils/authErrors";
import { redeemEmailKeyOnVerify } from "../utils/emailKeys";
import { claimDeviceForAccount } from "../utils/deviceTrust";
import { deleteUnverifiedAccount } from "../utils/pendingAccounts";
import { useLanguage } from "../i18n/LanguageContext";

const RESEND_COOLDOWN = 60; // секунд между повторными отправками письма
const LEAVE_WAIT_MS = 4000; // сколько ждём параллельную автопроверку при отмене регистрации

// Подтверждение почты через ссылку из письма (без Cloud Functions — работает
// на бесплатном Firebase-плане). Firebase сам присылает письмо со ссылкой;
// после перехода по ней и обновления токена здесь СОЗДАЁТСЯ сам профиль
// users/{uid} — до этого момента аккаунта в базе нет вообще (см.
// Register.jsx, utils/pendingAccounts.js и firestore.rules -> users/{uid}
// create, где создание разрешено только с email_verified в токене).
export default function VerifyEmail() {
  const { user, profile, signOut } = useAuth();
  const { t } = useLanguage();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [emailKey, setEmailKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const finishing = useRef(false); // защита от повторного входа из автопроверки
  // Человек нажал "Отменить регистрацию" — автопроверка не должна в этот
  // момент создать профиль аккаунту, который вот-вот будет удалён (иначе
  // документ users/{uid} остался бы висеть с несуществующим uid).
  const leavingRef = useRef(false);
  // Профиль уже записан этой вкладкой (снапшот из AuthContext мог ещё не
  // успеть прийти) — значит аккаунт настоящий и удалять его нельзя.
  const profileCreated = useRef(false);
  const navigate = useNavigate();

  // Обратный отсчёт для кнопки "Отправить снова" — не даёт долбить письмо
  // так часто, что Firebase сам начинает отвечать auth/too-many-requests.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t2 = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t2);
  }, [cooldown]);

  // Почта подтверждена — только теперь аккаунт становится настоящим и в
  // базе появляется его профиль users/{uid}. До этого момента в Firestore о
  // нём нет ни одной записи (см. Register.jsx и firestore.rules).
  async function finishRegistration() {
    if (finishing.current || leavingRef.current) return;
    finishing.current = true;
    try {
      // Профиль уже есть (старый аккаунт с verified:false или аккаунт,
      // подтверждённый ключом) — просто дожимаем флаг.
      if (profile) {
        if (!profile.verified) {
          await updateDoc(doc(db, "users", user.uid), { verified: true });
        }
        navigate("/setup-tag");
        return;
      }

      // Устройство за аккаунтом закрепляется ещё при регистрации (см.
      // Register.jsx), здесь вызов идемпотентный и нужен только на всякий
      // случай — для аккаунтов, созданных до этой логики. Если он не
      // проходит (браузер успел занять кто-то другой), аккаунт всё равно
      // НЕ трогаем: почта подтверждена, человек настоящий, а "один аккаунт
      // на браузер" — мягкий барьер, а не повод потерять аккаунт.
      await claimDeviceForAccount(user.uid).catch(() => {});

      if (leavingRef.current) return; // человек параллельно отменил регистрацию

      await setDoc(doc(db, "users", user.uid), {
        email: user.email,
        verified: true,
        isAdmin: false,
        banned: false,
        profileComplete: false,
        tag: null,
        language: null,
        createdAt: serverTimestamp(),
      });
      profileCreated.current = true;
      navigate("/setup-tag");
    } finally {
      finishing.current = false;
    }
  }

  async function checkStatus(showErrors) {
    if (!user || leavingRef.current) return;
    setChecking(true);
    // Автопроверка не трогает уже показанные сообщения (в том числе свою же
    // ошибку создания профиля и ответ на "отправить письмо снова") — чистим
    // только при ручном нажатии.
    if (showErrors) setError("");
    try {
      await user.reload();
      if (leavingRef.current) return;
      if (!user.emailVerified) {
        if (showErrors) setError(t("verifyEmail.notVerifiedError"));
        return;
      }
      // user.reload() обновляет только локальный профиль (currentUser.emailVerified),
      // но НЕ обновляет claims в самом ID-токене — а именно на них смотрят правила
      // Firestore (request.auth.token.email_verified). Без принудительного refresh
      // токена создание профиля падает с permission-denied.
      await user.getIdToken(true);
      try {
        await finishRegistration();
      } catch {
        // Почта подтверждена, а профиль создать не вышло (правила/сеть) —
        // показываем ВСЕГДА, даже при автопроверке: иначе человек молча
        // смотрел бы на экран "подтвердите почту", уже перейдя по ссылке.
        setError(t("verifyEmail.finishError"));
      }
    } catch (err) {
      if (showErrors) setError(friendlyAuthError(err, t));
    } finally {
      setChecking(false);
    }
  }

  // Автопроверка каждые 4 секунды, пока пользователь на этом экране
  useEffect(() => {
    const interval = setInterval(() => checkStatus(false), 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, profile]);

  // Ключ администратора (см. utils/emailKeys.js) — на случай, если аккаунт
  // уже создан (обычной регистрацией) и человек застрял на этом экране, а
  // ключ применить хочет только теперь. Условия те же, что и при
  // регистрации (см. firestore.rules -> users/{uid}, ветка emailKeyCode).
  async function handleEmailKey(e) {
    e.preventDefault();
    if (!user || keyBusy) return;
    const trimmed = emailKey.trim();
    if (!trimmed) return;
    setKeyBusy(true);
    setError("");
    try {
      // Профиля ещё нет — значит ключ должен его СОЗДАТЬ, а не обновить
      // (см. emailKeys.js). Отметку об устройстве на всякий случай
      // подтверждаем (при регистрации она уже поставлена, вызов
      // идемпотентный), но провал не останавливает погашение ключа: ключ
      // выдан администратором адресно, это сильнее анти-абьюз-барьера.
      if (!profile) {
        await claimDeviceForAccount(user.uid).catch(() => {});
      }

      const ok = await redeemEmailKeyOnVerify(user.uid, trimmed, {
        email: user.email,
        profileExists: Boolean(profile),
      });
      if (ok) {
        navigate("/setup-tag");
      } else {
        setError(t("verifyEmail.emailKeyError"));
      }
    } catch (err) {
      setError(friendlyAuthError(err, t));
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0) return;
    setError("");
    setInfo("");
    setResending(true);
    try {
      await sendEmailVerification(user);
      setInfo(t("verifyEmail.resendSuccess"));
      setCooldown(RESEND_COOLDOWN);
    } catch (err) {
      setError(friendlyAuthError(err, t, "verifyEmail.resendError"));
      // Даже при ошибке ставим паузу — особенно на too-many-requests,
      // чтобы не повторять запрос сразу же и не усугублять лимит.
      setCooldown(RESEND_COOLDOWN);
    } finally {
      setResending(false);
    }
  }

  // Уход с этого экрана = отказ от регистрации: неподтверждённый аккаунт
  // удаляем сразу, чтобы email тут же освободился (см.
  // utils/pendingAccounts.js). Если у аккаунта уже есть профиль (подтверждён
  // ключом / старый аккаунт), это обычный выход.
  async function handleLeave() {
    if (leaving) return;
    leavingRef.current = true;
    setLeaving(true);
    try {
      // Ждём завершения возможной параллельной автопроверки, чтобы не удалить
      // аккаунт ровно в тот момент, когда она создаёт ему профиль. Но не
      // дольше LEAVE_WAIT_MS: запрос к Firestore при обрыве сети может висеть
      // сколь угодно долго, а кнопка "Отменить регистрацию" должна работать
      // всегда.
      const deadline = Date.now() + LEAVE_WAIT_MS;
      while (finishing.current && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50));
      }
      // Профиль мог появиться прямо сейчас (человек кликнул ссылку в письме
      // одновременно с "Отменить регистрацию") — тогда это обычный выход.
      if (user && !user.emailVerified && !profile && !profileCreated.current) {
        await deleteUnverifiedAccount(user);
      }
      await signOut();
      navigate("/login");
    } catch {
      // Не получилось (обрыв сети и т.п.) — возвращаем экран в рабочее
      // состояние, иначе автопроверка осталась бы заглушенной навсегда.
      leavingRef.current = false;
      setError(t("verifyEmail.leaveError"));
    } finally {
      setLeaving(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{t("verifyEmail.title")}</h1>
        <p className="subtitle">{t("verifyEmail.subtitle", { email: user?.email })}</p>
        <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>{t("verifyEmail.spamHint")}</p>
        <p className="muted" style={{ fontSize: 13 }}>{t("verifyEmail.notCreatedYetHint")}</p>
        {error && <div className="error">{error}</div>}
        {info && <div className="info">{info}</div>}
        <button onClick={() => checkStatus(true)} disabled={checking}>
          {checking ? t("verifyEmail.checking") : t("verifyEmail.confirmButton")}
        </button>
        <p className="switch">
          {t("verifyEmail.resendQuestion")}{" "}
          <button className="link-btn" onClick={handleResend} disabled={resending || cooldown > 0}>
            {resending
              ? t("verifyEmail.resendSending")
              : cooldown > 0
              ? t("verifyEmail.resendCooldown", { seconds: cooldown })
              : t("verifyEmail.resendButton")}
          </button>
        </p>
        <form onSubmit={handleEmailKey} style={{ marginTop: 8 }}>
          <label>{t("verifyEmail.emailKeyLabel")}</label>
          <input
            type="text"
            value={emailKey}
            onChange={(e) => setEmailKey(e.target.value)}
            placeholder={t("register.emailKeyPlaceholder")}
          />
          <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0, lineHeight: 1.4 }}>
            {t("verifyEmail.emailKeyHint")}
          </p>
          <button type="submit" className="secondary" disabled={keyBusy || !emailKey.trim()}>
            {keyBusy ? t("verifyEmail.checking") : t("verifyEmail.emailKeySubmit")}
          </button>
        </form>
        <p className="switch">
          <button className="link-btn" onClick={handleLeave} disabled={leaving}>
            {profile ? t("verifyEmail.signOut") : t("verifyEmail.cancelRegistration")}
          </button>
        </p>
      </div>
    </div>
  );
}

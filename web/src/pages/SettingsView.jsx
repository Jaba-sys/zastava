import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { collection, deleteDoc, doc, getDoc, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  verifyBeforeUpdateEmail,
} from "firebase/auth";
import { auth, db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import { friendlyAuthError } from "../utils/authErrors";
import { useLanguage } from "../i18n/LanguageContext";
import { LANGUAGE_OPTIONS } from "../i18n/translations";
import UserAvatar from "../components/UserAvatar";
import VerifiedBadge from "../components/VerifiedBadge";
import { firstChar } from "../utils/text";
import {
  THEME_OPTIONS,
  getThemePreference,
  setThemePreference,
  subscribeTheme,
} from "../utils/theme";
import {
  getNotificationPermission,
  isNotificationSupported,
  requestNotificationPermission,
} from "../utils/browserNotify";

// Отдельный экран "Настройки" — раньше всё это (язык, уведомления, приём
// заявок в друзья, выход из аккаунта) жило прямо на экране "Профиль" вперемешку
// с самой анкетой (имя/тег/дата рождения), что не очень похоже на серьёзный
// мессенджер. Теперь "Профиль" — это только сама анкета, а системные
// настройки — здесь, как в Telegram/WhatsApp.
export default function SettingsView() {
  const { user, profile, signOut } = useAuth();
  const { lang, setLang, t } = useLanguage();

  const [togglingRequests, setTogglingRequests] = useState(false);
  const [togglingNotificationsMuted, setTogglingNotificationsMuted] = useState(false);
  const [notifPermission, setNotifPermission] = useState(() => getNotificationPermission());
  const [notifRequesting, setNotifRequesting] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [unblockingId, setUnblockingId] = useState(null);

  // Тема хранится не в профиле, а в localStorage этого устройства
  // (см. utils/theme.js), поэтому её состояние живёт здесь, а не в profile.
  const [theme, setTheme] = useState(() => getThemePreference());
  useEffect(() => subscribeTheme(setTheme), []);

  // Смена email — открытая форма запрашивает НОВЫЙ адрес и ТЕКУЩИЙ пароль
  // (реаутентификация, см. handleChangeEmailSubmit ниже: verifyBeforeUpdateEmail
  // — операция чувствительная, Firebase требует "свежий" вход, а без пароля
  // сессию, угнанную/оставленную открытой на чужом устройстве, можно было бы
  // тихо перевести на чужую почту). Сам email в Firebase Auth меняется только
  // после перехода по ссылке из письма на НОВЫЙ адрес — до этого момента
  // ничего не происходит (см. AuthContext.jsx, где Firestore досинхронизирует
  // users/{uid}.email, как только Auth это подтвердит).
  const [changingEmail, setChangingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailSentTo, setEmailSentTo] = useState("");

  // Смена пароля прямо из настроек — сознательно НЕ форма "введите новый
  // пароль тут же": по требованию пользователя даже смена пароля из уже
  // авторизованного аккаунта идёт через письмо-подтверждение (тот же
  // sendPasswordResetEmail + /reset-password, что и "Забыли пароль?" на
  // экране входа, см. ForgotPassword.jsx/ResetPassword.jsx) — сам пароль
  // нигде, кроме той специальной страницы, не вводится.
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSentTo, setPasswordSentTo] = useState("");

  const acceptingRequests = profile?.acceptingRequests !== false;
  const notificationsMuted = profile?.notificationsMuted === true;

  // Список тех, кого Я заблокировал (см. firestore.rules -> blocks/{blockId}:
  // читать и удалять свою запись блокировки может только сам блокировавший).
  // Раньше разблокировать можно было ТОЛЬКО из меню самого чата — а если чат
  // после "Удалить и заблокировать" уходил из списка (и больше туда не
  // возвращался, т.к. заблокированный не может написать и вернуть чат назад),
  // человек оставался без единого способа найти дорогу назад к разблокировке.
  // Эта страница — независимый способ увидеть и снять любую блокировку.
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "blocks"), where("blockerId", "==", user.uid));
    const unsub = onSnapshot(q, async (snap) => {
      const rows = await Promise.all(
        snap.docs.map(async (d) => {
          const blockedId = d.data().blockedId;
          if (!blockedId) return null;
          const uSnap = await getDoc(doc(db, "users", blockedId));
          return uSnap.exists() ? { id: uSnap.id, ...uSnap.data() } : null;
        })
      );
      setBlockedUsers(rows.filter(Boolean));
    });
    return unsub;
  }, [user]);

  async function unblock(uid) {
    setUnblockingId(uid);
    try {
      await deleteDoc(doc(db, "blocks", `${user.uid}_${uid}`));
    } catch (err) {
      alert(t("settings.unblockError", { message: err.message }));
    } finally {
      setUnblockingId(null);
    }
  }

  async function handleEnableNotifications() {
    setNotifRequesting(true);
    try {
      const result = await requestNotificationPermission();
      setNotifPermission(result);
    } finally {
      setNotifRequesting(false);
    }
  }

  async function toggleAcceptingRequests() {
    setTogglingRequests(true);
    try {
      await updateDoc(doc(db, "users", user.uid), {
        acceptingRequests: !acceptingRequests,
      });
    } catch (err) {
      alert(t("profileView.toggleError", { message: err.message }));
    } finally {
      setTogglingRequests(false);
    }
  }

  // Общий тумблер "не уведомлять меня о новых сообщениях" — в отличие от
  // мута конкретного чата (см. ChatWindow.jsx -> mutedFor), выключает
  // браузерные уведомления и всплывающую плашку сразу для ВСЕХ чатов (см.
  // hooks/useMessageNotifications.js -> profile.notificationsMuted). Сами
  // сообщения по-прежнему приходят и видны в чатах — это только про то,
  // беспокоит ли клиент уведомлением.
  async function toggleNotificationsMuted() {
    setTogglingNotificationsMuted(true);
    try {
      await updateDoc(doc(db, "users", user.uid), {
        notificationsMuted: !notificationsMuted,
      });
    } catch (err) {
      alert(t("settings.notificationsMutedError", { message: err.message }));
    } finally {
      setTogglingNotificationsMuted(false);
    }
  }

  async function handleChangeEmailSubmit(e) {
    e.preventDefault();
    const trimmed = newEmail.trim();
    if (!trimmed || !emailPassword) return;
    setEmailError("");
    setEmailBusy(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, emailPassword);
      await reauthenticateWithCredential(user, credential);
      await verifyBeforeUpdateEmail(user, trimmed);
      setEmailSentTo(trimmed);
      setChangingEmail(false);
      setNewEmail("");
      setEmailPassword("");
    } catch (err) {
      setEmailError(friendlyAuthError(err, t));
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleChangePassword() {
    setPasswordError("");
    setPasswordBusy(true);
    try {
      // Та же ссылка-обработчик, что и у "Забыли пароль?" (см.
      // ForgotPassword.jsx) — /reset-password сама по себе не знает и не
      // спрашивает, откуда пришёл запрос.
      await sendPasswordResetEmail(auth, user.email, {
        url: `${window.location.origin}/reset-password`,
        handleCodeInApp: true,
      });
      setPasswordSentTo(user.email);
    } catch (err) {
      setPasswordError(friendlyAuthError(err, t));
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>{t("settings.title")}</h2>

      <div className="settings-row">
        <div>
          <b>{t("profileView.acceptingRequestsTitle")}</b>
          <p className="muted" style={{ margin: "2px 0 0" }}>
            {t("profileView.acceptingRequestsHint")}
          </p>
        </div>
        <button
          type="button"
          className={"toggle-switch" + (acceptingRequests ? " on" : "")}
          onClick={toggleAcceptingRequests}
          disabled={togglingRequests}
          aria-label={t("profileView.acceptingRequestsTitle")}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      <div className="settings-row">
        <div>
          <b>{t("settings.notificationsMutedTitle")}</b>
          <p className="muted" style={{ margin: "2px 0 0" }}>
            {t("settings.notificationsMutedHint")}
          </p>
        </div>
        <button
          type="button"
          className={"toggle-switch" + (notificationsMuted ? " on" : "")}
          onClick={toggleNotificationsMuted}
          disabled={togglingNotificationsMuted}
          aria-label={t("settings.notificationsMutedTitle")}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <b>{t("settings.themeTitle")}</b>
        <p className="muted" style={{ margin: "2px 0 8px" }}>
          {t("settings.themeHint")}
        </p>
        <div className="language-options">
          {THEME_OPTIONS.map((code) => (
            <button
              key={code}
              type="button"
              className={"language-option" + (theme === code ? " active" : "")}
              onClick={() => setThemePreference(code)}
            >
              {t("settings.theme_" + code)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <b>{t("profileView.languageTitle")}</b>
        <p className="muted" style={{ margin: "2px 0 8px" }}>
          {t("profileView.languageHint")}
        </p>
        <div className="language-options">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.code}
              type="button"
              className={"language-option" + (lang === opt.code ? " active" : "")}
              onClick={() => setLang(opt.code, user.uid)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <b>{t("profileView.notificationsTitle")}</b>
        <p className="muted" style={{ margin: "2px 0 8px" }}>
          {t("profileView.notificationsHint")}
        </p>
        {!isNotificationSupported() ? (
          <span className="muted">{t("profileView.notificationsUnsupported")}</span>
        ) : notifPermission === "granted" ? (
          <span className="info" style={{ display: "inline-block" }}>
            {t("profileView.notificationsGranted")}
          </span>
        ) : notifPermission === "denied" ? (
          <span className="error" style={{ display: "inline-block" }}>
            {t("profileView.notificationsDenied")}
          </span>
        ) : (
          <button
            type="button"
            className="secondary"
            style={{ width: "auto" }}
            disabled={notifRequesting}
            onClick={handleEnableNotifications}
          >
            {t("profileView.notificationsEnable")}
          </button>
        )}
      </div>

      <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <b>{t("settings.blockedTitle")}</b>
        <p className="muted" style={{ margin: "2px 0 8px" }}>
          {t("settings.blockedHint")}
        </p>
        {blockedUsers.length === 0 ? (
          <span className="muted">{t("settings.blockedEmpty")}</span>
        ) : (
          blockedUsers.map((u) => (
            <div className="user-card" key={u.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <UserAvatar profile={u} fallback={firstChar(u.name)} />
                <div>
                  <b>
                    {u.name}
                    <VerifiedBadge show={u.verifiedBadge} />
                  </b>{" "}
                  <span className="muted">@{u.tag}</span>
                </div>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={unblockingId === u.id}
                onClick={() => unblock(u.id)}
              >
                {t("chatWindow.unblock")}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <b>{t("settings.accountSecurityTitle")}</b>
        <p className="muted" style={{ margin: "2px 0 8px" }}>
          {t("settings.currentEmailLabel", { email: user?.email })}
        </p>

        {emailSentTo && <div className="info">{t("settings.changeEmailSent", { email: emailSentTo })}</div>}
        {!changingEmail ? (
          <button
            type="button"
            className="secondary"
            style={{ width: "auto" }}
            onClick={() => {
              setChangingEmail(true);
              setEmailError("");
              setEmailSentTo("");
            }}
          >
            {t("settings.changeEmailBtn")}
          </button>
        ) : (
          <form onSubmit={handleChangeEmailSubmit}>
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
              {t("settings.changeEmailHint")}
            </p>
            <label>{t("settings.newEmailLabel")}</label>
            <input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <label>{t("settings.currentPasswordLabel")}</label>
            <input
              type="password"
              required
              value={emailPassword}
              onChange={(e) => setEmailPassword(e.target.value)}
            />
            <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
              {t("settings.currentPasswordHint")}
            </p>
            {emailError && <div className="error">{emailError}</div>}
            <button type="submit" disabled={emailBusy}>
              {emailBusy ? t("settings.changeEmailSubmitting") : t("settings.changeEmailSubmit")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setChangingEmail(false);
                setNewEmail("");
                setEmailPassword("");
                setEmailError("");
              }}
            >
              {t("settings.changeEmailCancel")}
            </button>
          </form>
        )}

        <div style={{ marginTop: 14 }}>
          <p className="muted" style={{ margin: "2px 0 8px" }}>
            {t("settings.changePasswordHint")}
          </p>
          {passwordSentTo && <div className="info">{t("settings.changePasswordSent", { email: passwordSentTo })}</div>}
          {passwordError && <div className="error">{passwordError}</div>}
          <button
            type="button"
            className="secondary"
            style={{ width: "auto" }}
            disabled={passwordBusy}
            onClick={handleChangePassword}
          >
            {passwordBusy ? t("settings.changePasswordSubmitting") : t("settings.changePasswordBtn")}
          </button>
        </div>
      </div>

      <Link to="/shop" className="shop-link-card">
        🛍 {t("shop.title")}
        <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
          {t("profileView.goToShopHint")}
        </span>
      </Link>

      {profile?.isAdmin && (
        <p>
          <Link to="/admin">{t("profileView.adminPanelLink")}</Link>
        </p>
      )}

      <button className="secondary" onClick={signOut}>
        {t("profileView.signOut")}
      </button>
    </div>
  );
}

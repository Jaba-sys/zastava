import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import { auth } from "../firebase";
import { friendlyAuthError } from "../utils/authErrors";
import { redeemEmailKeyOnRegister } from "../utils/emailKeys";
import { claimDeviceForAccount } from "../utils/deviceTrust";
import { deleteUnverifiedAccount } from "../utils/pendingAccounts";
import { useLanguage } from "../i18n/LanguageContext";

export default function Register() {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [emailKey, setEmailKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  function mapAuthError(err) {
    switch (err.code) {
      case "auth/email-already-in-use":
        return t("register.errorEmailInUse");
      case "auth/invalid-email":
        return t("register.errorInvalidEmail");
      case "auth/weak-password":
        return t("register.errorWeakPassword");
      default:
        return friendlyAuthError(err, t);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (password !== password2) {
      setError(t("register.errorPasswordsMismatch"));
      return;
    }
    if (password.length < 6) {
      setError(t("register.errorPasswordTooShort"));
      return;
    }

    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);

      // Анти-абьюз: не больше одного аккаунта с одного устройства/браузера
      // (см. utils/deviceTrust.js) — иначе легко наштамповать десятки
      // аккаунтов подряд ради бонусных звёзд (например за "первого друга").
      // Не железная защита (сбрасывается очисткой данных сайта), но барьер
      // против массовой прогонки. Проверяем СРАЗУ после создания Auth-
      // аккаунта, ДО отправки письма: если устройство уже "занято" другим
      // аккаунтом, откатываем только что созданный аккаунт и прерываем
      // регистрацию — человек узнаёт об этом сразу, а не после похода в почту.
      // Если регистрацию потом бросят неподтверждённой, отметка снимется
      // вместе с удалением аккаунта (см. utils/pendingAccounts.js).
      let claimed = false;
      try {
        await claimDeviceForAccount(cred.user.uid);
        claimed = true;
      } catch {
        claimed = false;
      }

      // Админский ключ (см. utils/emailKeys.js) проверяется РАНЬШЕ, чем
      // барьер по устройству: ключ выдан администратором адресно на этот
      // email, и он сильнее анти-абьюза — иначе на общем/рабочем компьютере,
      // где уже кто-то зарегистрирован, человека с ключом не пустило бы
      // вообще. Сам ключ проверяют правила Firestore (email/активность/
      // использованность) — если он неверный/чужой/использован/отозван,
      // попытка просто не проходит, и мы продолжаем обычным путём.
      const trimmedKey = emailKey.trim();
      if (trimmedKey) {
        let verifiedByKey = false;
        try {
          verifiedByKey = await redeemEmailKeyOnRegister(
            cred.user.uid,
            cred.user.email,
            trimmedKey
          );
        } catch {
          verifiedByKey = false;
        }

        if (verifiedByKey) {
          navigate("/setup-tag");
          return;
        }
        // Ключ не подошёл — продолжаем обычной регистрацией с письмом.
      }

      if (!claimed) {
        await deleteUnverifiedAccount(cred.user);
        setError(t("register.deviceAlreadyUsedError"));
        setLoading(false);
        return;
      }

      // Обычная регистрация: НИЧЕГО в базу не пишем. Документ users/{uid}
      // появится только после подтверждения почты (см. VerifyEmail.jsx и
      // firestore.rules -> users/{uid} create, который этого и требует).
      // Пока почта не подтверждена, аккаунта для приложения не существует:
      // его не видно в поиске, в админке и он не занимает место в базе.
      // Сам Auth-аккаунт живёт не дольше UNVERIFIED_GRACE_MS (см.
      // utils/pendingAccounts.js) — потом удаляется и email снова свободен.
      await sendEmailVerification(cred.user);
      navigate("/verify");
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{t("register.title")}</h1>
        <p className="subtitle">{t("register.subtitle")}</p>
        <form onSubmit={handleSubmit}>
          <label>{t("register.email")}</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("register.emailPlaceholder")}
          />
          <label>{t("register.password")}</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("register.passwordPlaceholder")}
          />
          <label>{t("register.passwordRepeat")}</label>
          <input
            type="password"
            required
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
          <label>{t("register.emailKeyLabel")}</label>
          <input
            type="text"
            value={emailKey}
            onChange={(e) => setEmailKey(e.target.value)}
            placeholder={t("register.emailKeyPlaceholder")}
          />
          <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0, lineHeight: 1.4 }}>
            {t("register.emailKeyHint")}
          </p>
          <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0, lineHeight: 1.4 }}>
            {t("register.verifyFirstHint")}
          </p>
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? t("register.submitting") : t("register.submit")}
          </button>
        </form>
        <p className="switch">
          {t("register.haveAccount")} <Link to="/login">{t("register.login")}</Link>
        </p>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../firebase";
import { friendlyAuthError } from "../utils/authErrors";
import { useLanguage } from "../i18n/LanguageContext";

// "Забыли пароль?" (см. ссылку на Login.jsx) — публичная страница, доступна
// БЕЗ входа в аккаунт. Отправляет письмо стандартным Firebase Auth
// (sendPasswordResetEmail), но со своей actionCodeSettings: ссылка в письме
// ведёт не на типовую страницу Firebase, а прямо в это же приложение, на
// /reset-password (см. ResetPassword.jsx), где и вводится новый пароль —
// именно там и только там сам пароль реально меняется (см.
// confirmPasswordReset), эта страница только просит письмо.
export default function ForgotPassword() {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const trimmed = email.trim();
    try {
      await sendPasswordResetEmail(auth, trimmed, {
        url: `${window.location.origin}/reset-password`,
        handleCodeInApp: true,
      });
      setSent(true);
    } catch (err) {
      // Специально НЕ показываем отдельную ошибку на "такого email нет" —
      // иначе форма превращается в инструмент проверки, зарегистрирован ли
      // конкретный адрес в MyPeal (чужая приватная информация). Экран
      // "письмо отправлено" показываем в обоих случаях одинаково.
      if (err.code === "auth/user-not-found") {
        setSent(true);
      } else {
        setError(friendlyAuthError(err, t));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{t("forgotPassword.title")}</h1>
        {sent ? (
          <>
            <p className="subtitle">{t("forgotPassword.sentText", { email })}</p>
            <p className="muted" style={{ fontSize: 13, marginTop: -8 }}>
              {t("forgotPassword.spamHint")}
            </p>
          </>
        ) : (
          <>
            <p className="subtitle">{t("forgotPassword.subtitle")}</p>
            <form onSubmit={handleSubmit}>
              <label>{t("forgotPassword.email")}</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && <div className="error">{error}</div>}
              <button type="submit" disabled={loading}>
                {loading ? t("forgotPassword.submitting") : t("forgotPassword.submit")}
              </button>
            </form>
          </>
        )}
        <p className="switch">
          <Link to="/login">{t("forgotPassword.backToLogin")}</Link>
        </p>
      </div>
    </div>
  );
}

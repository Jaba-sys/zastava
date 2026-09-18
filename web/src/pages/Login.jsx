import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { friendlyAuthError } from "../utils/authErrors";
import { deleteUnverifiedAccount, isExpiredUnverified } from "../utils/pendingAccounts";
import { useLanguage } from "../i18n/LanguageContext";

export default function Login() {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  function mapAuthError(err) {
    switch (err.code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return t("login.errorWrongCredentials");
      default:
        return friendlyAuthError(err, t);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const user = cred.user;

      // Аккаунт, который так и не подтвердил почту, в базе не существует
      // (профиль users/{uid} создаётся только после подтверждения, см.
      // Register.jsx / VerifyEmail.jsx). Такой "полуаккаунт" живёт ограниченное
      // время (UNVERIFIED_GRACE_MS, см. utils/pendingAccounts.js) — если срок
      // вышел, удаляем его прямо здесь: email снова свободен, регистрируйтесь
      // заново. Профиль проверяем ОБЯЗАТЕЛЬНО: аккаунты, подтверждённые
      // админским ключом, имеют verified:true в базе, но emailVerified:false в
      // самом Firebase Auth — их удалять нельзя.
      if (!user.emailVerified) {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists()) {
          if (isExpiredUnverified(user)) {
            const deleted = await deleteUnverifiedAccount(user);
            await auth.signOut();
            setError(
              deleted ? t("login.errorUnverifiedExpired") : t("login.errorUnverifiedPending")
            );
            setLoading(false);
            return;
          }
          navigate("/verify");
          return;
        }
      }

      navigate("/");
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{t("login.title")}</h1>
        <p className="subtitle">{t("login.subtitle")}</p>
        <form onSubmit={handleSubmit}>
          <label>{t("login.email")}</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label>{t("login.password")}</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? t("login.submitting") : t("login.submit")}
          </button>
        </form>
        <p className="switch">
          <Link to="/forgot-password">{t("login.forgotPassword")}</Link>
        </p>
        <p className="switch">
          {t("login.noAccount")} <Link to="/register">{t("login.register")}</Link>
        </p>
      </div>
    </div>
  );
}

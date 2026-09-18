import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Timestamp, addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../contexts/AuthContext";
import LoadingLogo from "../components/LoadingLogo";
import { useLanguage } from "../i18n/LanguageContext";

// Экран "разрешить приложению войти под моим аккаунтом".
//
// Отсюда выходит ПРОПУСК — документ authTickets/{id} со случайным номером, в
// котором лежит uid, имя и тег. Приложение, которое человека сюда прислало,
// получает только номер пропуска в адресе и по нему читает эти три поля.
// Переписку, контакты и что-либо ещё оно не видит вовсе.
//
// Почему так, а не "вход через MyPeal" в один клик: своего сервера у нас нет,
// подписать что-либо некому. Но запись в базу от имени вошедшего человека —
// сама по себе доказательство: правило требует uid == request.auth.uid, и
// выписать пропуск на чужое имя невозможно. Дальше правило на authLinks
// перечитывает этот пропуск и убеждается, что он живой и не потрачен. Тот же
// приём, что и пропуск на вступление в группу по ссылке (см. utils/groupLinks.js).
//
// Специально НЕ обёрнут в Gate: человек может прийти сюда не войдя вовсе —
// тогда мы проводим его по обычной цепочке входа или регистрации и возвращаем
// обратно, как это делает InviteJoin.jsx.

const PENDING_KEY = "pendingAuthorizePath";

// Куда разрешено возвращать пропуск. Это САМАЯ ВАЖНАЯ строчка на странице:
// без проверки любой сайт мог бы прислать сюда человека и увести пропуск себе.
// Порт у localhost не фиксируем — на нём никто, кроме самого разработчика, не
// окажется, а вот менять список под каждый запуск пришлось бы постоянно.
const ALLOWED_ORIGINS = [
  "https://zastava.web.app",
  "https://zastava.firebaseapp.com",
  "https://jaba-sys.github.io"
];
const ALLOWED_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const TICKET_MINUTES = 3;

function redirectAllowed(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !ALLOWED_LOCAL.test(url.origin)) return null;
  if (!ALLOWED_ORIGINS.includes(url.origin) && !ALLOWED_LOCAL.test(url.origin)) return null;
  // Возвращаем только происхождение и путь: чужие параметры и решётку
  // отбрасываем, чтобы через них нельзя было ничего подмешать.
  return url.origin + url.pathname;
}

// Приложения, которым вообще разрешено просить пропуск. Список короткий и
// заводится руками — так к нему нельзя приписать себя со стороны.
const APPS = {
  zastava: { titleKey: "authorize.appZastava" }
};

export default function Authorize() {
  const { user, profile, loading } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const appId = params.get("app") || "";
  const state = params.get("state") || "";
  const redirect = redirectAllowed(params.get("redirect"));
  const app = APPS[appId];

  const onboarded = !!(user && profile?.verified && profile?.tag && profile?.profileComplete);

  useEffect(() => {
    if (loading) return;
    const remember = () => {
      try {
        localStorage.setItem(PENDING_KEY, location.pathname + location.search);
      } catch {
        // приватный режим — человек просто откроет ссылку ещё раз
      }
    };
    if (!user) {
      remember();
      navigate("/login", { replace: true });
      return;
    }
    if (!profile) {
      remember();
      navigate("/verify", { replace: true });
      return;
    }
    if (!profile.verified || !profile.tag || !profile.profileComplete) {
      remember();
      const next = !profile.verified ? "/verify" : !profile.tag ? "/setup-tag" : "/setup-profile";
      navigate(next, { replace: true });
      return;
    }
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch {
      // ignore
    }
  }, [loading, user, profile, location.pathname, location.search, navigate]);

  async function approve() {
    setWorking(true);
    setError("");
    try {
      const ref = await addDoc(collection(db, "authTickets"), {
        app: appId,
        uid: user.uid,
        name: profile.name || "",
        tag: profile.tag || "",
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + TICKET_MINUTES * 60 * 1000)
      });
      const back = new URL(redirect);
      back.searchParams.set("ticket", ref.id);
      if (state) back.searchParams.set("state", state);
      window.location.replace(back.toString());
    } catch (err) {
      setError(t("authorize.failed", { message: err.message }));
      setWorking(false);
    }
  }

  if (!onboarded) {
    return (
      <div className="center-screen">
        <LoadingLogo label={t("authorize.loading")} />
      </div>
    );
  }

  if (!app || !redirect) {
    return (
      <div className="center-screen">
        <div className="panel" style={{ maxWidth: 420 }}>
          <h2>{t("authorize.title")}</h2>
          <div className="error">{t("authorize.badRequest")}</div>
          <button type="button" className="secondary" onClick={() => navigate("/")}>
            {t("authorize.backToChats")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <div className="panel" style={{ maxWidth: 440 }}>
        <h2>{t("authorize.title")}</h2>
        <p>{t("authorize.lead", { app: t(app.titleKey) })}</p>

        <label style={{ marginTop: 16 }}>{t("authorize.willGetLabel")}</label>
        <div className="user-card">
          <div>
            <b>{profile.name}</b>
            <p className="muted" style={{ fontSize: 12, margin: "2px 0 0" }}>
              {profile.tag ? `@${profile.tag}` : ""}
            </p>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {t("authorize.willNotGet")}
        </p>

        {error && <div className="error">{error}</div>}

        <button type="button" onClick={approve} disabled={working}>
          {working ? t("authorize.working") : t("authorize.approve")}
        </button>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          {t("authorize.decline")}
        </button>

        <p className="muted" style={{ fontSize: 11, marginTop: 14 }}>
          {t("authorize.ticketNote", { minutes: TICKET_MINUTES })}
        </p>
      </div>
    </div>
  );
}

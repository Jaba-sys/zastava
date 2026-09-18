import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import ChatsList from "./ChatsList";
import VerifiedBadge from "../components/VerifiedBadge";
import { useAuth } from "../contexts/AuthContext";
import { useCall } from "../contexts/CallContext";
import { useLanguage } from "../i18n/LanguageContext";
import useMessageNotifications from "../hooks/useMessageNotifications";
import { registerExternalLinkHandler } from "../utils/externalLink";

const DESKTOP_QUERY = "(min-width: 860px)";

// На мобильном экран — один список за раз (как раньше). На широком экране
// (ПК) список чатов остаётся постоянно слева, а справа — открытый чат,
// друзья или профиль, как в десктопных мессенджерах.
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const handler = (e) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}

// Иконки нижнего/бокового меню (как в Телеграме — значок + подпись, а не
// голый текст) — тот же минималистичный обводочный стиль (stroke, без
// заливки), что и у остальных иконок в этом файле (DesktopAppLink и т.д.),
// чтобы всё меню выглядело одним набором. Анимация "пружинки" при
// переключении вкладки — в app.css (.bottom-nav a.active svg и т.п.), тут
// только сама разметка.
function ChatsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function FriendsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function BotsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="10" width="18" height="10" rx="2" />
      <circle cx="8.5" cy="15" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 10V6" />
      <circle cx="12" cy="4" r="2" />
    </svg>
  );
}

function ShopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
      <path d="M3 6h18" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function NavLinks() {
  const { t } = useLanguage();
  const { profile } = useAuth();
  return (
    <>
      <NavLink to="/" end>
        <ChatsIcon />
        <span>{t("layout.navChats")}</span>
      </NavLink>
      <NavLink to="/friends">
        <FriendsIcon />
        <span>{t("layout.navFriends")}</span>
      </NavLink>
      {/* «Разработка» (бывший раздел «Боты») — платный, см.
          utils/devAccount.js, ProfileView.jsx. Пока не куплен, вкладки
          нет вообще, без "дедушкиной оговорки" для уже существующих ботов
          (см. обсуждение с пользователем) — сама MyBotsView.jsx дополнительно
          редиректит при прямом переходе по /bots. */}
      {profile?.devAccountUnlocked && (
        <NavLink to="/bots">
          <BotsIcon />
          <span>{t("layout.navBots")}</span>
        </NavLink>
      )}
      <NavLink to="/shop">
        <ShopIcon />
        <span>{t("layout.navShop")}</span>
      </NavLink>
      <NavLink to="/me">
        <ProfileIcon />
        <span>{t("layout.navProfile")}</span>
      </NavLink>
    </>
  );
}

// Ссылка "скачать приложение для ПК" — ведёт на отдельный публичный
// репозиторий Jaba-sys/mymessage-desktop (там только скомпилированный
// установщик как GitHub Release asset, исходного кода нет), а не на этот
// репозиторий — он приватный. Открывается в новой вкладке, чтобы не
// потерять текущий чат/страницу в самом MyPeal.
const DESKTOP_APP_RELEASE_URL = "https://github.com/Jaba-sys/mymessage-desktop/releases/tag/desktop-v1.0.0";

function DesktopAppLink({ label, title }) {
  return (
    <a
      className="app-logo-desktop-link"
      href={DESKTOP_APP_RELEASE_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
      <span>{label}</span>
    </a>
  );
}

// Хром/Android и десктопные Chrome/Edge сами присылают событие
// beforeinstallprompt, когда сайт можно поставить как приложение — по нему
// можно показать свою кнопку и по клику сразу открыть системное окно
// установки (deferredPrompt.prompt()), без единого ручного шага. iOS Safari
// такого события никогда не присылает (Apple не даёт сайтам вызывать
// установку программно) — там показываем инструкцию (см. IosInstallHint
// ниже). appinstalled и (display-mode: standalone) — как отследить, что
// приложение уже установлено и открыто как отдельное окно, чтобы вовремя
// спрятать кнопку.
function isStandaloneNow() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // Флаг, который Safari на iOS/iPadOS выставляет только когда сайт
    // запущен со значка на экране "Домой", а не из обычной вкладки.
    window.navigator.standalone === true
  );
}

function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isAndroidDevice() {
  if (typeof navigator === "undefined") return false;
  return /android/i.test(navigator.userAgent);
}

// Прямая ссылка на APK, который лежит в корне того же сайта (кладётся туда
// отдельным workflow'ом сборки Android-приложения — build-android-apk.yml —
// рядом с остальными статическими файлами). Показывается только на Android,
// как отдельная от iOS-подсказки и от общей кнопки "Установить приложение"
// возможность — скачать и поставить настоящее приложение вместо PWA.
//
// Сам файл на сервере лежит под именем mymessage-android.data, а не
// mymessage.apk — бесплатный (Spark) план Firebase Hosting отказывается
// отдавать файлы с расширением .apk в принципе. Атрибут download здесь
// заставляет браузер сохранить скачанный файл под настоящим именем
// "mymessage.apk", независимо от расширения в самой ссылке.
function AndroidApkLink({ label, title }) {
  return (
    <a
      className="app-logo-desktop-link"
      href="/mymessage-android.data"
      download="mymessage.apk"
      title={title}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v10" />
        <path d="M8 9l4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <span>{label}</span>
    </a>
  );
}

function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(isStandaloneNow);

  useEffect(() => {
    function onBeforeInstallPrompt(e) {
      e.preventDefault();
      setDeferredPrompt(e);
    }
    function onAppInstalled() {
      setDeferredPrompt(null);
      setIsStandalone(true);
    }
    const mq = window.matchMedia?.("(display-mode: standalone)");
    function onDisplayModeChange() {
      setIsStandalone(isStandaloneNow());
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    mq?.addEventListener("change", onDisplayModeChange);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      mq?.removeEventListener("change", onDisplayModeChange);
    };
  }, []);

  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } finally {
      // Событие одноразовое — использованное show() второй раз не вызвать,
      // так что в любом случае (согласился человек или отменил) сбрасываем.
      setDeferredPrompt(null);
    }
  }

  return { canInstall: !!deferredPrompt, isStandalone, promptInstall };
}

// Кнопка "Установить приложение": на Android/desktop Chrome и Edge — сразу
// открывает системное окно установки (по-настоящему в один клик). На iOS,
// где браузер такой возможности не даёт, показывает инструкцию вместо
// установки. Если сайт уже установлен и открыт как приложение — кнопка
// вообще не рендерится, как и просили.
function InstallAppButton({ t }) {
  const { canInstall, isStandalone, promptInstall } = useInstallPrompt();

  if (isStandalone) return null;

  if (canInstall) {
    return (
      <button
        type="button"
        className="app-logo-desktop-link"
        title={t("layout.installAppTitle")}
        onClick={promptInstall}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v10" />
          <path d="M8 9l4 4 4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span>{t("layout.installAppLabel")}</span>
      </button>
    );
  }

  if (isIosDevice()) {
    return (
      <IosInstallHint
        label={t("layout.iosInstallLabel")}
        title={t("layout.iosInstallTitle")}
        instructions={t("layout.iosInstallInstructions")}
      />
    );
  }

  return null;
}

// У iOS нет способа поставить сайт на домашний экран по клику (в отличие от
// Android/desktop-браузеров) — Apple разрешает это только вручную, через
// Safari -> "Поделиться" -> "На экран «Домой»". Поэтому вместо ссылки это
// кнопка, которая просто показывает эти шаги во всплывающей подсказке.
function IosInstallHint({ label, title, instructions }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div className="app-logo-ios-hint" ref={rootRef}>
      <button
        type="button"
        className="app-logo-desktop-link"
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <line x1="11" y1="18" x2="13" y2="18" />
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <div className="app-logo-ios-popover" role="dialog">
          {instructions}
        </div>
      )}
    </div>
  );
}

// Баланс звёзд теперь показывается тут — рядом с логотипом, а не внутри
// вкладки "Чаты" (там он терялся среди остального текста вкладки и не был
// заметен). Логотип виден всегда на десктопе (шапка боковой панели) и на
// мобильном везде, кроме самого экрана переписки — то есть практически на
// каждом экране приложения.
function Logo({ verified, stars }) {
  const { t } = useLanguage();
  return (
    <div className="app-logo-block">
      <div className="app-logo">
        <img src="/favicon.svg" alt="MyPeal" />
        <span>
          MyPeal
          <VerifiedBadge show={verified} title={t("layout.verifiedTitle")} />
        </span>
        {stars != null && (
          <span className="stars-badge app-logo-stars" title={t("layout.starsTitle")}>
            ⭐ {stars}
          </span>
        )}
      </div>
      <div className="app-logo-links">
        <DesktopAppLink label={t("layout.desktopAppLabel")} title={t("layout.desktopAppTitle")} />
        {isAndroidDevice() && (
          <AndroidApkLink label={t("layout.androidApkLabel")} title={t("layout.androidApkTitle")} />
        )}
        <InstallAppButton t={t} />
      </div>
    </div>
  );
}

export default function Layout() {
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const navigate = useNavigate();
  const inChat = location.pathname.startsWith("/chat/");
  const currentChatId = inChat ? location.pathname.slice("/chat/".length) : null;
  const { profile } = useAuth();
  const { t } = useLanguage();

  // Плашка "новое сообщение" (см. hooks/useMessageNotifications.js) — вместо
  // системного уведомления, пока вкладка открыта и в фокусе, а человек
  // смотрит не на тот чат, куда пришло сообщение. Авто-скрывается сама, клик
  // по ней сразу открывает нужный чат.
  const [messageBannerState, setMessageBannerState] = useState(null);
  const messageBannerTimerRef = useRef(null);
  useMessageNotifications({
    currentChatId,
    onInAppMessage: (payload) => {
      setMessageBannerState(payload);
      if (messageBannerTimerRef.current) clearTimeout(messageBannerTimerRef.current);
      messageBannerTimerRef.current = setTimeout(() => setMessageBannerState(null), 5000);
    },
  });
  useEffect(() => () => {
    if (messageBannerTimerRef.current) clearTimeout(messageBannerTimerRef.current);
  }, []);

  // Свёрнутая плашка идущего звонка (см. CallOverlay.jsx -> .call-top-bar)
  // рисуется поверх всего (position: fixed) и раньше просто перекрывала
  // собой самый верх страницы (шапку сайдбара с логотипом MyPeal,
  // заголовки страниц) — тот текст не был "невидимым" в смысле цвета,
  // он был буквально скрыт под непрозрачной плашкой. Добавляем классу
  // .has-call-bar, который отодвигает контент вниз ровно на высоту плашки.
  const { callState, minimized } = useCall();
  const callBarVisible = callState === "active" && minimized;

  // Модалка "вы покидаете платформу" для внешних ссылок из сообщений (см.
  // utils/externalLink.js) — монтируется один раз здесь, т.к. Layout
  // оборачивает всё авторизованное приложение, а сами ссылки рендерятся в
  // ChatWindow.jsx/LinkPreviewCard.jsx, не связанных друг с другом местах.
  const [externalLinkUrl, setExternalLinkUrl] = useState(null);
  useEffect(() => registerExternalLinkHandler((url) => setExternalLinkUrl(url)), []);

  const externalLinkModal = externalLinkUrl && (
    <div className="modal-backdrop" onClick={() => setExternalLinkUrl(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("externalLink.title")}</h3>
        <p style={{ wordBreak: "break-all", fontSize: 13 }}>{externalLinkUrl}</p>
        <p className="muted" style={{ fontSize: 13 }}>{t("externalLink.warning")}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" className="secondary" onClick={() => setExternalLinkUrl(null)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              window.open(externalLinkUrl, "_blank", "noopener,noreferrer");
              setExternalLinkUrl(null);
            }}
          >
            {t("externalLink.continue")}
          </button>
        </div>
      </div>
    </div>
  );

  const messageBanner = messageBannerState && (
    <div
      className="incoming-message-banner"
      onClick={() => {
        navigate(`/chat/${messageBannerState.chatId}`);
        setMessageBannerState(null);
      }}
    >
      <div className="incoming-message-banner-text">
        <b>{messageBannerState.title}</b>
        <span>{messageBannerState.body}</span>
      </div>
      <button
        type="button"
        className="incoming-message-banner-close"
        onClick={(e) => {
          e.stopPropagation();
          setMessageBannerState(null);
        }}
        aria-label={t("common.cancel")}
      >
        ✕
      </button>
    </div>
  );

  if (isDesktop) {
    return (
      <div className={"app-shell-desktop" + (callBarVisible ? " has-call-bar" : "")}>
        <aside className="sidebar">
          <div className="sidebar-header">
            <Logo verified={profile?.verifiedBadge} stars={profile?.stars ?? 0} />
          </div>
          <nav className="sidebar-nav">
            <NavLinks />
          </nav>
          <div className="sidebar-list">
            <ChatsList />
          </div>
        </aside>
        <main className="main-pane">
          {location.pathname === "/" ? (
            <div className="empty-pane">{t("layout.emptyPaneHint")}</div>
          ) : (
            <Outlet />
          )}
        </main>
        {externalLinkModal}
        {messageBanner}
      </div>
    );
  }

  return (
    <div className={"app-shell" + (callBarVisible ? " has-call-bar" : "")}>
      {!inChat && (
        <div className="mobile-topbar">
          <Logo verified={profile?.verifiedBadge} />
        </div>
      )}
      <div className="app-content">
        <Outlet />
      </div>
      {!inChat && (
        <nav className="bottom-nav">
          <NavLinks />
        </nav>
      )}
      {externalLinkModal}
      {messageBanner}
    </div>
  );
}

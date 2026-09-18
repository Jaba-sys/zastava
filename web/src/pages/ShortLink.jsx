import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import LoadingLogo from "../components/LoadingLogo";
import { useLanguage } from "../i18n/LanguageContext";
import {
  claimShortLinkUse,
  deleteShortLink,
  getShortLink,
  isShortLinkExhausted,
  shortLinkShowsWarning,
} from "../utils/shortLinks";

// Публичная страница ссылки-переходника: /r/{code} (см. utils/shortLinks.js,
// AdminPanel.jsx -> link create/delete). Специально НЕ обёрнута ни в Gate,
// ни в AuthOnlyRoute (как и /invite/:chatId) — но, в отличие от инвайта,
// здесь дальше и не нужен вход в аккаунт: смысл переходника именно в том,
// чтобы им мог воспользоваться кто угодно, даже без MyPeal.
//
// Предупреждение "вы покидаете MyPeal" перед переходом — по умолчанию
// показывается, тем же принципом, что уже используется для ссылок в
// сообщениях чата (см. utils/externalLink.js). Но администратор может
// отключить его для конкретного переходника (link create ... 0) — тогда
// goToUrl() ниже вызывается сразу при загрузке страницы, без единого клика
// от посетителя (см. showWarning в firestore.rules -> shortLinks/{code}).
export default function ShortLink() {
  const { code } = useParams();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [link, setLink] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [going, setGoing] = useState(false);
  const [goError, setGoError] = useState("");

  async function goToUrl(currentLink) {
    setGoError("");
    // Безлимитные ссылки (maxUses не задан) переходят напрямую — незачем
    // лишний раз писать в базу. Лимитированные — сначала гасят свой слот.
    if (currentLink.maxUses == null) {
      window.location.assign(currentLink.url);
      return;
    }
    setGoing(true);
    try {
      const result = await claimShortLinkUse(code);
      if (!result.ok) {
        setExhausted(true);
        setLink(null);
        return;
      }
      window.location.assign(currentLink.url);
    } catch {
      setGoError(t("shortLink.claimError"));
    } finally {
      setGoing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setNotFound(false);
      setExhausted(false);
      try {
        const result = await getShortLink(code);
        if (cancelled) return;
        if (!result) {
          setNotFound(true);
        } else if (isShortLinkExhausted(result)) {
          // Лимит уже исчерпан кем-то раньше, но документ ещё не успел
          // удалиться сам (см. claimShortLinkUse) — подчищаем сейчас, не
          // дожидаясь следующего визита, и показываем как недействительную.
          setExhausted(true);
          deleteShortLink(code).catch(() => {});
        } else {
          setLink(result);
          if (!shortLinkShowsWarning(result)) {
            // Предупреждение отключено администратором — переходим сразу,
            // без отображения панели с кнопками.
            goToUrl(result);
          }
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const handleContinue = () => {
    if (going || !link) return;
    goToUrl(link);
  };

  // Пока предупреждение отключено и переход ещё не сорвался с ошибкой,
  // держим только спиннер — как только случится ошибка (goError), падаем
  // в обычную панель ниже: она покажет и текст ошибки, и кнопку "Перейти
  // по ссылке" вручную, вместо того чтобы зависнуть на спиннере навсегда.
  const autoRedirecting = link && !shortLinkShowsWarning(link) && !goError;

  if (loading || autoRedirecting) {
    return (
      <div className="center-screen">
        <LoadingLogo label={t("common.loading")} />
      </div>
    );
  }

  return (
    <div className="center-screen">
      <div className="panel" style={{ maxWidth: 420 }}>
        <h2>{t("shortLink.title")}</h2>
        {notFound || exhausted ? (
          <>
            <p className="error">
              {exhausted ? t("shortLink.exhaustedText") : t("shortLink.notFoundText")}
            </p>
            <button type="button" onClick={() => navigate("/")}>
              {t("shortLink.backBtn")}
            </button>
          </>
        ) : (
          <>
            {/* Сам адрес назначения (link.url) сюда намеренно не выводится —
                администратор может не хотеть показывать реальный URL до
                перехода (например, если это ссылка на другой мессенджер или
                чат, а не просто справочная информация). Предупреждение и
                кнопка перехода работают точно так же, просто без явного
                показа самого адреса. */}
            <p className="muted" style={{ fontSize: 13 }}>{t("shortLink.warningText")}</p>
            {link.maxUses != null && (
              <p className="muted" style={{ fontSize: 13 }}>
                {t("shortLink.usesLeftText", {
                  left: Math.max(0, link.maxUses - (link.uses || 0)),
                  max: link.maxUses,
                })}
              </p>
            )}
            {goError && <p className="error">{goError}</p>}
            <div className="row-buttons">
              <button type="button" className="secondary" onClick={() => navigate("/")}>
                {t("shortLink.backBtn")}
              </button>
              <button type="button" disabled={going} onClick={handleContinue}>
                {going ? t("shortLink.claiming") : t("shortLink.continueBtn")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

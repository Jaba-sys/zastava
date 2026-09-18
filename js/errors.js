// errors.js — превращает коды Firebase в понятный игроку текст.
// Игрок не должен видеть строку вида auth/invalid-credential.

const messages = {
  "auth/invalid-email":          "Почта введена с ошибкой.",
  "auth/missing-password":       "Введи пароль.",
  "auth/weak-password":          "Пароль короче 6 символов.",
  "auth/email-already-in-use":   "На эту почту аккаунт уже есть. Переключись на вход.",
  "auth/invalid-credential":     "Почта или пароль не подходят.",
  "auth/wrong-password":         "Почта или пароль не подходят.",
  "auth/user-not-found":         "Такого аккаунта нет. Создай его на вкладке «Регистрация».",
  "auth/user-disabled":          "Аккаунт заблокирован.",
  "auth/too-many-requests":      "Слишком много попыток. Подожди пару минут.",
  "auth/popup-closed-by-user":   "Окно Google закрылось до входа.",
  "auth/popup-blocked":          "Браузер заблокировал окно Google. Разреши всплывающие окна.",
  "auth/network-request-failed": "Нет связи с сервером. Проверь интернет.",
  "auth/operation-not-allowed":  "Способ входа выключен в Firebase → Authentication → Sign-in method.",
  "auth/unauthorized-domain":    "Домен не добавлен в Authentication → Settings → Authorized domains.",
  "permission-denied":           "Правила Firestore не пускают. Проверь Rules в консоли."
};

export function explain(error){
  return messages[error?.code] || ("Не получилось: " + (error?.code || error?.message || "неизвестная ошибка"));
}

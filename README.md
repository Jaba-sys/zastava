# Застава

Браузерный шутер на четверых. Пока готов экран входа: почта с паролем, Google,
сброс пароля и профиль игрока в Firestore.

## Структура

```
zastava/
├── index.html          экран входа
├── css/
│   ├── base.css        токены, кнопки, поля — общее для всего проекта
│   └── auth.css        вёрстка именно этого экрана
├── js/
│   ├── config.js       ← сюда вставляешь ключи Firebase
│   ├── firebase.js     инициализация, отдаёт auth и db
│   ├── errors.js       коды Firebase → текст на русском
│   ├── profile.js      карточка игрока в Firestore
│   └── auth-screen.js  логика страницы
└── README.md
```

Позже рядом лягут `game.html`, `js/game/` (Three.js) и `js/net/` (WebRTC).

## Настройка Firebase

1. [console.firebase.google.com](https://console.firebase.google.com) → Add project.
2. Внутри проекта → значок `</>` (Web) → зарегистрировать приложение.
3. Скопировать объект `firebaseConfig` и вставить в `js/config.js`.
4. Authentication → Get started → Sign-in method → включить **Email/Password** и **Google**.
5. Firestore Database → Create database → регион europe-west.
6. Authentication → Settings → Authorized domains → добавить домен сайта
   (например `твойник.github.io`). Без этого Google-вход упадёт.

## Правила Firestore

Firestore → Rules. Каждый игрок читает и пишет только свою карточку:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /players/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Правило `read` открыто всем авторизованным, чтобы позже сделать таблицу лидеров.

## Хостинг

Проект статический, сервер не нужен. Подойдёт GitHub Pages, Netlify или Firebase Hosting.

Открывать файл двойным кликом (`file://`) нельзя: ES-модули и вход через Google
требуют настоящего адреса. Локально — `npx serve` или расширение Live Server.

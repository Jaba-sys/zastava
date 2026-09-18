// sw.js — служебный работник: то, что делает «Заставу» устанавливаемым
// приложением и позволяет ей открываться мгновенно, а не тянуть каждый раз
// весь код заново.
//
// Стратегия выбрана разная для разного, и это не придирка:
//
//   свои файлы (html, js, css, значки) — «сначала из кэша, потом обновить в
//       фоне». Игра открывается сразу, а следующий запуск уже с новой версией.
//       Ждать сеть ради файла, который не менялся, незачем.
//   чужие библиотеки с CDN (three.js, firebase) — то же самое: они помечены
//       версией в адресе и не меняются никогда.
//   всё остальное (сама база, запросы к Firebase) — МИМО кэша. Класть в кэш
//       обмен с базой нельзя ни в каком виде: игрок увидит вчерашний список
//       комнат и чужое здоровье.
//
// Версия в имени кэша — единственный способ выкатить обновление: при смене
// имени старый кэш удаляется целиком в activate.

const VERSION = "zastava-v3";
const SHELL = [
  "./",
  "./index.html",
  "./lobby.html",
  "./game.html",
  "./install.html",
  "./manifest.webmanifest",
  "./css/base.css",
  "./css/auth.css",
  "./css/lobby.css",
  "./css/game.css",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  // addAll падает целиком, если хоть один адрес не отдался. Кладём по одному:
  // отсутствие одной картинки не должно оставить игру без кэша вообще.
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()){
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** Адреса, которые кэшировать нельзя ни при каких условиях. */
function liveOnly(url){
  return url.includes("firebaseio.com")
      || url.includes("firebasedatabase.app")
      || url.includes("googleapis.com/google.firestore")
      || url.includes("firestore.googleapis.com")
      || url.includes("identitytoolkit.googleapis.com")
      || url.includes("/google.firestore.");
}

/** Библиотеки с версией в адресе: их можно держать вечно. */
function longLived(url){
  return url.startsWith("https://cdn.jsdelivr.net/")
      || url.startsWith("https://www.gstatic.com/firebasejs/")
      || url.startsWith("https://fonts.googleapis.com/")
      || url.startsWith("https://fonts.gstatic.com/");
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = request.url;
  if (liveOnly(url)) return;                       // обмен с базой — только сеть

  const sameOrigin = new URL(url).origin === self.location.origin;
  if (!sameOrigin && !longLived(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request);

    // Обновление в фоне: ответ человек получает сразу, а свежая версия
    // ложится в кэш к следующему запуску.
    const fromNet = fetch(request).then(response => {
      if (response && (response.ok || response.type === "opaque")){
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);

    if (hit) return hit;
    const fresh = await fromNet;
    if (fresh) return fresh;

    // Сети нет и в кэше пусто. Для перехода по страницам отдаём хотя бы вход —
    // белый экран без единого слова хуже, чем «начни сначала».
    if (request.mode === "navigate"){
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("Нет сети", { status: 503, statusText: "offline" });
  })());
});

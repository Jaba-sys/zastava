// render.js — всё, что делает картинку похожей на снятую, а не нарисованную.
//
// Геометрия у игры простая: коробки. Менять это нельзя — на коробках держатся
// и столкновения, и скорость, и весь стиль. Значит, реализм надо брать не из
// числа полигонов, а из СВЕТА и ПОВЕРХНОСТИ. Именно этим здесь и занимаемся,
// четырьмя приёмами, каждый из которых виден невооружённым глазом:
//
//   1. Тональная компрессия (ACES). Настоящая камера не обрезает яркое в белый
//      кирпич — она плавно сводит его к белому, а тени оставляет с цветом.
//      Без этого небо и освещённые стены сливаются в плоские пятна, и сцена
//      выглядит как чертёж. Это самая заметная строчка во всём файле.
//
//   2. Окружение (PMREM). Настоящий свет приходит отовсюду: от неба, от земли,
//      от соседней стены. Мы строим маленькую карту окружения из неба и грунта
//      карты и отдаём её сцене — металл начинает отражать небо, стекло
//      перестаёт быть мутным целлофаном, а тени наполняются рассеянным светом
//      вместо чёрного.
//
//   3. Шум поверхности (в шейдере, по МИРОВЫМ координатам). Идеально ровная
//      шероховатость — главный признак компьютерной картинки: блик ложится
//      одинаково на всю стену. Мы подмешиваем шум в шероховатость, в цвет и
//      чуть-чуть в нормаль. Считается это прямо в пиксельном шейдере от точки
//      в МИРЕ, а не от развёртки: у коробки развёртка на каждой грани своя
//      (0..1), и текстура растягивалась бы на большой стене и сжималась на
//      маленькой. От мировых координат масштаб пятен одинаков везде, и один
//      материал обслуживает всю карту — ни одной лишней текстуры в памяти.
//
//   4. Небо куполом и воздух. Плоская заливка позади — вторая по заметности
//      примета «сделано на коленке». Купол с градиентом даёт горизонт, а туман
//      в тот же цвет — воздушную перспективу: дальние вагоны тонут в дымке,
//      как на самом деле.
//
// И отдельно — КАЧЕСТВО. Всё выше стоит кадров, а игра должна идти и на
// телефоне. Поэтому есть три уровня, они выбираются сами по устройству и
// правятся человеком в паузе; на низком остаются только пункты 1 и 4, которые
// не стоят почти ничего.

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

const KEY = "zastava.graphics";

export const QUALITY = {
  low:    { id: "low",    name: "Простая",  shadow: 1024, dpr: 1,   detail: 0, bump: 0,    env: false, exposure: 1.05 },
  medium: { id: "medium", name: "Средняя",  shadow: 2048, dpr: 1.5, detail: 1, bump: 0.05, env: true,  exposure: 1.0  },
  high:   { id: "high",   name: "Высокая",  shadow: 4096, dpr: 2,   detail: 1, bump: 0.11, env: true,  exposure: 0.98 }
};
export const QUALITY_ORDER = ["low", "medium", "high"];

/**
 * Какое качество брать по умолчанию.
 *
 * Телефон определяем не по ширине экрана (планшет и окно браузера её ломают), а
 * по сенсорному вводу и числу ядер. Ошибиться в сторону «поменьше» не страшно —
 * человек поднимет качество сам; ошибиться в другую сторону значит выдать ему
 * слайд-шоу на первом же матче.
 */
function guessQuality(){
  const coarse = matchMedia?.("(pointer: coarse)").matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarse) return cores >= 8 ? "medium" : "low";
  return cores >= 8 ? "high" : "medium";
}

export function readQuality(){
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && QUALITY[saved]) return saved;
  } catch { /* хранилище может быть запрещено */ }
  return guessQuality();
}

export function saveQuality(id){
  try { localStorage.setItem(KEY, id); } catch { /* не смертельно */ }
}

// ---------------------------------------------------------------------------
// Шум поверхности
// ---------------------------------------------------------------------------

/**
 * Кусок GLSL: трёхмерный шум и его «наклон».
 *
 * Шум обычный value-noise на хэше: никаких текстур, никакой памяти, и он
 * одинаков у всех — значит, стена выглядит одинаково у всех игроков, а это
 * важнее математической красоты. Три октавы дают и крупные разводы, и мелкую
 * крупу; больше трёх на глаз уже не отличить, а считать дороже.
 */
const NOISE_GLSL = `
float zHash(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float zNoise(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(zHash(i + vec3(0,0,0)), zHash(i + vec3(1,0,0)), f.x),
                 mix(zHash(i + vec3(0,1,0)), zHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(zHash(i + vec3(0,0,1)), zHash(i + vec3(1,0,1)), f.x),
                 mix(zHash(i + vec3(0,1,1)), zHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float zFbm(vec3 p){
  return zNoise(p) * 0.55 + zNoise(p * 2.7) * 0.3 + zNoise(p * 7.1) * 0.15;
}
`;

/**
 * Подмешать шум в материал.
 *
 * Правки идут через onBeforeCompile — то есть в уже собранный шейдер Three,
 * в заранее оговорённые места (#include <...>). Переписывать шейдер целиком
 * было бы короче, но тогда материал потерял бы тени, туман и всё остальное,
 * что Three собирает сам.
 *
 * ВАЖНО: материалы в игре общие на много коробок, поэтому правим материал
 * ОДИН раз и помечаем — иначе при каждой перестройке карты в шейдер попадали
 * бы новые и новые копии одного и того же кода.
 */
export function detailMaterial(material, { bump = 0.08, scale = 0.6, tint = 0.16 } = {}){
  if (!material || material.userData?.zDetailed) return material;
  material.userData = { ...material.userData, zDetailed: true };

  material.onBeforeCompile = shader => {
    shader.uniforms.zBump  = { value: bump };
    shader.uniforms.zScale = { value: scale };
    shader.uniforms.zTint  = { value: tint };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vZWorld;")
      .replace("#include <begin_vertex>",
               "#include <begin_vertex>\nvZWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>",
        "#include <common>\nvarying vec3 vZWorld;\nuniform float zBump;\nuniform float zScale;\nuniform float zTint;\n" + NOISE_GLSL)

      // Цвет: крупные разводы — подтёки, выгоревшие пятна, грязь у земли.
      .replace("#include <color_fragment>",
        `#include <color_fragment>
         float zLarge = zFbm(vZWorld * zScale * 0.35);
         diffuseColor.rgb *= 1.0 - zTint * 0.5 + zTint * zLarge;
         // Второй, более мелкий слой — крапины. Один слой пятен на большой
         // плоскости читается как ковёр; два разных масштаба — как грязь.
         diffuseColor.rgb *= 0.97 + 0.06 * zNoise(vZWorld * zScale * 11.0);`)

      // Шероховатость: именно она решает, как ложится блик. Ровная
      // шероховатость — главный признак «компьютерной» поверхности.
      .replace("#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         float zFine = zFbm(vZWorld * zScale * 2.2);
         roughnessFactor = clamp(roughnessFactor * (0.82 + 0.34 * zFine), 0.04, 1.0);`)

      // Нормаль: мельчайшая неровность. Берём разность шума по трём осям —
      // это и есть наклон поверхности. Сила маленькая: коробка должна
      // остаться коробкой, а не превратиться в мятую фольгу.
      .replace("#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
         if (zBump > 0.0001){
           vec3 zp = vZWorld * zScale * 6.0;
           float zc = zFbm(zp);
           vec3 zGrad = vec3(zFbm(zp + vec3(0.35, 0.0, 0.0)) - zc,
                             zFbm(zp + vec3(0.0, 0.35, 0.0)) - zc,
                             zFbm(zp + vec3(0.0, 0.0, 0.35)) - zc);
           normal = normalize(normal + zGrad * zBump * 6.0);
         }`);
  };

  material.customProgramCacheKey = () => "zDetail" + bump.toFixed(3) + scale.toFixed(2);
  material.needsUpdate = true;
  return material;
}

// ---------------------------------------------------------------------------
// Небо и окружение
// ---------------------------------------------------------------------------

/**
 * Купол неба: градиент от зенита к горизонту.
 *
 * Рисуется изнутри огромной сферы и намеренно НЕ участвует ни в тенях, ни в
 * тумане — иначе туман закрасил бы само небо. Плоская заливка позади — вторая
 * по заметности примета самодельной сцены после ровного блика.
 */
export function buildSky(topColor, horizonColor){
  const top = new THREE.Color(topColor);
  const horizon = new THREE.Color(horizonColor);

  // Звёзды — только на тёмном небе, и это не украшение. Ночное небо одного
  // цвета читается как чёрная дыра над картой: глазу не за что зацепиться, и
  // верх экрана выглядит как незагрузившаяся текстура. Светлое дневное небо
  // звёзды, понятно, только испортили бы.
  const night = Math.max(top.r, top.g, top.b) < 0.16 ? 1 : 0;

  const uniforms = {
    zTop:     { value: top },
    zHorizon: { value: horizon },
    zNight:   { value: night }
  };
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 zTop;
      uniform vec3 zHorizon;
      uniform float zNight;
      varying vec3 vDir;

      float sHash(vec2 p){
        return fract(sin(dot(p, vec2(41.7, 289.3))) * 43758.5453);
      }

      void main(){
        // Возведение в степень поднимает горизонт: у настоящего неба переход
        // быстрый внизу и медленный вверху, а не линейный.
        float h = pow(clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0), 0.65);
        vec3 color = mix(zHorizon, zTop, h);

        if (zNight > 0.5){
          // Раскладываем направление взгляда на грань куба и уже НА НЕЙ берём
          // клетку. Брать клетку прямо от vDir нельзя: клетки получаются
          // кубическими в пространстве направлений, плотность гуляет, и звёзды
          // сбиваются в столб ровно по центру экрана — что первая версия
          // честно и показала.
          vec3 a = abs(vDir);
          vec2 uv; float face;
          if (a.x >= a.y && a.x >= a.z){ uv = vDir.yz / a.x; face = 0.0; }
          else if (a.y >= a.z)         { uv = vDir.xz / a.y; face = 5.0; }
          else                         { uv = vDir.xy / a.z; face = 11.0; }

          vec2 grid = uv * 64.0;
          vec2 cell = floor(grid);
          float r = sHash(cell + face * 31.7);
          // Точка внутри клетки в случайном месте и с мягким краем — иначе
          // звёзды выходят квадратными и выдают сетку.
          vec2 spot = fract(grid) - vec2(sHash(cell + 3.1), sHash(cell + 9.7));
          float star = smoothstep(0.978, 1.0, r) * smoothstep(0.14, 0.0, length(spot));
          // Гасим ниже линии горизонта: обзор в шутере почти горизонтальный,
          // и звёзды, спрятанные высоко, не увидит никто.
          star *= smoothstep(-0.03, 0.10, vDir.y);
          color += vec3(star) * (0.35 + 0.65 * sHash(cell + face));
        }
        gl_FragColor = vec4(color, 1.0);
      }`
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(480, 24, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/**
 * Карта окружения из неба и грунта.
 *
 * Мы не грузим готовую панораму: она весила бы мегабайты и не подходила бы ни
 * к «Депо» ночью, ни к «Теплицам» утром. Вместо этого рисуем крошечную сцену
 * из купола и площадки цвета земли и прогоняем её через PMREM — получается
 * честное рассеянное освещение, подходящее ИМЕННО этой карте.
 */
export function buildEnvironment(renderer, { top, horizon, ground }){
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const scene = new THREE.Scene();
  scene.add(buildSky(top, horizon));

  const floor = new THREE.Mesh(
    new THREE.SphereGeometry(460, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: ground, side: THREE.BackSide, fog: false })
  );
  scene.add(floor);

  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  floor.geometry.dispose();
  floor.material.dispose();
  return target.texture;
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

/** Настроить сам рендерер под выбранное качество. */
export function setupRenderer(renderer, quality){
  const q = QUALITY[quality] || QUALITY.medium;

  // Настоящая камера сводит яркое к белому плавно, а не обрезает. Без этого
  // освещённая стена и небо превращаются в одинаковые белые пятна.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = q.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.dpr));
  return q;
}

/**
 * Применить всё к построенной карте: окружение, шум, настройки теней.
 *
 * Вызывается один раз после buildMap. Материалы карты общие на много коробок,
 * поэтому обходим их через набор — иначе один и тот же материал правился бы
 * по сотне раз.
 */
export function dressMap(renderer, scene, map, quality){
  const q = QUALITY[quality] || QUALITY.medium;

  // Разводим зенит и горизонт сильнее, чем они заданы у карты: у настоящего
  // неба разница велика — вверху темнее и синее, у земли светлее и теплее. Без
  // этого купол отличается от прежней плоской заливки только названием.
  const horizon = new THREE.Color(map.fog?.color ?? map.sky).multiplyScalar(1.35);
  const top = new THREE.Color(map.sky).multiplyScalar(0.78);
  const ground = new THREE.Color(map.fog?.color ?? map.sky).multiplyScalar(0.5);

  // Небо куполом вместо плоской заливки. Заливку оставляем как запасной цвет:
  // её видно ровно один кадр, пока купол не нарисовался.
  scene.background = new THREE.Color(map.sky);
  const sky = buildSky(top, horizon);
  scene.add(sky);

  // Воздушная перспектива: экспоненциальный туман честнее линейного — он и
  // есть та дымка, в которой тонут дальние предметы.
  if (map.fog){
    const density = 1.1 / Math.max(40, map.fog.far);
    scene.fog = new THREE.FogExp2(map.fog.color, density);
  }

  if (q.env){
    scene.environment = buildEnvironment(renderer, {
      top: map.sky, horizon: map.fog?.color ?? map.sky, ground: ground.getHex()
    });
  }

  const seen = new Set();
  map.group.traverse(node => {
    const material = node.material;
    if (!material || seen.has(material)) return;
    seen.add(material);

    if (q.env && material.isMeshStandardMaterial){
      // Отражения неба: металл должен отражать сильнее бетона, иначе всё
      // становится одинаково «мокрым».
      material.envMapIntensity = 0.35 + (material.metalness || 0) * 0.9;
    }
    if (q.detail && material.isMeshStandardMaterial && !material.transparent){
      detailMaterial(material, { bump: q.bump, scale: 0.55, tint: 0.13 });
    }
  });

  // Тени: разрешение по качеству. Карты большие, и на 1024 тень от вагона
  // превращается в лесенку из ступенек шириной с человека.
  for (const light of map.lights || []){
    if (!light.castShadow) continue;
    light.shadow.mapSize.set(q.shadow, q.shadow);
    // normalBias убирает «акне» — рябь на наклонных гранях. Обычный bias с
    // этим не справляется, он лечит только «висящие» тени.
    light.shadow.normalBias = 0.035;
    light.shadow.radius = q.id === "low" ? 1 : 2;
    light.shadow.map?.dispose?.();
    light.shadow.map = null;
  }

  return { sky, quality: q };
}

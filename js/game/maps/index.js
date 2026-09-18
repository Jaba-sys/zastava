// index.js — список карт в одном месте. Лобби берёт отсюда описания, игра —
// саму геометрию. Добавить третью карту = положить рядом файл и дописать сюда
// одну строчку.

import * as karier from "./karier.js";
import * as depo    from "./depo.js";

export const MAPS = { karier, depo };
export const MAP_LIST = [karier.meta, depo.meta];

export function mapMeta(id){
  return MAPS[id]?.meta || karier.meta;
}

export function buildMap(id){
  return (MAPS[id] || MAPS.karier).build();
}

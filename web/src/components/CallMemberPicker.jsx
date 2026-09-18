import { useEffect, useMemo, useState } from "react";
import UserAvatar from "./UserAvatar";
import { useLanguage } from "../i18n/LanguageContext";
import { MAX_PARTICIPANTS } from "../utils/groupCalls";

// Выбор, кому звонить в группе: можно отметить всех сразу, а можно отдельных
// людей (см. contexts/GroupCallContext.jsx). Используется и при начале
// звонка, и когда в идущий звонок дозванивают кого-то ещё — разница только в
// том, какие люди попадают в список (уже участвующих в звонке не показываем)
// и в подписи кнопки.
export default function CallMemberPicker({
  people, // [{ id, name, ... }] — кого можно позвать
  busyIds = [], // кто уже в звонке/кому уже звонят — показываем, но без галочки
  limit = MAX_PARTICIPANTS - 1,
  title,
  confirmLabel,
  onConfirm,
  onClose,
}) {
  const { t } = useLanguage();
  const selectable = useMemo(
    () => people.filter((p) => !busyIds.includes(p.id)),
    [people, busyIds]
  );
  const [selected, setSelected] = useState(() => selectable.map((p) => p.id).slice(0, limit));

  // Состав группы может измениться, пока открыт диалог (кто-то вышел, кого-то
  // добавили) — выкидываем из выбора тех, кого уже нельзя позвать.
  useEffect(() => {
    setSelected((prev) => prev.filter((id) => selectable.some((p) => p.id === id)));
  }, [selectable]);

  const allSelected = selected.length > 0 && selected.length === Math.min(selectable.length, limit);

  function toggle(id) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= limit) return prev;
      return prev.concat([id]);
    });
  }

  function toggleAll() {
    setSelected(allSelected ? [] : selectable.map((p) => p.id).slice(0, limit));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal call-picker" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {selectable.length === 0 ? (
          <p className="muted">{t("groupCalls.pickerEmpty")}</p>
        ) : (
          <>
            <button type="button" className="secondary call-picker-all" onClick={toggleAll}>
              {allSelected ? t("groupCalls.pickerClearAll") : t("groupCalls.pickerSelectAll")}
            </button>
            <div className="call-picker-list">
              {people.map((p) => {
                const isBusy = busyIds.includes(p.id);
                const checked = selected.includes(p.id);
                return (
                  <label key={p.id} className={"call-picker-row" + (isBusy ? " call-picker-row-busy" : "")}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isBusy}
                      onChange={() => toggle(p.id)}
                    />
                    <UserAvatar profile={p} fallback={(p.name || "?")[0]?.toUpperCase()} size={32} />
                    <span className="call-picker-name">{p.name || t("common.unknownUser")}</span>
                    {isBusy && <span className="muted call-picker-busy">{t("groupCalls.pickerAlreadyIn")}</span>}
                  </label>
                );
              })}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              {t("groupCalls.pickerSelectedCount", { count: selected.length, max: limit })}
            </p>
          </>
        )}
        <div className="row-buttons">
          <button type="button" className="secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" disabled={selected.length === 0} onClick={() => onConfirm(selected)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

import { friendlyAuthError } from "./authErrors";

// Ошибки доступа к микрофону/камере (getUserMedia) — самая частая причина,
// по которой звонок не начинается. Без перевода человек видел бы сырое
// "NotAllowedError: Permission denied" или вообще ничего.
//
// Используется и личными (contexts/CallContext.jsx), и групповыми
// (contexts/GroupCallContext.jsx) звонками.
export function callSetupError(err, t) {
  switch (err?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return t("calls.mediaDeniedError");
    case "NotFoundError":
    case "DevicesNotFoundError":
      return t("calls.mediaMissingError");
    case "NotReadableError":
    case "TrackStartError":
      return t("calls.mediaBusyError");
    default:
      break;
  }
  // Не медиа-ошибка: код Firebase переводим как обычно, всё остальное
  // показываем как есть — это чаще всего сообщение о сети.
  if (err?.code) return friendlyAuthError(err, t);
  return err?.message || String(err);
}

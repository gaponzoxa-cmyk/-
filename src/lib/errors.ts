/** Перевод технических ошибок в понятный русский: что случилось и что сделать. */
export function humanError(e: unknown): string {
  const msg = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  const m = msg.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "Неверная почта или пароль. Проверьте раскладку клавиатуры и попробуйте ещё раз.";
  if (m.includes("email not confirmed"))
    return "Почта не подтверждена. Откройте письмо от Supabase и нажмите ссылку подтверждения.";
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("network request failed"))
    return "Нет связи с сервером. Проверьте интернет — данные не потеряны, попробуйте ещё раз.";
  if (m.includes("row-level security") || m.includes("permission denied") || m.includes("нет прав"))
    return "Недостаточно прав для этого действия. Обратитесь к владельцу магазина.";
  if (m.includes("duplicate key") && m.includes("name"))
    return "Такое название уже есть. Выберите его из подсказки или назовите иначе.";
  if (m.includes("jwt expired") || m.includes("refresh token"))
    return "Сессия устарела. Войдите в приложение заново.";
  if (/[а-яё]/i.test(msg)) return msg; // сообщение уже по-русски (из базы)
  return `Что-то пошло не так (${msg}). Попробуйте ещё раз; если повторяется — напишите разработчику.`;
}

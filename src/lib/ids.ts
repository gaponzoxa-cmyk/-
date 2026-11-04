/**
 * Постоянный id из текста (SHA-1 → вид UUID). Нужен для импорта:
 * повторный импорт тех же строк даёт те же id и не создаёт дублей.
 */
export async function stableId(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  const h = Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  // версия 5 и вариант RFC 4122
  const v = ((parseInt(h[12], 16) & 0x0) | 0x5).toString(16);
  const r = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}${h.slice(13, 16)}-${r}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

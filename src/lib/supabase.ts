"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Клиент Supabase для браузера. Используется только публичный ключ
 * (publishable / anon) — права проверяет сама база (RLS).
 * Ключ service_role в приложении не используется никогда.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!isConfigured) throw new Error("Supabase не настроен");
  if (!client) {
    client = createClient(url!, key!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "kassa-auth" },
    });
  }
  return client;
}

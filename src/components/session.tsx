"use client";

import type { Session } from "@supabase/supabase-js";
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from "react";
import { isConfigured, supabase } from "@/lib/supabase";
import { humanError } from "@/lib/errors";

export type Role = "owner" | "seller" | "viewer";
export type Shop = {
  id: string;
  name: string;
  role: Role;
  low_markup_pct: number;
  price_round_kop: number;
  price_jump_pct: number;
  default_markup_pct: number;
};

type Ctx = {
  session: Session;
  shop: Shop;
  shops: Shop[];
  selectShop: (id: string) => void;
  signOut: () => Promise<void>;
};

const SessionCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const v = use(SessionCtx);
  if (!v) throw new Error("useApp вне SessionGate");
  return v;
}

export const canSeeCosts = (r: Role) => r === "owner" || r === "viewer";
export const canEnter = (r: Role) => r === "owner" || r === "seller";

const SHOP_KEY = "kassa-shop";

async function fetchShops(userId: string): Promise<{ list: Shop[] | undefined; error: string | null }> {
  const { data, error } = await supabase()
    .from("shop_members")
    .select("role, shops(id, name, low_markup_pct, price_round_kop, price_jump_pct, default_markup_pct)")
    .eq("user_id", userId);
  if (error) return { list: undefined, error: humanError(error) };
  type Row = { role: Role; shops: Omit<Shop, "role"> | null };
  const list = ((data ?? []) as unknown as Row[])
    .filter((r) => r.shops)
    .map((r) => ({
      ...r.shops!,
      role: r.role,
      low_markup_pct: Number(r.shops!.low_markup_pct),
      price_jump_pct: Number(r.shops!.price_jump_pct),
      default_markup_pct: Number(r.shops!.default_markup_pct),
    }));
  return { list, error: null };
}

/**
 * Пускает дальше только вошедшего пользователя с магазином.
 * Иначе показывает вход / создание магазина / подсказку по настройке.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [shops, setShops] = useState<Shop[] | undefined>(undefined);
  const [shopId, setShopId] = useState<string | null>(() => {
    try {
      return typeof window === "undefined" ? null : localStorage.getItem(SHOP_KEY);
    } catch {
      return null;
    }
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfigured) return;
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) setShops(undefined);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // увеличивается, чтобы перечитать список магазинов (после создания или ошибки)
  const [reload, setReload] = useState(0);
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetchShops(userId).then((r) => {
      if (cancelled) return;
      setLoadError(r.error);
      setShops(r.list);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, reload]);

  const retry = useCallback(() => {
    setLoadError(null);
    setShops(undefined);
    setReload((n) => n + 1);
  }, []);

  const selectShop = useCallback((id: string) => {
    setShopId(id);
    try {
      localStorage.setItem(SHOP_KEY, id);
    } catch {}
  }, []);

  const signOut = useCallback(async () => {
    await supabase().auth.signOut();
  }, []);

  if (!isConfigured) return <NotConfigured />;
  if (session === undefined) return <Splash />;
  if (session === null) return <LoginScreen />;
  if (loadError)
    return (
      <Centered>
        <p className="text-lg">{loadError}</p>
        <button
          className="btn btn-primary mt-4 w-full"
          onClick={retry}
        >
          Повторить
        </button>
      </Centered>
    );
  if (shops === undefined) return <Splash />;
  if (shops.length === 0) return <CreateShop onCreated={retry} />;

  const shop = shops.find((s) => s.id === shopId) ?? shops[0];
  return (
    <SessionCtx value={{ session, shop, shops, selectShop, signOut }}>{children}</SessionCtx>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-8">{children}</main>;
}

function Splash() {
  return (
    <Centered>
      <p className="text-center text-muted">Загрузка…</p>
    </Centered>
  );
}

function NotConfigured() {
  return (
    <Centered>
      <h1 className="text-2xl font-bold">Касса</h1>
      <p className="mt-3">Приложение ещё не подключено к базе данных.</p>
      <p className="mt-2 text-muted">
        Добавьте в настройках Vercel переменные <code>NEXT_PUBLIC_SUPABASE_URL</code> и{" "}
        <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> и пересоберите проект — пошагово это
        описано в README, раздел «Запуск».
      </p>
    </Centered>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(humanError(error));
  }

  return (
    <Centered>
      <h1 className="text-3xl font-bold">Касса</h1>
      <p className="mt-1 text-muted">Учёт магазина</p>
      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <label className="field">
          <span>Почта</span>
          <input
            type="email"
            inputMode="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Входим…" : "Войти"}
        </button>
      </form>
    </Centered>
  );
}

function CreateShop({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("Мой магазин");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("create_shop", { p_name: name, p_display_name: null });
    setBusy(false);
    if (error) setError(humanError(error));
    else onCreated();
  }

  return (
    <Centered>
      <h1 className="text-2xl font-bold">Добро пожаловать!</h1>
      <p className="mt-2 text-muted">
        Создадим ваш магазин. Вы станете его владельцем; продавцов можно будет пригласить позже.
      </p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <label className="field">
          <span>Название магазина</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Создаём…" : "Создать магазин"}
        </button>
      </form>
    </Centered>
  );
}

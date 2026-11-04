"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useApp } from "./session";
import { dismissFailed, failedOps, flush, pendingOps, startQueue, subscribeQueue } from "@/lib/queue";

/** Общая рамка экранов: шапка, состояние отправки, нижнее меню. */
export function Shell({ children }: { children: ReactNode }) {
  const { shop, signOut, session } = useApp();
  useEffect(() => startQueue(), []);
  return (
    <>
      <main className="mx-auto w-full max-w-md px-4 pb-28 pt-[max(12px,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between gap-2 py-2">
          <span className="truncate font-semibold">{shop.name}</span>
          <button className="shrink-0 text-sm text-muted underline" onClick={signOut} title={session.user.email}>
            Выйти
          </button>
        </header>
        <QueueStatus />
        {children}
      </main>
      <BottomNav />
    </>
  );
}

const emptyList: never[] = [];
let snapPending: ReturnType<typeof pendingOps> = emptyList;
let snapFailed: ReturnType<typeof failedOps> = emptyList;
function refreshSnap() {
  snapPending = pendingOps();
  snapFailed = failedOps();
}
function subscribe(cb: () => void) {
  refreshSnap();
  return subscribeQueue(() => {
    refreshSnap();
    cb();
  });
}

export function useQueue() {
  const pending = useSyncExternalStore(subscribe, () => snapPending, () => emptyList);
  const failed = useSyncExternalStore(subscribe, () => snapFailed, () => emptyList);
  return { pending, failed };
}

function QueueStatus() {
  const { pending, failed } = useQueue();
  const [open, setOpen] = useState(false);
  if (pending.length === 0 && failed.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      {pending.length > 0 && (
        <button className="alert alert-warn text-left" onClick={() => void flush()}>
          ⏳ Ждут отправки: {pending.length}. Данные сохранены в телефоне и уйдут, когда появится связь. Нажмите,
          чтобы отправить сейчас.
        </button>
      )}
      {failed.length > 0 && (
        <div className="alert alert-error">
          <button className="w-full text-left" onClick={() => setOpen((v) => !v)}>
            ⚠ Не удалось сохранить: {failed.length}. {open ? "Скрыть" : "Подробнее"}
          </button>
          {open && (
            <ul className="mt-2 flex flex-col gap-2">
              {failed.map((f) => (
                <li key={f.opId} className="rounded-lg bg-card p-2 text-fg">
                  <div className="text-sm">
                    {opLabel(f)}: {f.error}
                  </div>
                  <button className="mt-1 text-sm underline" onClick={() => dismissFailed(f.opId)}>
                    Понятно, убрать
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const TABLE_LABEL: Record<string, string> = {
  purchases: "Закупка",
  cash_days: "Касса",
  expenses: "Расход",
  writeoffs: "Списание",
  products: "Товар",
  suppliers: "Поставщик",
};
function opLabel(f: ReturnType<typeof failedOps>[number]): string {
  const name = f.display?.product_name ? ` «${String(f.display.product_name)}»` : "";
  const kind = "table" in f ? (TABLE_LABEL[f.table] ?? f.table) : "Закупка";
  return kind + name;
}

function BottomNav() {
  const path = usePathname();
  const items = [
    { href: "/", label: "День", icon: "📋" },
    { href: "/month", label: "Месяц", icon: "📅" },
    { href: "/trash", label: "Корзина", icon: "🗑" },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-md">
        {items.map((i) => {
          const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
          return (
            <Link
              key={i.href}
              href={i.href}
              className={`flex min-h-16 flex-1 flex-col items-center justify-center text-sm ${active ? "font-bold text-primary" : "text-muted"}`}
            >
              <span className="text-xl" aria-hidden>
                {i.icon}
              </span>
              {i.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

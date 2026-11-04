"use client";

/**
 * Очередь записи в базу. Каждое изменение сначала кладётся в очередь
 * (в памяти телефона), потом отправляется. Если связи нет — остаётся
 * в очереди и уйдёт, когда связь появится. Повторная отправка безопасна:
 * у каждой записи свой id, создаваемый на телефоне.
 */
import { supabase } from "./supabase";
import { humanError } from "./errors";

export type Op =
  | { kind: "insert"; table: string; row: Record<string, unknown> }
  | { kind: "update"; table: string; id: string; patch: Record<string, unknown> }
  | { kind: "upsert"; table: string; row: Record<string, unknown>; onConflict: string }
  | { kind: "rpc"; fn: string; args: Record<string, unknown> };

export type QueuedOp = Op & {
  opId: string;
  at: number;
  /** доп. поля для показа (например, название товара) до отправки */
  display?: Record<string, unknown>;
};

export type FailedOp = QueuedOp & { error: string };

const KEY = "kassa-queue-v1";
const FAILED_KEY = "kassa-queue-failed-v1";

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}
function write(key: string, v: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // переполнение памяти — крайне маловероятно на наших объёмах
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
function emit() {
  listeners.forEach((l) => l());
}
export function subscribeQueue(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function pendingOps(): QueuedOp[] {
  return read<QueuedOp>(KEY);
}
export function failedOps(): FailedOp[] {
  return read<FailedOp>(FAILED_KEY);
}
export function dismissFailed(opId: string) {
  write(FAILED_KEY, failedOps().filter((o) => o.opId !== opId));
  emit();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function enqueue(op: Op, display?: Record<string, unknown>) {
  const q = pendingOps();
  q.push({ ...op, opId: newId(), at: Date.now(), display });
  write(KEY, q);
  emit();
  void flush();
}

function isTransient(err: { message?: string } | null, status: number): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (status === 0 || status >= 500 || status === 408 || status === 429) return true;
  const m = (err?.message ?? "").toLowerCase();
  return m.includes("fetch") || m.includes("network") || m.includes("load failed") || m.includes("timeout");
}

async function run(op: Op): Promise<{ error: { message: string; code?: string } | null; status: number }> {
  const sb = supabase();
  try {
    switch (op.kind) {
      case "insert": {
        // Обычная вставка. Если запись с таким id уже есть (повторная отправка
        // после обрыва связи) — это успех, а не ошибка.
        const r = await sb.from(op.table).insert(op.row);
        if (r.error?.code === "23505" && /_pkey/.test(r.error.message)) return { error: null, status: 201 };
        return { error: r.error, status: r.status };
      }
      case "update": {
        const r = await sb.from(op.table).update(op.patch).eq("id", op.id);
        return { error: r.error, status: r.status };
      }
      case "upsert": {
        const r = await sb.from(op.table).upsert(op.row, { onConflict: op.onConflict });
        return { error: r.error, status: r.status };
      }
      case "rpc": {
        const r = await sb.rpc(op.fn, op.args);
        return { error: r.error, status: r.status };
      }
    }
  } catch (e) {
    return { error: { message: String(e) }, status: 0 };
  }
}

let flushing: Promise<void> | null = null;

/** Отправить всё, что накопилось. Идёт строго по порядку. */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    // await в начале: иначе при пустой очереди finally сработал бы раньше,
    // чем flushing присвоится, и очередь «залипла» бы навсегда
    await Promise.resolve();
    try {
      for (;;) {
        const q = pendingOps();
        if (q.length === 0) break;
        const op = q[0];
        const { error, status } = await run(op);
        if (error && isTransient(error, status)) break; // ждём связи
        const rest = pendingOps().filter((o) => o.opId !== op.opId);
        write(KEY, rest);
        if (error) {
          write(FAILED_KEY, [...failedOps(), { ...op, error: humanError(error) }]);
        }
        emit();
      }
    } finally {
      flushing = null;
      emit();
    }
  })();
  return flushing;
}

let started = false;
/** Запускает автоотправку: при появлении сети и раз в 20 секунд. */
export function startQueue() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("online", () => void flush());
  setInterval(() => {
    if (pendingOps().length) void flush();
  }, 20000);
  void flush();
}

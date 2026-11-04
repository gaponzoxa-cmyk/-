"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Полноэкранная панель снизу (на телефоне занимает весь экран). */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mx-auto flex w-full max-w-md items-center gap-2 px-4 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
        <h2 className="flex-1 text-xl font-bold">{title}</h2>
        <button className="btn btn-icon" onClick={onClose} aria-label="Закрыть">
          ✕
        </button>
      </div>
      <div className="mx-auto w-full max-w-md flex-1 overflow-y-auto px-4 pb-[max(24px,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}

/** Подтверждение удаления прямо на странице. */
export function ConfirmBar({
  text,
  confirmLabel = "Удалить",
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="alert alert-error mt-3 flex flex-col gap-3">
      <span>{text}</span>
      <div className="flex gap-2">
        <button className="btn flex-1" onClick={onCancel}>
          Отмена
        </button>
        <button className="btn flex-1 !border-transparent !bg-bad !text-white" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** Поле для чисел: принимает запятую, открывает цифровую клавиатуру. */
export function NumField({
  label,
  value,
  onChange,
  suffix,
  placeholder,
  enterKeyHint = "next",
  autoFocus,
  inputRef,
  onEnter,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
  enterKeyHint?: "next" | "done" | "enter";
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onEnter?: () => void;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="relative">
        <input
          ref={inputRef}
          className="num w-full pr-12"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint={enterKeyHint}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,\s]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter?.();
            }
          }}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted">{suffix}</span>}
      </div>
      {hint && <span className="text-sm">{hint}</span>}
    </label>
  );
}

/** Текстовое поле с подсказками из списка (товары, поставщики). */
export function SuggestField<T extends { id: string; name: string }>({
  label,
  value,
  onChange,
  items,
  onPick,
  placeholder,
  inputRef,
  onEnter,
  renderMeta,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: T[];
  onPick: (item: T) => void;
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onEnter?: () => void;
  renderMeta?: (item: T) => ReactNode;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const q = value.trim().toLowerCase();
  const matches = q
    ? items
        .filter((i) => i.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 6)
    : [];
  const exact = matches.some((m) => m.name.toLowerCase() === q);
  return (
    <div className="field relative">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={inputRef}
        type="text"
        autoComplete="off"
        autoCapitalize="sentences"
        enterKeyHint="next"
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (matches.length > 0 && !exact && open) onPick(matches[0]);
            setOpen(false);
            onEnter?.();
          }
        }}
      />
      {open && matches.length > 0 && !exact && (
        <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-line bg-card shadow-lg">
          {matches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-lg text-fg"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(m);
                  setOpen(false);
                  onEnter?.();
                }}
              >
                <span>{m.name}</span>
                {renderMeta && <span className="num text-sm text-muted">{renderMeta(m)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Переключатель из нескольких вариантов. */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  label?: string;
}) {
  return (
    <div className="field">
      {label && <span>{label}</span>}
      <div className="flex gap-1 rounded-xl border border-line bg-card p-1" role="radiogroup">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={`min-h-11 flex-1 rounded-lg px-2 text-base font-semibold ${
              value === o.value ? "bg-primary text-[var(--primary-fg)]" : "text-fg"
            }`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Возвращает ref и функцию «перейти к этому полю». */
export function useFocusRef() {
  const ref = useRef<HTMLInputElement>(null);
  const focus = () => {
    ref.current?.focus();
    ref.current?.select();
  };
  return [ref, focus] as const;
}

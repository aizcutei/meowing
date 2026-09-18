/** Small presentational primitives shared by the page. */

import type { ReactNode } from "react";

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const styles = {
    primary:
      "bg-sky-500 text-white hover:bg-sky-400 disabled:bg-sky-500/40 disabled:text-white/60",
    secondary:
      "border border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10 disabled:opacity-40",
    ghost: "text-zinc-400 hover:text-zinc-100 hover:bg-white/5 disabled:opacity-40",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg px-2 py-1.5 ${
        disabled ? "opacity-40" : "cursor-pointer hover:bg-white/5"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-white/20 bg-white/10 accent-sky-500"
      />
      <span className="min-w-0">
        <span className="block text-sm text-zinc-200">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span> : null}
      </span>
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  mono,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: "text" | "url" | "number" | "password";
  mono?: boolean;
  invalid?: boolean;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={`w-full rounded-lg border bg-black/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 ${
          invalid ? "border-rose-500/60" : "border-white/10"
        } ${mono ? "font-mono text-[13px]" : ""}`}
      />
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 8,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  rows?: number;
  invalid?: boolean;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className={`w-full resize-y rounded-lg border bg-black/30 px-3 py-2 font-mono text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 ${
          invalid ? "border-rose-500/60" : "border-white/10"
        }`}
      />
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-zinc-900">
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="text-xs text-zinc-500">{label}</div>
      <div
        className={`mt-0.5 font-mono text-lg leading-tight ${
          tone === "warn" ? "text-amber-300" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

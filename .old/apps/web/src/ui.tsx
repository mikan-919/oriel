/** 出窓の格子(mullion)をかたどった、Orielのワードマーク用ロゴ。 */
export function Logo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="3"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
      />
      <path
        d="M10 1.5V18.5M1.5 10H18.5"
        stroke="var(--color-accent)"
        strokeWidth="1.4"
        strokeOpacity="0.55"
      />
    </svg>
  );
}

export const inputClass =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-faint transition-colors focus:border-accent focus:outline-none";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

export function PrimaryButton({
  disabled,
  children,
}: {
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-sidebar shadow-sm transition-all hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
    >
      {children}
    </button>
  );
}

export function StatusDot({ tone }: { tone: "live" | "fail" }) {
  return (
    <span
      aria-hidden
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
        tone === "fail" ? "bg-fail" : "pane-live bg-live"
      }`}
    />
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: ReactNode;
  /** Optional search / a11y text when label is not a plain string */
  text?: string;
  disabled?: boolean;
};

export type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Empty state when options is empty */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Compact sizing for filter bars */
  size?: "md" | "sm";
  /** Stretch to parent width (forms). Default true. */
  fullWidth?: boolean;
  "aria-label"?: string;
  id?: string;
  style?: CSSProperties;
};

function optionText(o: SelectOption): string {
  if (o.text) return o.text;
  if (typeof o.label === "string" || typeof o.label === "number") return String(o.label);
  return o.value;
}

/**
 * Styled listbox — replaces native &lt;select&gt; popup chrome so menus match the product UI.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  className = "",
  size = "md",
  fullWidth = true,
  "aria-label": ariaLabel,
  id,
  style,
}: SelectProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const selected = options.find((o) => o.value === value);
  /** Closed trigger prefers plain `text` so rich option labels (multi-line) stay menu-only */
  const selectedText = selected
    ? selected.text ??
      (typeof selected.label === "string" || typeof selected.label === "number"
        ? String(selected.label)
        : selected.value)
    : placeholder;
  const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);

  const placeMenu = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const maxH = Math.min(280, window.innerHeight - 16);
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const openUp = spaceBelow < 160 && r.top > spaceBelow;
    const width = Math.max(r.width, 140);
    setMenuStyle({
      position: "fixed",
      left: Math.min(r.left, window.innerWidth - width - 8),
      width,
      zIndex: 2000,
      maxHeight: maxH,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + 6 }
        : { top: r.bottom + 6 }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
    const onScroll = () => placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, placeMenu, options.length]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActiveIdx(idx >= 0 ? idx : enabled[0]?.i ?? 0);
    const t = window.setTimeout(() => {
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
        block: "nearest",
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, value, options, enabled]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const cur = enabled.findIndex(({ i }) => i === activeIdx);
      const next = enabled[Math.min(enabled.length - 1, cur + 1)];
      if (next) setActiveIdx(next.i);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const cur = enabled.findIndex(({ i }) => i === activeIdx);
      const next = enabled[Math.max(0, cur - 1)];
      if (next) setActiveIdx(next.i);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt && !opt.disabled) pick(opt.value);
    }
  }

  const cls = [
    "cs-select",
    size === "sm" ? "cs-select-sm" : "",
    fullWidth ? "cs-select-full" : "",
    open ? "open" : "",
    disabled ? "disabled" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <ul
            ref={listRef}
            id={listId}
            className="cs-select-menu"
            role="listbox"
            style={menuStyle}
            aria-label={ariaLabel}
          >
            {options.length === 0 ? (
              <li className="cs-select-empty" role="presentation">
                No options
              </li>
            ) : (
              options.map((o, i) => {
                const isSel = o.value === value;
                const isActive = i === activeIdx;
                return (
                  <li
                    key={o.value}
                    role="option"
                    aria-selected={isSel}
                    aria-disabled={o.disabled || undefined}
                    data-active={isActive ? "true" : undefined}
                    className={[
                      "cs-select-option",
                      isSel ? "selected" : "",
                      isActive ? "active" : "",
                      o.disabled ? "disabled" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onMouseEnter={() => !o.disabled && setActiveIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!o.disabled) pick(o.value);
                    }}
                  >
                    <span className="cs-select-option-label">{o.label}</span>
                    {isSel && <span className="cs-select-check" aria-hidden>✓</span>}
                  </li>
                );
              })
            )}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className={cls} style={style}>
      <button
        ref={btnRef}
        type="button"
        id={id}
        className="cs-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className={`cs-select-value${selected ? "" : " placeholder"}`}>
          {selected ? selectedText : placeholder}
        </span>
        <span className="cs-select-chevron" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 4.25L6 7.75L9.5 4.25"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {menu}
    </div>
  );
}

/** Helper to build options from string arrays */
export function optionsFromValues(values: string[], labels?: Record<string, string>): SelectOption[] {
  return values.map((v) => ({ value: v, label: labels?.[v] ?? v }));
}

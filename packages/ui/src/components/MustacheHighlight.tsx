import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

/** Split text and wrap `{{var}}` tokens for highlighting. */
export function highlightMustache(text: string): ReactNode[] {
  if (!text) return [];
  const re = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={`t${i++}`}>{text.slice(last, m.index)}</span>);
    }
    const part = m[0];
    const name = part.replace(/^\{\{\s*|\s*\}\}$/g, "");
    nodes.push(
      <mark
        key={`m${i++}`}
        className="mustache-token"
        data-var={name}
        title={`Runtime variable: ${name}`}
      >
        {part}
      </mark>,
    );
    last = m.index + part.length;
  }
  if (last < text.length) {
    nodes.push(<span key={`t${i++}`}>{text.slice(last)}</span>);
  }
  return nodes;
}

/** Read-only block with mustache tokens highlighted. */
export function MustacheBlock({
  text,
  className = "",
  dashed,
  footer,
}: {
  text: string;
  className?: string;
  dashed?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div className={`mustache-block${dashed ? " mustache-block-dashed" : ""} ${className}`.trim()}>
      <pre className="mustache-pre mono">{highlightMustache(text)}</pre>
      {footer}
    </div>
  );
}

/**
 * Editable field with live mustache highlighting (mirror layer under transparent textarea).
 */
export function MustacheEditor({
  value,
  onChange,
  rows,
  disabled,
  className = "",
  maxLength,
  showCount = true,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  disabled?: boolean;
  className?: string;
  /** Hard cap — characters beyond this are not accepted. */
  maxLength?: number;
  showCount?: boolean;
  "aria-label"?: string;
}) {
  const id = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLPreElement>(null);
  const lineCount = Math.max(4, Math.min(14, (value.match(/\n/g)?.length ?? 0) + 2));
  const resolvedRows = rows ?? lineCount;
  const len = value.length;
  const nearLimit = maxLength != null && len >= maxLength * 0.9;
  const atLimit = maxLength != null && len >= maxLength;

  useEffect(() => {
    const ta = taRef.current;
    const back = backRef.current;
    if (!ta || !back) return;
    const sync = () => {
      back.scrollTop = ta.scrollTop;
      back.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener("scroll", sync);
    return () => ta.removeEventListener("scroll", sync);
  }, []);

  const style: CSSProperties = {
    // ensure same metrics for overlay
    ["--mustache-rows" as string]: String(resolvedRows),
  };

  return (
    <div className={`mustache-editor-wrap ${className}`.trim()}>
      <div
        className={`mustache-editor${atLimit ? " mustache-editor-at-limit" : ""}`}
        style={style}
      >
        <pre ref={backRef} className="mustache-editor-back mono" aria-hidden>
          {highlightMustache(value)}
          {/* trailing newline keeps height in sync when last line is empty */}
          {value.endsWith("\n") ? "\n" : ""}
        </pre>
        <textarea
          ref={taRef}
          id={id}
          className="mustache-editor-front mono"
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          spellCheck={false}
          rows={resolvedRows}
          maxLength={maxLength}
          onChange={(e) => {
            const next = e.target.value;
            if (maxLength != null && next.length > maxLength) {
              onChange(next.slice(0, maxLength));
              return;
            }
            onChange(next);
          }}
          onScroll={() => {
            if (backRef.current && taRef.current) {
              backRef.current.scrollTop = taRef.current.scrollTop;
              backRef.current.scrollLeft = taRef.current.scrollLeft;
            }
          }}
        />
      </div>
      {showCount && maxLength != null && (
        <div
          className={`mustache-char-count mono${nearLimit ? " warn" : ""}${atLimit ? " limit" : ""}`}
          aria-live="polite"
        >
          {len.toLocaleString()} / {maxLength.toLocaleString()}
        </div>
      )}
    </div>
  );
}

/** Chip list of available variables for a component. */
export function MustacheVarChips({
  vars,
  onInsert,
}: {
  vars?: string[];
  onInsert?: (token: string) => void;
}) {
  if (!vars?.length) return null;
  return (
    <div className="mustache-chips" role="list" aria-label="Template variables">
      {vars.map((v) => {
        const token = `{{${v}}}`;
        return (
          <button
            key={v}
            type="button"
            role="listitem"
            className="mustache-chip"
            title={onInsert ? `Insert ${token}` : token}
            onClick={() => onInsert?.(token)}
            disabled={!onInsert}
          >
            {token}
          </button>
        );
      })}
    </div>
  );
}

export type { TextareaHTMLAttributes };

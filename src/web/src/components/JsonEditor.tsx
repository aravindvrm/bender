import { useCallback, useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle, WrapText } from "lucide-react";

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function tryParseJson(text: string): { valid: boolean; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { valid: true };
  try {
    JSON.parse(trimmed);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

function formatJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/**
 * A JSON-aware textarea with:
 * - Tab → 2-space indent (no focus trap)
 * - Shift+Tab → dedent selection
 * - Live valid/invalid indicator
 * - Format (pretty-print) button
 * - Monospace styling consistent with the rest of the editor
 */
export function JsonEditor({
  value,
  onChange,
  rows = 10,
  label,
  placeholder,
  disabled = false,
  className = "",
}: JsonEditorProps) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);

  const validation = useMemo(() => tryParseJson(value), [value]);
  const isEmpty = !value.trim();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;

      const { selectionStart, selectionEnd, value: current } = el;

      if (e.shiftKey) {
        // Shift+Tab: remove up to 2 leading spaces from each selected line
        const lineStart = current.lastIndexOf("\n", selectionStart - 1) + 1;
        const lineEnd = selectionEnd;
        const selectedLines = current.slice(lineStart, lineEnd).split("\n");
        const dedented = selectedLines.map((line) =>
          line.startsWith("  ") ? line.slice(2) : line.startsWith(" ") ? line.slice(1) : line,
        );
        const replacement = dedented.join("\n");
        const next = current.slice(0, lineStart) + replacement + current.slice(lineEnd);
        onChange(next);
        requestAnimationFrame(() => {
          el.selectionStart = lineStart;
          el.selectionEnd = lineStart + replacement.length;
        });
      } else {
        // Tab: insert 2 spaces at cursor (or indent each selected line)
        const hasMultiLineSelection = selectionEnd > selectionStart
          && current.slice(selectionStart, selectionEnd).includes("\n");

        if (hasMultiLineSelection) {
          const lineStart = current.lastIndexOf("\n", selectionStart - 1) + 1;
          const lineEnd = selectionEnd;
          const selectedLines = current.slice(lineStart, lineEnd).split("\n");
          const indented = selectedLines.map((line) => "  " + line).join("\n");
          const next = current.slice(0, lineStart) + indented + current.slice(lineEnd);
          onChange(next);
          requestAnimationFrame(() => {
            el.selectionStart = lineStart;
            el.selectionEnd = lineStart + indented.length;
          });
        } else {
          const next = current.slice(0, selectionStart) + "  " + current.slice(selectionEnd);
          onChange(next);
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = selectionStart + 2;
          });
        }
      }
    },
    [onChange],
  );

  const handleFormat = useCallback(() => {
    if (!validation.valid || isEmpty) return;
    onChange(formatJson(value));
  }, [isEmpty, onChange, validation.valid, value]);

  const borderColor = focused
    ? validation.valid
      ? "border-zinc-400/60"
      : "border-red-500/60"
    : "border-zinc-700/80";

  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && (
        <div className="flex items-center justify-between">
          <label htmlFor={id} className="text-[11px] text-zinc-500 uppercase tracking-[0.08em]">
            {label}
          </label>
          <div className="flex items-center gap-2">
            {/* Format button */}
            {!isEmpty && validation.valid && (
              <button
                type="button"
                onClick={handleFormat}
                disabled={disabled}
                title="Format JSON"
                className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40"
              >
                <WrapText className="h-3 w-3" />
                Format
              </button>
            )}
            {/* Validity indicator */}
            {!isEmpty && (
              <span
                title={validation.error}
                className={`flex items-center gap-1 text-[10px] ${
                  validation.valid ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {validation.valid ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {validation.valid ? "valid" : "invalid"}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="relative">
        <textarea
          ref={textareaRef}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={rows}
          disabled={disabled}
          placeholder={placeholder ?? "{}"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={`w-full resize-y rounded-lg border bg-[#0d0d0f] px-3 py-2.5 text-[12px] font-mono leading-[1.6] text-zinc-200 outline-none placeholder:text-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${borderColor} ${
            !validation.valid && !isEmpty ? "focus:ring-1 focus:ring-red-500/20" : ""
          }`}
          style={{ tabSize: 2 }}
        />
        {/* Bottom-right inline validity when no label */}
        {!label && !isEmpty && (
          <span
            title={validation.error}
            className={`absolute bottom-2 right-2 flex items-center gap-1 text-[10px] pointer-events-none ${
              validation.valid ? "text-emerald-700" : "text-red-500/80"
            }`}
          >
            {validation.valid ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
          </span>
        )}
      </div>
      {/* Error hint */}
      {!validation.valid && !isEmpty && validation.error && (
        <p className="text-[10px] text-red-400/80 font-mono truncate" title={validation.error}>
          {validation.error}
        </p>
      )}
    </div>
  );
}

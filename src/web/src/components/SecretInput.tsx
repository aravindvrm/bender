import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  autoComplete?: string;
}

export function SecretInput({
  value,
  onChange,
  placeholder,
  className,
  inputClassName,
  disabled,
  autoComplete,
}: SecretInputProps) {
  const [show, setShow] = useState(false);
  const looksBackendMasked = value.length > 0 && /^•+$/.test(value);
  const revealMaskedLabel = "stored secret (re-enter to replace)";
  const displayValue = show && looksBackendMasked ? revealMaskedLabel : value;
  const readOnlyMaskedReveal = show && looksBackendMasked;

  return (
    <div className={className ?? "relative"}>
      <input
        type={show ? "text" : "password"}
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnlyMaskedReveal}
        autoComplete={autoComplete}
        className={inputClassName ?? "w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 pr-10 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        disabled={disabled}
        aria-label={show ? "Hide secret" : "Show secret"}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      {readOnlyMaskedReveal && (
        <p className="mt-1 text-[11px] text-zinc-500">
          Stored value is masked by backend; type a new value to replace it.
        </p>
      )}
    </div>
  );
}

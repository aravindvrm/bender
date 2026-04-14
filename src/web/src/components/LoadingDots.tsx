interface LoadingDotsProps {
  size?: number;
  label?: string;
  className?: string;
  textClassName?: string;
}

export function LoadingDots({
  size = 14,
  label,
  className = "",
  textClassName = "text-xs text-zinc-500",
}: LoadingDotsProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className="bender-loader"
        style={{ ["--loader-size" as string]: `${size}px` }}
        aria-hidden="true"
      />
      {label ? <span className={textClassName}>{label}</span> : null}
    </div>
  );
}

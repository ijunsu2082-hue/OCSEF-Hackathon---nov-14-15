import { cx } from "./cx";

export interface SparklineProps {
  /** Series in display order; last value is the current one. */
  values: number[];
  width?: number;
  height?: number;
  /** CSS color; defaults to the accent token so the stress theme retints it. */
  stroke?: string;
  /** Draw a filled area under the line. */
  area?: boolean;
  className?: string;
}

/**
 * Dependency-free inline SVG sparkline (no Recharts instance for 12 data points).
 * Returns null-ish empty box when there is nothing to draw, so layout never jumps.
 */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  stroke = "var(--accent)",
  area = false,
  className,
}: SparklineProps) {
  const padded = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - padded * 2) / (values.length - 1) : 0;

  const points = values.map((value, index) => {
    const x = padded + index * step;
    const y = height - padded - ((value - min) / span) * (height - padded * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  if (points.length < 2) {
    return <div className={cx("h-[var(--sh,24px)]", className)} style={{ width }} aria-hidden />;
  }

  const path = points.join(" ");
  const areaPath = `M${padded},${height - padded} L${path.replace(/ /g, " L")} L${width - padded},${height - padded} Z`;

  return (
    <svg
      className={cx("num block", className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-hidden
      style={{ overflow: "visible" }}
    >
      {area && <path d={areaPath} fill={stroke} opacity={0.12} stroke="none" />}
      <polyline
        points={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

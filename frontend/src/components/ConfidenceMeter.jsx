import { useEffect, useState } from 'react';

/**
 * Radial confidence meter.
 *
 * A bare "82" is a number the eye has to read. A ring that fills to 82% is a
 * quantity the eye *sees* — and because confidence is the single most important
 * caveat on a verdict, it deserves to be pre-attentive.
 *
 * The ring animates from empty to its value on mount: we render at 0 for one
 * frame, then set the real offset so CSS has two values to transition between.
 */
export function ConfidenceMeter({ value = 0, color = 'var(--brand-500)', size = 58 }) {
  const [displayValue, setDisplayValue] = useState(0);

  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));

  useEffect(() => {
    // requestAnimationFrame guarantees the browser has painted the 0 state
    // before we change it, which is what makes the fill actually animate.
    const frame = requestAnimationFrame(() => setDisplayValue(clamped));
    return () => cancelAnimationFrame(frame);
  }, [clamped]);

  const offset = circumference - (displayValue / 100) * circumference;

  return (
    <div className="meter" title={`Confidence: ${clamped} out of 100`}>
      <svg className="meter__ring" width={size} height={size} aria-hidden="true">
        <circle className="meter__track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="meter__value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ stroke: color }}
        />
        {/* The number sits inside the ring; the group is un-rotated so the text
            stays upright despite the ring's -90deg rotation. */}
        <g transform={`rotate(90 ${size / 2} ${size / 2})`}>
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="central"
            className="meter__number"
            fill="var(--text)"
            style={{ fontSize: 14, fontWeight: 700 }}
          >
            {clamped}
          </text>
        </g>
      </svg>
      <span className="meter__caption">confidence</span>
      {/* The visual is decorative; this is the accessible equivalent. */}
      <span className="sr-only">Confidence {clamped} out of 100</span>
    </div>
  );
}

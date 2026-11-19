import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TechTermProps {
  label: string;
  tip: string;
  className?: string;
}

/**
 * Accessible inline technical term with a subtle dotted underline and
 * viewport-safe floating tooltip rendered via React Portal.
 */
export function TechTerm({ label, tip, className = '' }: TechTermProps) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const [coords, setCoords] = useState<{ top: number; left: number; placement: 'top' | 'bottom' } | null>(
    null
  );

  const openTip = useCallback(() => {
    const el = triggerRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const tooltipWidth = 260;
    const margin = 12;
    const centerX = rect.left + rect.width / 2;
    const clampedLeft = Math.max(
      margin + tooltipWidth / 2,
      Math.min(window.innerWidth - margin - tooltipWidth / 2, centerX)
    );
    const showAbove = rect.top > 96;
    setCoords({
      top: showAbove ? rect.top - 8 : rect.bottom + 8,
      left: clampedLeft,
      placement: showAbove ? 'top' : 'bottom',
    });
  }, []);

  const closeTip = useCallback(() => {
    setCoords(null);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={coords ? tooltipId : undefined}
        onMouseEnter={openTip}
        onMouseLeave={closeTip}
        onFocus={openTip}
        onBlur={closeTip}
        className={`inline-flex items-center border-b border-dotted border-current/55 cursor-help focus:outline-none focus:ring-1 focus:ring-sky-500 rounded-[1px] ${className}`}
      >
        {label}
      </span>

      {coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            style={{
              position: 'fixed',
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              transform:
                coords.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
              maxWidth: '260px',
            }}
            className="z-[100] pointer-events-none px-3 py-2 rounded-xl border app-tooltip text-[11px] leading-relaxed font-sans font-normal shadow-lg"
          >
            {tip}
          </span>,
          document.body
        )}
    </>
  );
}

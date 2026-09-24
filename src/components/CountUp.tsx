import { useEffect, useRef, useState } from 'react'

/**
 * A figure that counts up to its value when it first appears and when the value changes — an
 * applied update then visibly moves the numbers that moved, instead of swapping them silently.
 *
 * Only the display animates: the value itself is never approximated, and the final frame is always
 * the exact figure. Under `prefers-reduced-motion` it is simply the figure.
 */
export function CountUp({ value, duration = 700 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(value)
  const from = useRef(0)

  useEffect(() => {
    const start = from.current
    from.current = value
    if (start === value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / duration)
      // ease-out cubic: most of the travel early, settling gently onto the figure
      const e = 1 - (1 - k) ** 3
      setShown(k < 1 ? Math.round(start + (value - start) * e) : value)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return <>{shown.toLocaleString()}</>
}

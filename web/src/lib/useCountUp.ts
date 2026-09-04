import { useEffect, useRef, useState } from 'react'

/**
 * Counts a figure up to its value once, on first paint.
 *
 * A dashboard number that lands rather than appears tells you it was just
 * measured. It runs once per value change, not on a loop, and honours reduced
 * motion by showing the figure immediately — the animation is decoration, the
 * number is the content.
 */
export function useCountUp(value: number, duration = 900): number {
  const [shown, setShown] = useState(value)
  const from = useRef(value)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value)
      from.current = value
      return
    }

    const start = performance.now()
    const origin = from.current
    const delta = value - origin
    if (delta === 0) return

    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      // Ease out: the figure decelerates into place instead of stopping dead.
      const eased = 1 - (1 - t) ** 3
      setShown(Math.round(origin + delta * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
      else from.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, duration])

  return shown
}

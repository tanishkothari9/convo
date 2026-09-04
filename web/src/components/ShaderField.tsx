import { useEffect, useState } from 'react'
import { MeshGradient } from '@paper-design/shaders-react'

/**
 * The animated gradient field behind the landing hero.
 *
 * A real WebGL shader, wrapped so it degrades honestly:
 *
 *  - It only mounts after the page has painted, so the headline is never
 *    waiting on a GL context.
 *  - `prefers-reduced-motion` freezes it rather than removing it. The field
 *    carries the page's colour, and dropping it would leave a hole; what the
 *    setting is asking to remove is the movement.
 *  - A device with no WebGL keeps the CSS gradient underneath, which is why
 *    that gradient is painted on the wrapper rather than by the shader.
 */

/*
 * Weighted toward green on purpose. The field animates, so any colour given
 * equal share will at some point own the frame — and a brand that reads violet
 * for a few seconds every cycle is not a brand. The single indigo is depth at
 * the far end of the travel, not a second accent.
 */
const COLORS = ['#04160f', '#072a1f', '#0b3d2e', '#14563f', '#1b6b54', '#2fb08a', '#14b8a6', '#2b2a72']

export function ShaderField({
  className,
  speed = 0.18,
  swirl = 0.72,
  distortion = 0.85,
  colors = COLORS,
}: {
  className?: string
  speed?: number
  swirl?: number
  distortion?: number
  colors?: string[]
}) {
  const [mounted, setMounted] = useState(false)
  const [supported, setSupported] = useState(true)
  const [still, setStill] = useState(false)

  useEffect(() => {
    // Ask the browser directly rather than assuming: a machine with GL disabled
    // should get the CSS field, not an empty canvas.
    try {
      const probe = document.createElement('canvas')
      setSupported(Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl')))
    } catch {
      setSupported(false)
    }

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setStill(motion.matches)
    sync()
    motion.addEventListener('change', sync)

    const frame = requestAnimationFrame(() => setMounted(true))
    return () => {
      cancelAnimationFrame(frame)
      motion.removeEventListener('change', sync)
    }
  }, [])

  return (
    <div className={`shader-field ${className ?? ''}`} aria-hidden="true">
      {mounted && supported && (
        <MeshGradient
          className="shader-field-canvas"
          colors={colors}
          distortion={distortion}
          swirl={swirl}
          grainMixer={0.32}
          grainOverlay={0.14}
          speed={still ? 0 : speed}
        />
      )}
      {/* Grain and a vignette sit above the shader so the field has a surface. */}
      <div className="shader-field-grain" />
      <div className="shader-field-vignette" />
    </div>
  )
}

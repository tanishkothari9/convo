import { useEffect } from 'react'

/**
 * Marks the document as one of Convo's dark surfaces.
 *
 * The landing and the auth pages paint their own dark field, but the document
 * behind them is still the light canvas — which shows through on an overscroll
 * bounce as a white flash at the top or bottom of the page. Setting it on the
 * root element rather than on a wrapper is the only way to reach that.
 */
export function useDarkSurface(): void {
  useEffect(() => {
    document.documentElement.dataset.surface = 'dark'
    return () => {
      delete document.documentElement.dataset.surface
    }
  }, [])
}

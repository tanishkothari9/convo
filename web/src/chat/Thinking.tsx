import { useEffect, useRef, useState } from 'react'

/**
 * The moment between sending and receiving.
 *
 * This is the one place in Convo where motion is allowed to be the point: it
 * is the only thing a customer has to look at while they wait, and a bare
 * spinner here would say nothing about what is happening.
 *
 * Three states, in order:
 *   1. Three dots, breathing in sequence — appears on the same frame the
 *      message is sent, with no delay of any kind.
 *   2. A status line the agent wrote for this specific call ("looking through
 *      the catalogue"), which replaces the dots. Successive statuses cross-fade
 *      through a slight blur, so the two lines read as one line changing rather
 *      than two lines swapping.
 *   3. Gone, the instant the first token of the reply arrives.
 */
export function Thinking({ status }: { status: string | null }) {
  // Keep the outgoing status mounted for the length of the cross-fade.
  const [shown, setShown] = useState<string | null>(status)
  const [fading, setFading] = useState(false)
  const previous = useRef(status)

  useEffect(() => {
    if (status === previous.current) return
    previous.current = status
    if (shown === null) {
      setShown(status)
      return
    }
    setFading(true)
    const timer = setTimeout(() => {
      setShown(status)
      setFading(false)
    }, 130)
    return () => clearTimeout(timer)
  }, [status, shown])

  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="thinking-dots" data-compact={shown !== null} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {shown !== null && (
        <span className="thinking-status" data-fading={fading}>
          {shown}
        </span>
      )}
      <span className="visually-hidden">{shown ?? 'Thinking'}</span>
    </div>
  )
}

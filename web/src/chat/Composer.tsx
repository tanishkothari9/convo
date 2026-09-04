import { useEffect, useRef, useState } from 'react'

/**
 * The composer, and the chips that sit above it.
 *
 * The chips belong here rather than in the transcript: they are what to do
 * next, so they live next to the place you act, and they stay reachable
 * without scrolling back up.
 */
import { IconSend } from '../components/icons'

export function Composer({
  brandName,
  chips,
  busy,
  closed,
  onSend,
}: {
  brandName: string
  chips: string[]
  busy: boolean
  /** The brand has no catalogue, so there is nothing to answer with. */
  closed?: boolean
  onSend(text: string): void
}) {
  const [value, setValue] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)

  // Grow with the content, up to a point, then scroll inside itself.
  useEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`
  }, [value])

  function submit() {
    const text = value.trim()
    if (text === '' || busy || closed) return
    setValue('')
    onSend(text)
    field.current?.focus()
  }

  return (
    <div className="composer-layer">
      {chips.length > 0 && !closed && (
        <div className="chip-rail">
          {chips.map((chip, index) => (
            <button
              key={chip}
              className="chip chip-suggestion"
              style={{ animationDelay: `${index * 45}ms` }}
              onClick={() => onSend(chip)}
              disabled={busy}
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={field}
          className="composer-field"
          rows={1}
          value={value}
          disabled={closed}
          placeholder={closed ? 'This shop is not open for messages yet' : `Message ${brandName}`}
          aria-label={closed ? 'Messaging is closed' : `Message ${brandName}`}
          maxLength={2000}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button
          className="composer-send"
          type="submit"
          disabled={busy || closed || value.trim() === ''}
          aria-label="Send"
        >
          <IconSend size={16} />
        </button>
      </form>
    </div>
  )
}


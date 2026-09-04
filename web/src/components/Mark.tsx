/** The Convo mark: a speech shape with a ledger rule through it. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M16 7c-5 0-9 3.4-9 7.6 0 2.5 1.4 4.7 3.6 6.1L10 26l4.6-2.5c.5.1.9.1 1.4.1 5 0 9-3.4 9-7.6S21 7 16 7Z"
        fill="#fff"
      />
      <path d="M12.2 14.4h7.6M12.2 17.4h5" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark />
      <span>Convo</span>
    </span>
  )
}

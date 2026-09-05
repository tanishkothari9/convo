import { useEffect, useRef, useState } from "react";

/**
 * The composer.
 *
 * The suggestion chips used to sit on top of this, on the theory that what to
 * do next belongs next to the place you act. In practice they crowded the field
 * they were sitting on and, on a short viewport, ran into it. They are in the
 * transcript now, under the reply that offered them, which is also where they
 * came from.
 */
import { IconSend } from "../components/icons";

export function Composer({
  busy,
  closed,
  onSend,
}: {
  busy: boolean;
  /** The brand has no catalogue, so there is nothing to answer with. */
  closed?: boolean;
  onSend(text: string): void;
}) {
  const [value, setValue] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to a point, then scroll inside itself.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (text === "" || busy || closed) return;
    setValue("");
    onSend(text);
    field.current?.focus();
  }

  return (
    <div className="composer-layer">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={field}
          className="composer-field"
          rows={1}
          value={value}
          disabled={closed}
          placeholder={
            closed ? "Nothing is listed here yet" : "Ask for something"
          }
          aria-label={closed ? "Messaging is closed" : "Ask for something"}
          maxLength={2000}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="composer-send"
          type="submit"
          disabled={busy || closed || value.trim() === ""}
          aria-label="Send"
        >
          <IconSend size={16} />
        </button>
      </form>
    </div>
  );
}

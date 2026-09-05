/**
 * The Convo wordmark.
 *
 * Set, not drawn. There was a mark — a speech bubble with a ledger rule through
 * it — sitting to the left of the name on every surface of the product, and at
 * twenty pixels it was doing what small logos usually do: reading as a generic
 * chat glyph and saying nothing the word beside it had not already said. The
 * name alone, in Instrument Sans at regular weight, is the mark now. That is the
 * treatment the landing footer was already using, and it is the one that works.
 *
 * Three sizes, because tracking has to move with them. Letters read too far
 * apart as type grows and too close as it shrinks, so a single letter-spacing
 * across a fifteen-pixel nav bar and a twenty-eight-pixel panel is wrong at one
 * end or the other. Each size is a shade tighter than the body text at that
 * size, which is most of what makes a word read as a mark rather than as a word.
 */
export function Wordmark({
  size = "md",
  invert = false,
}: {
  size?: "sm" | "md" | "lg";
  /** For the hero, where the name sits over the pixel sky rather than on bone. */
  invert?: boolean;
}) {
  return (
    <span
      className={`wordmark wordmark-${size}${invert ? " wordmark-invert" : ""}`}
    >
      Convo
    </span>
  );
}

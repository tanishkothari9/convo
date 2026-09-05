/**
 * Shared plumbing for the HTTP backends: an SSE line reader, and a tolerant
 * reader for the partial JSON a tool call's arguments arrive as.
 */

/** Yields each `data:` payload of an SSE response, skipping comments and `[DONE]`. */
export async function* sseEvents(
  response: Response,
): AsyncGenerator<{ event: string | null; data: string }> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event: string | null = null;
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
        }
        const data = dataLines.join("\n");
        if (data && data !== "[DONE]") yield { event, data };
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pulls a completed top-level string field out of a still-streaming JSON
 * object. Used to surface a tool call's `status` line the moment it finishes
 * streaming, well before the rest of the arguments arrive — this is what makes
 * "looking through the catalogue…" appear while the call is still being built.
 * Returns null while the value is incomplete.
 */
export function readStreamingStringField(
  partialJson: string,
  field: string,
): string | null {
  const key = `"${field}"`;
  const keyAt = partialJson.indexOf(key);
  if (keyAt === -1) return null;
  let i = keyAt + key.length;
  while (i < partialJson.length && /\s/.test(partialJson[i]!)) i += 1;
  if (partialJson[i] !== ":") return null;
  i += 1;
  while (i < partialJson.length && /\s/.test(partialJson[i]!)) i += 1;
  if (partialJson[i] !== '"') return null;
  i += 1;
  let out = "";
  while (i < partialJson.length) {
    const char = partialJson[i]!;
    if (char === "\\") {
      const next = partialJson[i + 1];
      if (next === undefined) return null; // escape sequence still arriving
      out += unescapeJsonChar(next);
      i += 2;
      continue;
    }
    if (char === '"') return out;
    out += char;
    i += 1;
  }
  return null; // closing quote has not arrived yet
}

function unescapeJsonChar(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    default:
      return char;
  }
}

/** Parses tool arguments, treating an empty or unparseable string as no arguments. */
export function parseToolInput(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

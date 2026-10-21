/**
 * Minimal Server-Sent-Events reader for provider streaming responses.
 *
 * Yields the `data:` payload of each complete SSE event. Both the OpenAI
 * and Anthropic streaming APIs (and Gemini's `?alt=sse` mode) speak this
 * dialect, so one parser serves every provider.
 */

function parseEvent(rawEvent: string): string | undefined {
  const dataLines = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
  if (dataLines.length === 0) return undefined
  return dataLines.join('\n')
}

/** Iterate SSE `data:` payloads from a response body stream. */
export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        const rawEvent = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const data = parseEvent(rawEvent)
        if (data !== undefined) yield data
        separator = buffer.indexOf('\n\n')
      }
    }
    // Flush a final event that was not blank-line terminated.
    const data = parseEvent(buffer)
    if (data !== undefined) yield data
  } finally {
    reader.releaseLock()
  }
}

/**
 * Server-Sent Events over POST.
 *
 * The browser's built-in EventSource can only issue GET requests with no body,
 * which is useless to us: we need to POST text, and for video we need to POST a
 * multipart file. So we make a normal fetch, read the response body as a stream,
 * and parse the SSE wire format ourselves.
 *
 * Wire format (see backend/src/utils/sse.js):
 *
 *     event: result\n
 *     data: {"index":0,"result":{...}}\n
 *     \n
 *
 * Events are separated by a blank line. Lines starting with ':' are comments
 * (our keep-alive heartbeat) and are ignored.
 */

/**
 * Stream an SSE endpoint, invoking `onEvent(name, data)` per event.
 *
 * @param {string} url
 * @param {object} options
 * @param {BodyInit} options.body
 * @param {Record<string,string>} [options.headers]
 * @param {(name: string, data: any) => void} options.onEvent
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>} resolves when the stream ends
 */
export async function streamSSE(url, { body, headers = {}, onEvent, signal }) {
  const response = await fetch(url, { method: 'POST', headers, body, signal });

  // A validation failure (400) is answered as plain JSON before the stream
  // opens, so handle that case as a normal error rather than trying to parse it
  // as events.
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok && contentType.includes('application/json')) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error('Streaming is not supported by this browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` keeps multi-byte characters intact across chunk boundaries.
      buffer += decoder.decode(value, { stream: true });

      // Split on the blank line that terminates each event. Anything after the
      // final separator is a partial event; keep it in the buffer for next time.
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const event = parseEventBlock(part);
        if (event) onEvent(event.name, event.data);
      }
    }
  } finally {
    // Releasing the lock lets an aborted request tear down cleanly.
    reader.releaseLock?.();
  }
}

/** Turn one raw "event: x\ndata: {...}" block into { name, data }. */
function parseEventBlock(block) {
  let name = 'message';
  const dataLines = [];

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank or keep-alive comment
    if (line.startsWith('event:')) {
      name = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return { name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    // A malformed frame should be dropped, not thrown — the rest of the stream
    // is still perfectly usable.
    return null;
  }
}

/**
 * Server-Sent Events helper.
 *
 * Why SSE rather than WebSockets? The data only ever flows one way -- server to
 * browser -- and SSE is plain HTTP: no handshake, no extra server, no protocol
 * upgrade to break behind a proxy. For "push results as they finish" it is the
 * simpler and more robust choice.
 *
 * One wrinkle: we stream over POST (the client sends text or a video file), so
 * the browser cannot use the built-in EventSource API, which is GET-only. The
 * frontend therefore reads the response body with fetch + ReadableStream and
 * parses the same wire format. See frontend/src/lib/sseClient.js.
 */

/** Put the response into streaming mode and flush the headers immediately. */
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tell nginx and friends not to buffer, or events arrive in one late burst.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

/**
 * Emit one named event with a JSON payload.
 * Returns false once the socket is gone, so callers can stop working early.
 */
function sendEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

/** Signal completion and close the connection. */
function closeStream(res, event = 'done', data = {}) {
  sendEvent(res, event, data);
  res.end();
}

/**
 * Send a keep-alive comment every 15s. Idle proxies (and some corporate
 * networks) drop connections with no traffic, and video transcription can be
 * quiet for a while. Returns a stop function.
 */
function startHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(': keep-alive\n\n');
  }, intervalMs);

  // Do not hold the event loop open just for a heartbeat.
  timer.unref?.();

  return () => clearInterval(timer);
}

module.exports = { openStream, sendEvent, closeStream, startHeartbeat };

/**
 * API client. Every network call the app makes lives here, so swapping the
 * backend host or adding auth is a one-file change.
 */

import { streamSSE } from './sseClient';

// Configurable at build time (VITE_API_URL) with a localhost default so a fresh
// clone runs with zero configuration.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/** Shared JSON fetch with consistent error extraction. */
async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, options);
  } catch {
    // fetch only rejects on network-level failure, which almost always means
    // "the backend isn't running" during development. Say so plainly.
    throw new Error(`Cannot reach the Veristate API at ${API_URL}. Is the backend running?`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

/** Health check — also tells us which integrations are configured. */
export function getHealth() {
  return requestJson('/');
}

/** Past analyses (empty + available:false when Postgres isn't connected). */
export function getHistory({ limit = 20 } = {}) {
  return requestJson(`/api/history?limit=${limit}`);
}

/** Aggregate verdict counts for the history stats tiles. */
export function getStats() {
  return requestJson('/api/stats');
}

/**
 * Analyse text or a URL, streaming claims and verdicts as they arrive.
 * @param {string} text
 * @param {{ onEvent: Function, signal?: AbortSignal }} handlers
 */
export function analyzeTextStream(text, { onEvent, signal }) {
  return streamSSE(`${API_URL}/api/analyze/stream`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, surface: 'web' }),
    onEvent,
    signal,
  });
}

/**
 * Analyse a screenshot. Not streamed — vision + a handful of claims resolve
 * fast enough that a single response keeps the code simpler.
 */
export async function analyzeImage(file, { signal } = {}) {
  const form = new FormData();
  form.append('image', file);

  let response;
  try {
    response = await fetch(`${API_URL}/api/analyze-image`, { method: 'POST', body: form, signal });
  } catch {
    throw new Error(`Cannot reach the Veristate API at ${API_URL}. Is the backend running?`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Image analysis failed.');
  return payload;
}

/**
 * Analyse a video, streaming timestamped verdicts as each chunk of audio is
 * transcribed and checked.
 *
 * `onUploadProgress` is driven by XMLHttpRequest rather than fetch, because
 * fetch still cannot report upload progress — and for a 200 MB file, a progress
 * bar is the difference between "working" and "frozen". We therefore upload
 * with XHR and read the streamed response from its incremental responseText.
 */
export function analyzeVideoStream(file, { onEvent, onUploadProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/analyze-video`);

    // How much of the SSE body we have already parsed.
    let consumed = 0;

    const drain = () => {
      const text = xhr.responseText;
      const fresh = text.slice(consumed);
      const parts = fresh.split('\n\n');
      // The last element is a possibly-incomplete event; leave it unconsumed.
      const complete = parts.slice(0, -1);
      consumed += fresh.length - (parts[parts.length - 1]?.length ?? 0);

      for (const block of complete) {
        let name = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        try {
          onEvent?.(name, JSON.parse(dataLines.join('\n')));
        } catch {
          /* drop a malformed frame and keep streaming */
        }
      }
    };

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onUploadProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    });

    // Fires repeatedly as the response streams in — this is what makes live
    // verdicts possible over XHR.
    xhr.addEventListener('progress', drain);

    xhr.addEventListener('load', () => {
      drain();
      if (xhr.status >= 400) {
        // An early rejection (wrong file type, too large) arrives as JSON.
        try {
          reject(new Error(JSON.parse(xhr.responseText).error || 'Video analysis failed.'));
        } catch {
          reject(new Error(`Video analysis failed (${xhr.status}).`));
        }
        return;
      }
      resolve();
    });

    xhr.addEventListener('error', () => reject(new Error(`Cannot reach the Veristate API at ${API_URL}.`)));
    xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));

    signal?.addEventListener('abort', () => xhr.abort());

    xhr.send(form);
  });
}

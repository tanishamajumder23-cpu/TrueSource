import { useCallback, useRef, useState } from 'react';
import { analyzeImage, analyzeTextStream, analyzeVideoStream } from '../lib/api';

/**
 * The analysis state machine.
 *
 * All four input modes (text, URL, image, video) reduce to the same shape:
 *
 *   status  : 'idle' | 'running' | 'done' | 'error'
 *   claims  : the claims we are checking (arrive before their verdicts, which is
 *             what lets us render one skeleton card per pending claim)
 *   results : verdicts, appended as each one streams in
 *   summary : aggregate counts, sent last
 *
 * Keeping this in a hook rather than inside App keeps the component tree purely
 * presentational, and means the extension or another surface could reuse it.
 */
export function useAnalysis() {
  const [status, setStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [claims, setClaims] = useState([]);
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [extractedText, setExtractedText] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [articleTitle, setArticleTitle] = useState('');

  // Lets the user cancel a long video analysis (and lets us abort on unmount).
  const abortRef = useRef(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setStatusMessage('');
    setClaims([]);
    setResults([]);
    setSummary(null);
    setError(null);
    setExtractedText('');
    setTranscript([]);
    setUploadProgress(0);
    setArticleTitle('');
  }, []);

  /** Prepare for a new run: clear the last one and open a fresh abort scope. */
  const begin = useCallback(() => {
    reset();
    setStatus('running');
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, [reset]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setStatusMessage('');
  }, []);

  /**
   * Shared SSE event handler. `claimsMode` differs between text (the full claim
   * list arrives once, up front) and video (claims arrive per chunk and append).
   */
  const handleEvent = useCallback((name, data) => {
    switch (name) {
      case 'status':
        setStatusMessage(data.message || '');
        if (data.title) setArticleTitle(data.title);
        break;

      case 'claims':
        // `append` is set by the video route, where each audio chunk contributes
        // more claims to a list that is already partly rendered.
        setClaims((current) => (data.append ? [...current, ...data.claims] : data.claims));
        break;

      case 'transcript':
        setTranscript((current) => [...current, data]);
        break;

      case 'result':
        setResults((current) => [...current, data.result]);
        break;

      case 'summary':
        setSummary(data.summary);
        break;

      case 'error':
        setError(data.message || 'Analysis failed.');
        setStatus('error');
        break;

      case 'done':
        setStatus('done');
        setStatusMessage('');
        break;

      default:
        break;
    }
  }, []);

  /** Text or URL. */
  const runText = useCallback(
    async (text) => {
      const controller = begin();
      setStatusMessage('Connecting...');

      try {
        await analyzeTextStream(text, { onEvent: handleEvent, signal: controller.signal });
        // If the stream ended without an explicit done/error event (e.g. the
        // connection dropped mid-flight), settle the UI rather than spinning.
        setStatus((current) => (current === 'running' ? 'done' : current));
      } catch (streamError) {
        if (streamError.name === 'AbortError') return;
        setError(streamError.message);
        setStatus('error');
      } finally {
        setStatusMessage('');
      }
    },
    [begin, handleEvent],
  );

  /** Screenshot. Single response rather than a stream. */
  const runImage = useCallback(
    async (file) => {
      const controller = begin();
      setStatusMessage('Reading the image...');

      try {
        const payload = await analyzeImage(file, { signal: controller.signal });
        setExtractedText(payload.extractedText || '');
        setClaims(payload.claims || []);
        setResults(payload.results || []);
        setSummary(payload.summary || null);
        setStatus('done');
      } catch (imageError) {
        if (imageError.name === 'AbortError') return;
        setError(imageError.message);
        setStatus('error');
      } finally {
        setStatusMessage('');
      }
    },
    [begin],
  );

  /** Video or audio. Uploads with progress, then streams timestamped verdicts. */
  const runVideo = useCallback(
    async (file) => {
      const controller = begin();
      setStatusMessage('Uploading...');

      try {
        await analyzeVideoStream(file, {
          onEvent: handleEvent,
          onUploadProgress: (percent) => {
            setUploadProgress(percent);
            if (percent === 100) setStatusMessage('Upload complete - extracting audio...');
          },
          signal: controller.signal,
        });
        setStatus((current) => (current === 'running' ? 'done' : current));
      } catch (videoError) {
        if (videoError.name === 'AbortError') return;
        setError(videoError.message);
        setStatus('error');
      } finally {
        setStatusMessage('');
      }
    },
    [begin, handleEvent],
  );

  return {
    // state
    status,
    statusMessage,
    claims,
    results,
    summary,
    error,
    extractedText,
    transcript,
    uploadProgress,
    articleTitle,
    isRunning: status === 'running',
    // actions
    runText,
    runImage,
    runVideo,
    reset,
    cancel,
  };
}

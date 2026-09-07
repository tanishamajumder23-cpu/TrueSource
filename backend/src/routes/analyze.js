/**
 * Analysis routes -- the HTTP surface over the pipeline.
 *
 *   POST /api/analyze         text or URL, returns the whole report at once
 *   POST /api/analyze/stream  same input, streams claims + verdicts over SSE
 *   POST /api/analyze-image   screenshot upload -> vision -> pipeline
 *   POST /api/analyze-video   video upload -> chunked Whisper -> pipeline, streamed
 *
 * Routes stay thin on purpose: they validate input, choose an ingestion path,
 * delegate to services, and shape the response. No business logic lives here.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const { analyzeText, checkClaims, summarise } = require('../services/pipeline');
const { extractClaims } = require('../services/claimExtractor');
const { scrapeArticle, isUrl } = require('../services/scraper');
const { extractTextFromImage } = require('../services/vision');
const { transcribeVideo, formatTimestamp } = require('../services/transcription');
const { saveAnalysis } = require('../db/analysisRepository');
const { openStream, sendEvent, closeStream, startHeartbeat } = require('../utils/sse');
const { createLogger } = require('../utils/logger');

const log = createLogger('analyze');
const router = express.Router();

// --------------------------------------------------------------------------
//  Upload handling
// --------------------------------------------------------------------------

// Images are small and go straight to the vision API, so keep them in memory --
// no temp files to clean up.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxImageBytes },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(Object.assign(new Error('Only image files are accepted.'), { code: 'BAD_FILE_TYPE' }));
      return;
    }
    cb(null, true);
  },
});

// Videos can be hundreds of megabytes and ffmpeg needs a real file path, so
// these go to disk and are deleted in a finally block once processing ends.
fs.mkdirSync(config.uploads.dir, { recursive: true });
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploads.dir),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt || '.mp4'}`);
    },
  }),
  limits: { fileSize: config.uploads.maxVideoBytes },
  fileFilter: (req, file, cb) => {
    // Accept audio too: a podcast clip runs through the identical pipeline.
    //
    // Trust the extension as well as the MIME type. Plenty of legitimate
    // clients (curl, some mobile browsers, the Telegram file API) send
    // application/octet-stream for a perfectly valid .mp4, and rejecting those
    // would be a confusing failure for the user. ffmpeg is the real arbiter of
    // whether the bytes are decodable, and it reports that clearly downstream.
    const mimeOk = file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/');
    const extensionOk = /\.(mp4|mov|webm|mkv|avi|m4v|mp3|m4a|wav|ogg|flac|aac)$/i.test(file.originalname || '');

    if (!mimeOk && !extensionOk) {
      cb(Object.assign(new Error('Only video or audio files are accepted.'), { code: 'BAD_FILE_TYPE' }));
      return;
    }
    cb(null, true);
  },
});

// --------------------------------------------------------------------------
//  Shared helpers
// --------------------------------------------------------------------------

/**
 * Resolve raw user input into the text we will actually analyse.
 * A bare URL is scraped; anything else is used as-is.
 */
async function resolveInput(text) {
  if (isUrl(text)) {
    const article = await scrapeArticle(text.trim());
    return { inputType: 'url', content: article.markdown, articleTitle: article.title };
  }
  return { inputType: 'text', content: text };
}

/** Map an internal error to a sensible HTTP status. */
function statusForError(error) {
  switch (error.code) {
    case 'SCRAPER_DISABLED':
    case 'AI_UNAVAILABLE':
    case 'VISION_UNAVAILABLE':
    case 'FFMPEG_MISSING':
      return 503;
    case 'SCRAPE_FAILED':
    case 'SCRAPE_EMPTY':
    case 'BAD_FILE_TYPE':
    case 'NO_AUDIO_TRACK':
    case 'AUDIO_EXTRACTION_FAILED':
      return 422;
    default:
      return 500;
  }
}

// --------------------------------------------------------------------------
//  POST /api/analyze  -- one-shot text / URL analysis
//  Used by the Telegram bot, the browser extension, and any API consumer that
//  would rather have a single JSON response than a stream.
// --------------------------------------------------------------------------
router.post('/analyze', async (req, res) => {
  const { text, surface = 'api' } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(400).json({ error: 'Please provide some text or a URL to check.' });
  }

  try {
    const { inputType, content, articleTitle } = await resolveInput(text);
    const { claims, results } = await analyzeText(content);

    // Persistence is best-effort and deliberately not awaited for correctness --
    // but we do await it here so the response can carry the analysis id.
    const analysisId = await saveAnalysis({
      inputType,
      submittedContent: text,
      resolvedContent: inputType === 'url' ? content : null,
      sourceSurface: surface,
      results,
    });

    return res.json({
      analysisId,
      inputType,
      articleTitle,
      claims,
      results,
      summary: summarise(results),
    });
  } catch (error) {
    log.error('Analysis failed', error.message);
    return res.status(statusForError(error)).json({ error: error.message || 'Analysis failed.' });
  }
});

// --------------------------------------------------------------------------
//  POST /api/analyze/stream -- same input, streamed
//
//  Event sequence:
//    status  -> human-readable stage updates ("Scraping article...")
//    claims  -> the full list of extracted claims (lets the UI render skeletons)
//    result  -> one per claim, emitted the moment its verdict is ready
//    summary -> aggregate counts once everything is done
//    done / error
// --------------------------------------------------------------------------
router.post('/analyze/stream', async (req, res) => {
  const { text, surface = 'web' } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(400).json({ error: 'Please provide some text or a URL to check.' });
  }

  openStream(res);
  const stopHeartbeat = startHeartbeat(res);

  // If the user navigates away, stop doing expensive work on their behalf.
  //
  // Listen on the RESPONSE, not the request: since Node 16 a request stream also
  // emits 'close' once its body has simply finished being read, so req.on('close')
  // fires immediately on every normal POST and would suppress all our events.
  // res 'close' fires only when the socket actually goes away, and we still guard
  // on writableEnded so a clean end() is not mistaken for a disconnect.
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    let inputType = 'text';
    let content = text;

    if (isUrl(text)) {
      sendEvent(res, 'status', { stage: 'scraping', message: 'Fetching and cleaning the article...' });
      const article = await scrapeArticle(text.trim());
      inputType = 'url';
      content = article.markdown;
      sendEvent(res, 'status', { stage: 'scraped', message: `Read "${article.title}"`, title: article.title });
    }

    sendEvent(res, 'status', { stage: 'extracting', message: 'Identifying factual claims...' });

    const { claims, results } = await analyzeText(content, {
      onClaims: (list) => {
        sendEvent(res, 'claims', { claims: list });
        if (list.length > 0) {
          sendEvent(res, 'status', {
            stage: 'checking',
            message: `Retrieving live evidence for ${list.length} claim${list.length === 1 ? '' : 's'}...`,
          });
        }
      },
      onResult: (result, index) => {
        if (!clientGone) sendEvent(res, 'result', { index, result });
      },
    });

    sendEvent(res, 'summary', { summary: summarise(results) });

    const analysisId = await saveAnalysis({
      inputType,
      submittedContent: text,
      resolvedContent: inputType === 'url' ? content : null,
      sourceSurface: surface,
      results,
    });

    closeStream(res, 'done', { analysisId, claimCount: claims.length });
  } catch (error) {
    log.error('Streaming analysis failed', error.message);
    // The headers are already sent, so the error has to travel as an event.
    closeStream(res, 'error', { message: error.message || 'Analysis failed.', code: error.code });
  } finally {
    stopHeartbeat();
  }
});

// --------------------------------------------------------------------------
//  POST /api/analyze-image -- screenshot -> vision -> pipeline
// --------------------------------------------------------------------------
router.post('/analyze-image', imageUpload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image was uploaded.' });
  }

  try {
    const base64 = req.file.buffer.toString('base64');
    const extracted = await extractTextFromImage(base64, req.file.mimetype);

    if (!extracted) {
      return res.status(422).json({
        error: 'No readable text or factual content was found in that image.',
        code: 'NO_TEXT_IN_IMAGE',
      });
    }

    const { claims, results } = await analyzeText(extracted);

    const analysisId = await saveAnalysis({
      inputType: 'image',
      submittedContent: req.file.originalname || 'uploaded image',
      resolvedContent: extracted,
      sourceSurface: req.body?.surface || 'web',
      results,
    });

    return res.json({
      analysisId,
      inputType: 'image',
      // Showing the user what we read out of their screenshot is a trust feature:
      // if the OCR misread something, they can see exactly why.
      extractedText: extracted,
      claims,
      results,
      summary: summarise(results),
    });
  } catch (error) {
    log.error('Image analysis failed', error.message);
    return res.status(statusForError(error)).json({ error: error.message || 'Image analysis failed.' });
  }
});

// --------------------------------------------------------------------------
//  POST /api/analyze-video -- video/audio -> chunked Whisper -> pipeline (SSE)
//
//  Each audio chunk is transcribed, its claims extracted and checked, and the
//  verdicts streamed out before the next chunk is even transcribed. The user
//  sees timestamped verdicts appearing while the rest of the file is still
//  being processed.
// --------------------------------------------------------------------------
router.post('/analyze-video', videoUpload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video was uploaded.' });
  }

  const videoPath = req.file.path;
  openStream(res);
  const stopHeartbeat = startHeartbeat(res);

  // See the note in /analyze/stream: the disconnect signal must come from res.
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  const allResults = [];
  const allClaims = [];
  const transcriptParts = [];
  // How many verdicts we have streamed so far, across every chunk.
  let emittedCount = 0;

  try {
    sendEvent(res, 'status', {
      stage: 'transcribing',
      message: 'Extracting audio and starting transcription...',
    });

    let chunkIndex = 0;

    // `for await` over the transcription generator: we act on chunk N while the
    // pipeline is still working through the file, rather than waiting for all of it.
    for await (const chunk of transcribeVideo(videoPath)) {
      if (clientGone) break;
      chunkIndex += 1;

      transcriptParts.push(chunk.text);

      sendEvent(res, 'transcript', {
        index: chunk.index,
        timestamp: chunk.timestamp,
        startSeconds: chunk.startSeconds,
        text: chunk.text,
      });

      // Extract claims from just this chunk of speech.
      let chunkClaims = [];
      try {
        chunkClaims = await extractClaims(chunk.text);
      } catch (error) {
        log.warn(`Claim extraction failed for chunk ${chunk.index}; continuing`, error.message);
        continue;
      }

      if (chunkClaims.length === 0) {
        sendEvent(res, 'status', {
          stage: 'checking',
          message: `No verifiable claims at ${chunk.timestamp} - continuing...`,
        });
        continue;
      }

      allClaims.push(...chunkClaims);
      sendEvent(res, 'claims', { claims: chunkClaims, timestamp: chunk.timestamp, append: true });

      // Attach the moment in the video each claim was spoken. We use the
      // best-matching Whisper segment so the timestamp points at the sentence,
      // not just the start of the two-minute chunk.
      const results = await checkClaims(chunkClaims, {
        meta: (i) => {
          const segment = chunk.segments[Math.min(i, Math.max(0, chunk.segments.length - 1))];
          const startSeconds = segment ? segment.start : chunk.startSeconds;
          return { startSeconds, timestamp: formatTimestamp(startSeconds) };
        },
        // `allResults` is only appended to after this whole chunk resolves, so
        // it cannot supply the running index — emittedCount tracks it instead,
        // giving each streamed verdict its true position across the video.
        onResult: (result) => {
          const index = emittedCount;
          emittedCount += 1;
          if (!clientGone) sendEvent(res, 'result', { index, result });
        },
      });

      allResults.push(...results);
    }

    if (chunkIndex === 0) {
      closeStream(res, 'error', {
        message: 'No speech could be transcribed from that file.',
        code: 'NO_SPEECH',
      });
      return;
    }

    sendEvent(res, 'summary', { summary: summarise(allResults) });

    const analysisId = await saveAnalysis({
      inputType: 'video',
      submittedContent: req.file.originalname || 'uploaded video',
      resolvedContent: transcriptParts.join('\n\n'),
      sourceSurface: 'web',
      results: allResults,
    });

    closeStream(res, 'done', { analysisId, claimCount: allClaims.length });
  } catch (error) {
    log.error('Video analysis failed', error.message);
    closeStream(res, 'error', { message: error.message || 'Video analysis failed.', code: error.code });
  } finally {
    stopHeartbeat();
    // Always remove the upload, success or failure -- these files are large.
    fs.promises.unlink(videoPath).catch(() => {});
  }
});

module.exports = router;

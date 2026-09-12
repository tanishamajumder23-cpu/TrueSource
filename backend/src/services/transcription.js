/**
 * Video / audio ingestion: media -> timestamped transcript, IN CHUNKS.
 *
 * ── Why chunked, and why an async generator? ─────────────────────────────
 * A ten-minute video takes a long time to transcribe and fact-check. If we did
 * it in one pass the user would stare at a spinner for minutes and then get
 * everything at once -- terrible UX, and it hides all the work the system is
 * doing.
 *
 * Instead ffmpeg slices the audio into fixed-length segments, and this module
 * exposes them as an ASYNC GENERATOR. The route consumes it with `for await`,
 * fact-checks each chunk's claims as soon as that chunk is transcribed, and
 * streams the verdicts to the browser over Server-Sent Events. The user watches
 * results appear live.
 *
 * ── The live-stream extension point ──────────────────────────────────────
 * The generator shape is deliberate. `transcribeVideo` is just a thin wrapper
 * over `transcribeChunkStream`, which consumes *any* async iterable of audio
 * chunks. To support real-time fact-checking of a live broadcast, you replace
 * the file-slicing source with one that yields chunks off a live feed (e.g.
 * ffmpeg reading an RTMP/HLS input with the same segment muxer). Every stage
 * downstream -- transcription, claim extraction, retrieval, verdicts, SSE --
 * works unchanged, because none of it ever assumed the input was finite.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const config = require('../config/env');
const { groq, withRetry } = require('../lib/groqClient');
const { createLogger } = require('../utils/logger');

const log = createLogger('transcribe');

/** Format seconds as m:ss for display next to a verdict. */
function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Run ffmpeg once, extracting the audio track and splitting it into
 * fixed-length mp3 segments on disk.
 *
 * We drive the static ffmpeg binary directly rather than through a wrapper
 * because we need no probing, no filters and no ffprobe dependency -- just one
 * deterministic command whose output we can predict from the segment index.
 *
 * @returns {Promise<string[]>} absolute paths of the produced segments, in order
 */
function splitAudioIntoSegments(videoPath, outputDir, chunkSeconds) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      const error = new Error('ffmpeg binary is unavailable; video analysis is disabled.');
      error.code = 'FFMPEG_MISSING';
      reject(error);
      return;
    }

    const args = [
      '-i', videoPath,
      '-vn',                    // drop the video stream: we only need audio
      '-ac', '1',               // mono - Whisper does not benefit from stereo
      '-ar', '16000',           // 16 kHz is Whisper's native sample rate
      '-b:a', '64k',
      '-f', 'segment',
      '-segment_time', String(chunkSeconds),
      '-reset_timestamps', '1',
      path.join(outputDir, 'chunk_%04d.mp3'),
      '-y',
    ];

    log.info(`Extracting audio in ${chunkSeconds}s segments`);

    const proc = spawn(ffmpegPath, args, { windowsHide: true });

    // ffmpeg writes all of its progress output to stderr; capture the tail so a
    // failure produces a diagnosable message instead of a bare exit code.
    let stderrTail = '';
    proc.stderr.on('data', (data) => {
      stderrTail = (stderrTail + data.toString()).slice(-2000);
    });

    proc.on('error', (error) => {
      reject(Object.assign(new Error(`ffmpeg failed to start: ${error.message}`), { code: 'FFMPEG_MISSING' }));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        log.error(`ffmpeg exited with code ${code}`, stderrTail.slice(-500));
        reject(
          Object.assign(new Error('Could not extract audio from that file. It may be corrupt or in an unsupported format.'), {
            code: 'AUDIO_EXTRACTION_FAILED',
          }),
        );
        return;
      }

      const segments = fs
        .readdirSync(outputDir)
        .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp3'))
        .sort() // zero-padded names sort chronologically
        .map((f) => path.join(outputDir, f));

      if (segments.length === 0) {
        reject(
          Object.assign(new Error('That file contains no audio track to transcribe.'), { code: 'NO_AUDIO_TRACK' }),
        );
        return;
      }

      log.info(`Produced ${segments.length} audio segment(s)`);
      resolve(segments);
    });
  });
}

/**
 * Transcribe a single audio file with Whisper (hosted on Groq).
 *
 * We ask for verbose_json so we get per-utterance timestamps, which is what lets
 * the UI show "this claim was made at 4:12".
 *
 * @returns {Promise<{ text: string, segments: Array<{start:number,end:number,text:string}> }>}
 */
async function transcribeAudioFile(filePath) {
  const response = await withRetry(
    () =>
      groq.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: config.groq.whisperModel,
        response_format: 'verbose_json',
        temperature: 0,
      }),
    { label: 'whisper' },
  );

  return {
    text: (response.text || '').trim(),
    segments: Array.isArray(response.segments)
      ? response.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))
      : [],
  };
}

/**
 * Core streaming transcriber. Consumes an async iterable of audio chunks and
 * yields a transcript per chunk as soon as it is ready.
 *
 * This is the seam a live-feed implementation plugs into: supply a `chunkSource`
 * that yields `{ path, startSeconds }` off a live stream and nothing else
 * changes.
 *
 * @param {AsyncIterable<{path: string, startSeconds: number, index: number}>} chunkSource
 * @yields {{ index:number, startSeconds:number, endSeconds:number, text:string,
 *            segments:Array, timestamp:string }}
 */
async function* transcribeChunkStream(chunkSource) {
  for await (const chunk of chunkSource) {
    let result;
    try {
      result = await transcribeAudioFile(chunk.path);
    } catch (error) {
      // One unreadable segment must not abort the whole video. Skip it, tell the
      // logs why, and keep going with the rest of the timeline.
      log.error(`Transcription failed for chunk ${chunk.index}; skipping`, error.message);
      continue;
    }

    if (!result.text) {
      log.info(`Chunk ${chunk.index} contained no speech; skipping`);
      continue;
    }

    // Shift the chunk-local segment offsets onto the absolute video timeline.
    const absoluteSegments = result.segments.map((s) => ({
      start: chunk.startSeconds + s.start,
      end: chunk.startSeconds + s.end,
      text: s.text,
    }));

    const endSeconds =
      absoluteSegments.length > 0
        ? absoluteSegments[absoluteSegments.length - 1].end
        : chunk.startSeconds + config.video.chunkSeconds;

    yield {
      index: chunk.index,
      startSeconds: chunk.startSeconds,
      endSeconds,
      timestamp: formatTimestamp(chunk.startSeconds),
      text: result.text,
      segments: absoluteSegments,
    };
  }
}

/**
 * File-backed chunk source: split the video, then yield its segments in order.
 * Cleans up its temporary directory when iteration finishes or is abandoned.
 */
async function* fileChunkSource(videoPath, chunkSeconds) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthlens-audio-'));

  try {
    const segments = await splitAudioIntoSegments(videoPath, workDir, chunkSeconds);

    for (let index = 0; index < segments.length; index += 1) {
      yield {
        index,
        path: segments[index],
        startSeconds: index * chunkSeconds,
      };
    }
  } finally {
    // `finally` in a generator also runs if the consumer breaks out early
    // (e.g. the browser closed the SSE connection), so temp files never leak.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (error) {
      log.warn('Could not clean up temp audio directory', error.message);
    }
  }
}

/**
 * Public entry point: transcribe a video file, streaming chunk transcripts.
 *
 * @param {string} videoPath
 * @param {{chunkSeconds?: number}} [options]
 */
function transcribeVideo(videoPath, options = {}) {
  const chunkSeconds = options.chunkSeconds || config.video.chunkSeconds;
  return transcribeChunkStream(fileChunkSource(videoPath, chunkSeconds));
}

module.exports = {
  transcribeVideo,
  transcribeChunkStream,
  transcribeAudioFile,
  splitAudioIntoSegments,
  formatTimestamp,
};

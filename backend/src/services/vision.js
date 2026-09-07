/**
 * Image ingestion: screenshot -> text.
 *
 * Most misinformation people actually encounter is a SCREENSHOT -- an X post, an
 * Instagram infographic, a WhatsApp forward, a LinkedIn hot take. Asking a user
 * to retype that into a textarea is exactly the friction that stops them
 * checking anything.
 *
 * So we send the image to a Groq vision model and ask it to TRANSCRIBE the
 * factual assertions it can see. Note the framing carefully: this stage is still
 * pure extraction, not judgement. The vision model is never asked whether the
 * post is true -- that question is answered later, and only against retrieved
 * evidence. Keeping extraction and judgement separate is what preserves the RAG
 * guarantee end to end.
 */

const config = require('../config/env');
const { groq, withRetry } = require('../lib/groqClient');
const { createLogger } = require('../utils/logger');

const log = createLogger('vision');

const EXTRACTION_PROMPT = `You are reading a screenshot for a fact-checking system.

Transcribe the factual assertions visible in this image as plain prose.

Rules:
- Include the main body text of any post, headline, caption, chart label or statistic shown.
- Attribute correctly if the image shows who said something (e.g. "@user posted: ...").
- If the image contains a chart or infographic, state the figures and what they claim to show.
- Do NOT judge whether anything is true. Do NOT add commentary, context or corrections.
- Do NOT describe the visual design, layout, colours, avatars or UI chrome.
- If there is no readable text or factual content, reply with exactly: NO_TEXT_FOUND

Output only the transcribed content.`;

/**
 * Read the factual text content out of an image.
 *
 * @param {string} imageBase64 - raw base64 (no data: prefix)
 * @param {string} mimeType    - e.g. 'image/png'
 * @returns {Promise<string>}  transcribed text ('' when nothing readable)
 * @throws {Error} code VISION_UNAVAILABLE when the model call itself fails
 */
async function extractTextFromImage(imageBase64, mimeType = 'image/png') {
  if (!imageBase64) return '';

  // The Groq vision API accepts images as data URLs in the message content.
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  let content;
  try {
    const response = await withRetry(
      () =>
        groq.chat.completions.create({
          model: config.groq.visionModel,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: EXTRACTION_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      { label: 'extractTextFromImage' },
    );
    content = response.choices?.[0]?.message?.content ?? '';
  } catch (error) {
    log.error('Vision model call failed', error.message);
    const wrapped = new Error('Could not read the image. The vision service is temporarily unavailable.');
    wrapped.code = 'VISION_UNAVAILABLE';
    throw wrapped;
  }

  // Some models on Groq are reasoning models that prefix their answer with a
  // <think>...</think> block. That is internal monologue, not transcribed
  // content, so strip it before anything downstream treats it as a claim.
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  if (!text || text === 'NO_TEXT_FOUND' || text.includes('NO_TEXT_FOUND')) {
    log.warn('No readable text found in image');
    return '';
  }

  log.info(`Extracted ${text.length} characters from image`);
  return text;
}

module.exports = { extractTextFromImage };

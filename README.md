# TruthLens

**AI fact-checking grounded in live web evidence.**

Submit text, a news link, a screenshot or a video. TruthLens breaks it into individual factual claims, retrieves real evidence from the internet for each one, and returns a verdict — **TRUE / FALSE / MISLEADING / UNVERIFIABLE** — with a confidence score, plain-English reasoning, and clickable sources you can check yourself.

```
┌──────────┐   ┌───────────┐   ┌──────────────┐   ┌─────────────┐
│  Text    │   │           │   │              │   │             │
│  URL     ├──►│  Extract  ├──►│   Retrieve   ├──►│    Reason   ├──► Verdict
│  Image   │   │  claims   │   │   evidence   │   │  over that  │    + sources
│  Video   │   │           │   │  (live web)  │   │  evidence   │
└──────────┘   └───────────┘   └──────────────┘   └─────────────┘
```

---

## Table of contents

- [The core design decision: RAG](#the-core-design-decision-rag)
- [Why the evidence chain has three tiers](#why-the-evidence-chain-has-three-tiers)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Setup: web app](#setup-web-app)
- [Setup: database](#setup-database-optional)
- [Setup: Telegram bot](#setup-telegram-bot)
- [Setup: browser extension](#setup-browser-extension)
- [API reference](#api-reference)
- [How each input type is handled](#how-each-input-type-is-handled)
- [Error handling philosophy](#error-handling-philosophy)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)

---

## The core design decision: RAG

**TruthLens never asks the AI "is this true?"**

That single rule is the reason this product can be trusted, and everything in the codebase follows from it.

### The problem with asking a model directly

The obvious way to build a fact-checker is to hand a claim to a large language model and ask for a ruling. That approach is broken in two independent ways:

1. **Hallucination.** A model asked to recall facts will confidently invent statistics, studies, quotes and URLs that do not exist. It has no mechanism to distinguish remembering from generating, and no way to tell you which it just did.

2. **Stale knowledge.** A model's weights were frozen at some point in the past. Ask who runs a company, what a record is, or whether a law passed, and you get the world as it was during training — asserted in the present tense, with no warning that it might be out of date.

Both failure modes produce the *same output shape* as a correct answer: fluent, confident, plausible. A user cannot tell them apart. For a fact-checking product, that is disqualifying.

### What TruthLens does instead

**Retrieval-Augmented Generation.** Fetch real, current documents from the live web *first*, then let the model reason **only** over those documents.

```js
// backend/src/services/pipeline.js
const evidence = await getEvidence(claim);      // [2] RETRIEVE from the live web
const verdict  = await getVerdict(claim, evidence); // [3] REASON, strictly over that
```

This changes what the model is being asked to do. It is no longer a knowledge base being interrogated from memory — it is a **reading-comprehension engine** applied to documents we just fetched. That is a task language models are genuinely reliable at.

The consequences are concrete:

- **Every verdict is traceable.** The sources shown in the UI are the exact documents the model read. You can click each one and check the reasoning yourself.
- **Currency comes from the retrieval layer, not the weights.** The model's training cutoff stops mattering, because it is reading today's search results.
- **"I don't know" becomes reachable.** With no evidence, there is nothing to reason over, so the honest answer is available — and taken.

### The three enforcement points

Stating the rule in a prompt is not enough. It is enforced three times:

**1. No evidence means no model call.** If retrieval returns nothing, we never invoke the model — calling it would invite exactly the memory-based guessing we are trying to prevent.

```js
// backend/src/services/verdict.js
if (!Array.isArray(evidence) || evidence.length === 0) {
  return fallbackVerdict('No supporting evidence could be retrieved...');
}
```

**2. The prompt forbids memory, explicitly and repeatedly.**

> ABSOLUTE RULE: You must judge the claim using ONLY the evidence provided in the user message. You are FORBIDDEN from using your own background knowledge, memory, or training data... Your training data is out of date and may be wrong; the provided evidence is current and is your only permitted source of truth.

**3. Fabricated citations are discarded in code.** Any URL the model returns that was not in the retrieved evidence is dropped before it can reach the user. A fact-checker that cites an invented source is worse than useless.

```js
// backend/src/services/verdict.js
const knownUrls = new Set(evidence.map((e) => e.url));
let sources = modelSources.filter((u) => knownUrls.has(u));
```

### Handling temporal drift

Retrieval fixes the model's stale knowledge, but search results have their own staleness problem: an article from three years ago describes the world of three years ago, and says so only implicitly.

So the prompt injects **today's date** and instructs the model to treat undated or clearly-historical evidence as insufficient for a present-tense claim:

> Claims about "current" roles, prices, records, leaders or statuses require evidence that is clearly recent. If you cannot establish recency, choose UNVERIFIABLE. Prefer being honestly uncertain over being confidently wrong.

This deliberately biases the system toward UNVERIFIABLE. That is the right trade: a fact-checker that says "I can't establish this" is useful, while one that is confidently wrong actively spreads misinformation under a badge of authority.

### Claims are decomposed before anything else

Real content bundles several assertions together:

> "The vaccine was approved in 2019 and the CEO resigned last week."

Checking that as one unit produces mush — one true half and one false half average into a useless MISLEADING. So the first stage splits input into **atomic, independently checkable claims**, and each gets its own retrieval and its own verdict. Note that this stage never judges truth; it is pure decomposition. Truth enters the system only at stage 3, only from retrieved evidence.

---

## Why the evidence chain has three tiers

Retrieval is the foundation of the whole design — which means a retrieval outage is a total outage. A demo that dies because one API quota ran out is a demo that fails on stage.

So evidence retrieval is a **chain of independent providers**, tried in order until one returns something:

| Tier | Provider | Key needed | Why it is at this position |
|------|----------|-----------|---------------------------|
| 1 | **Tavily** | Yes | Purpose-built for RAG. Returns clean, ranked, pre-extracted snippets rather than raw HTML — exactly what you want to feed a model. Best quality, so it goes first. |
| 2 | **DuckDuckGo** (`duck-duck-scrape`) | **No** | Keyless general web search. Covers a Tavily outage or exhausted quota. It is an unofficial scraper, so DuckDuckGo's bot detection trips it on some networks — which is precisely why there is a third tier. |
| 3 | **Wikipedia API** | **No** | Official, documented, effectively never down. Narrower coverage than a web search, but for the encyclopedic claims that dominate fact-checking it returns genuine, citable evidence. |

If **all three** fail, `getEvidence` returns an empty array rather than throwing. Downstream, that correctly becomes UNVERIFIABLE with reasoning that says exactly what happened. Degrading honestly beats crashing.

The UI shows which provider answered (`via Tavily`, `via DuckDuckGo (fallback)`), so the user can weigh the evidence accordingly. That transparency is a feature, not a debug leftover.

> **Note on tier 2:** during development, DuckDuckGo's anomaly detection blocked `duck-duck-scrape` from this network entirely. Tier 3 is the reason that was a logged warning instead of an outage. This is what "never goes down from one dependency" has to mean in practice.

---

## Architecture

```
truthlens/
│
├── backend/              Node + Express API  ── the pipeline lives here
├── frontend/             React + Vite web app
├── telegram-bot/         Telegram bot (talks to the API over HTTP)
├── extension/            Chrome extension, Manifest V3
└── scripts/              icon generation, manual API test scripts
```

**One pipeline, many front doors.** The web app, the Telegram bot and the browser extension all call the same `/api/analyze` endpoint. The bot and extension do *not* import the pipeline directly — they are HTTP clients. That means a fix to the reasoning lands on every surface at once, each component can run on its own machine, and the API contract gets exercised by real second and third consumers (which is how you find out your own interface is awkward).

### Backend layout

```
backend/src/
├── config/env.js               all process.env reads, in one place
├── lib/groqClient.js           shared AI client + retry with backoff
├── services/
│   ├── claimExtractor.js       [1] decompose into atomic claims
│   ├── evidence.js             [2] RETRIEVE — Tavily → DuckDuckGo → Wikipedia
│   ├── verdict.js              [3] REASON — grounded, date-aware, validated
│   ├── pipeline.js             orchestration + bounded concurrency
│   ├── scraper.js              URL → clean markdown (Firecrawl)
│   ├── vision.js               screenshot → text (Groq vision)
│   └── transcription.js        video → timestamped transcript, in chunks
├── db/
│   ├── schema.sql              normalised schema
│   ├── migrate.js              idempotent migration runner
│   ├── pool.js                 connection pool (persistence is OPTIONAL)
│   └── analysisRepository.js   the only module that writes SQL
├── routes/
│   ├── analyze.js              text / URL / image / video endpoints
│   └── history.js              past analyses + stats
├── utils/                      logger, loose JSON parsing, SSE helpers
└── server.js                   composition root
```

Routes are deliberately thin: validate, choose an ingestion path, delegate, shape the response. No business logic.

### Database schema

Normalised to mirror the pipeline, with a foreign key at every level and `ON DELETE CASCADE` throughout:

```
analyses ──< claims ──< verdicts ──< sources
```

| Table | Holds |
|-------|-------|
| `analyses` | one row per submission — input type, submitted content, resolved content, surface, timestamp |
| `claims` | the atomic claims extracted from it, plus video timestamp when applicable |
| `verdicts` | one per claim — verdict (CHECK-constrained), confidence (0–100), reasoning, which provider supplied the evidence |
| `sources` | the cited URLs, with title and domain |

Sources are rows rather than a JSON blob, which makes questions like *"which domains do we cite most?"* or *"how often does the fallback actually get used?"* a single `GROUP BY`. Every foreign key is indexed — Postgres does not do this automatically, and the history query joins all four tables.

### Tech stack

| Layer | Choice |
|-------|--------|
| Frontend | React 19 + Vite |
| Backend | Node.js + Express 5 |
| AI reasoning & vision | Groq (`openai/gpt-oss-120b` for text, `qwen/qwen3.8-27b` for vision) |
| Speech-to-text | Whisper (`whisper-large-v3-turbo`, hosted on Groq) |
| Evidence retrieval | Tavily → DuckDuckGo → Wikipedia |
| Article scraping | Firecrawl |
| Database | PostgreSQL |
| Streaming | Server-Sent Events over POST |
| Bot | `node-telegram-bot-api` (long polling) |
| Extension | Manifest V3 |

---

## Quick start

```bash
git clone <your-repo-url>
cd truthlens
npm install
cp .env.example .env      # add your GROQ_API_KEY at minimum
npm run dev               # API on http://localhost:3000
```

In a second terminal:

```bash
cd frontend
npm install
npm run dev               # app on http://localhost:5173
```

Open <http://localhost:5173> and click one of the example claims.

**Only `GROQ_API_KEY` is strictly required.** Everything else degrades: without Tavily you fall back to DuckDuckGo and Wikipedia; without Firecrawl the URL tab reports that it is not configured; without PostgreSQL fact-checking works normally and only history is lost.

---

## Setup: web app

### 1. Get your keys

| Key | Where | Required? |
|-----|-------|-----------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free | **Yes** |
| `TAVILY_API_KEY` | [tavily.com](https://tavily.com) — free tier | Recommended |
| `FIRECRAWL_API_KEY` | [firecrawl.dev](https://firecrawl.dev) — free tier | Only for URL scraping |

### 2. Configure

```bash
cp .env.example .env
```

Fill in the keys. `.env` is gitignored; `.env.example` documents every option.

### 3. Run

```bash
npm run dev     # nodemon, restarts on change
npm start       # plain node
```

Check <http://localhost:3000> — the health endpoint reports which integrations are actually configured:

```json
{
  "status": "ok",
  "features": {
    "ai": true,
    "evidenceTavily": true,
    "evidenceFallbackDuckDuckGo": true,
    "urlScraping": true,
    "database": false
  }
}
```

### 4. Frontend

```bash
cd frontend
npm install
npm run dev
```

To point the app at a non-local API, create `frontend/.env`:

```
VITE_API_URL=https://your-api-host
```

---

## Setup: database (optional)

Without PostgreSQL, TruthLens runs in **no-persistence mode**: fact-checking is unaffected, and the History view explains why it is empty. This is deliberate — refusing to boot without a database would mean anyone cloning the repo sees a stack trace instead of a product.

To enable history:

1. Install PostgreSQL and make sure it is running.
2. Set credentials in `.env` (`DATABASE_URL`, or the `PG*` variables).
3. Run the migration:

```bash
npm run db:migrate
```

The runner creates the database if it does not exist, then applies `schema.sql`. The schema is written entirely with `IF NOT EXISTS`, so it is idempotent — running it twice is a no-op.

Restart the API; the health endpoint should now report `"database": true`.

---

## Setup: Telegram bot

The bot accepts text, links, images and text documents in chat, and replies with a formatted verdict per claim — emoji, confidence bar, reasoning and source links.

1. Message [@BotFather](https://t.me/botfather) on Telegram, send `/newbot`, follow the prompts.
2. Put the token in `.env`:

   ```
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   ```

3. Make sure the API is running (`npm run dev`), then in another terminal:

   ```bash
   npm run bot
   ```

4. Message your bot. Send `/start` for the intro, then paste any claim.

The bot uses **long polling**, so there is no webhook, no public URL and no tunnel to set up. If the API is on another host, set `TRUTHLENS_API_URL`.

---

## Setup: browser extension

Fact-check the page you are reading, or highlight any text, right-click, and get verdicts inline.

1. Make sure the API is running.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/` folder.

**Two ways to use it:**

- **Whole page** — click the TruthLens icon, then *Fact-check this page*. The content script extracts the readable article text and runs it through the pipeline.
- **Any selection** — highlight text on any page, right-click, choose *Fact-check "…" with TruthLens*. A panel slides in with the verdict cards.

If your API is not on `localhost:3000`, click the gear in the popup and set the URL. (You will also need to add that origin to `host_permissions` in `manifest.json`.)

Two implementation details worth noting: the panel is mounted in a **shadow root** so the host page's CSS cannot wreck it (and ours cannot wreck theirs), and **all** API calls go through the background service worker — a content script's fetches are subject to the page's own CORS and CSP, so on a strict site they would simply be blocked.

Icons are generated, not committed as binaries you have to trust:

```bash
node scripts/generate-extension-icons.js
```

---

## API reference

### `GET /`
Health check. Reports configured integrations.

### `POST /api/analyze`
One-shot text or URL analysis. A bare URL is scraped first.

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"text":"The Great Wall of China is visible from space."}'
```

```json
{
  "analysisId": 1,
  "inputType": "text",
  "claims": ["The Great Wall of China is visible from space."],
  "results": [{
    "claim": "The Great Wall of China is visible from space.",
    "verdict": "FALSE",
    "confidence": 92,
    "reasoning": "NASA and multiple sources state the Wall is not visible...",
    "sources": [{ "url": "https://...", "title": "...", "domain": "nasa.gov" }],
    "evidenceCount": 5,
    "evidenceProvider": "tavily"
  }],
  "summary": { "total": 1, "counts": { "TRUE": 0, "FALSE": 1, "MISLEADING": 0, "UNVERIFIABLE": 0 }, "trustScore": 0 }
}
```

### `POST /api/analyze/stream`
Same input, streamed over SSE. Events in order:

| Event | Payload |
|-------|---------|
| `status` | stage updates — `"Fetching and cleaning the article…"` |
| `claims` | the extracted claim list (lets the UI render one skeleton per pending claim) |
| `result` | one per claim, the moment its verdict is ready |
| `summary` | aggregate counts |
| `done` / `error` | terminal |

### `POST /api/analyze-image`
`multipart/form-data`, field `image`. Returns the same shape plus `extractedText` — what the vision model read out of your screenshot, shown in the UI so a misread is visible rather than mysterious.

### `POST /api/analyze-video`
`multipart/form-data`, field `video` (audio files work too). Streams SSE, adding a `transcript` event per audio chunk. Every `result` carries `startSeconds` and a `timestamp` label.

### `GET /api/history?limit=20&offset=0`
Past analyses, fully hydrated. Returns `{ available: false, analyses: [] }` with an explanatory message when Postgres is not connected — never an error.

### `GET /api/stats`
Aggregate verdict counts.

---

## How each input type is handled

### Text
Straight into the pipeline.

### URL
Firecrawl renders the page (including JS-heavy sites) and returns clean markdown. Raw HTML would be 95% navigation, cookie banners and scripts — it blows the context window and drowns the actual claims in noise.

### Image
Most misinformation people actually encounter is a *screenshot* — an X post, an Instagram infographic, a WhatsApp forward. Asking someone to retype that is exactly the friction that stops them checking anything. A Groq vision model transcribes the factual assertions; note that it is asked only to **transcribe**, never to judge. Extraction and judgement stay separate, which is what preserves the RAG guarantee end to end.

### Video
The interesting one.

ffmpeg extracts the audio and slices it into fixed-length segments. Each segment is transcribed by Whisper, its claims extracted and checked, and the verdicts streamed to the browser **before the next segment is even transcribed**. The user watches timestamped verdicts appear while the rest of the file is still processing, instead of staring at a spinner for ten minutes.

**The live-stream extension point.** This is why the transcriber is an async generator rather than a function returning a transcript:

```js
// backend/src/services/transcription.js
async function* transcribeChunkStream(chunkSource) { ... }

function transcribeVideo(videoPath, options = {}) {
  return transcribeChunkStream(fileChunkSource(videoPath, chunkSeconds));
}
```

`transcribeChunkStream` consumes *any* async iterable of audio chunks. To fact-check a live broadcast in real time, you replace `fileChunkSource` with one that yields chunks off an RTMP/HLS feed. Everything downstream — transcription, claim extraction, retrieval, verdicts, SSE — is unchanged, because none of it ever assumed the input was finite.

---

## Error handling philosophy

**The app must never hang or crash because one external call failed.** Concretely:

| Failure | What happens |
|---------|--------------|
| Tavily down / rate-limited | Falls through to DuckDuckGo, then Wikipedia |
| All search providers fail | Empty evidence → honest UNVERIFIABLE, no crash |
| Model returns malformed JSON | Loose parser salvages it; if not, a safe fallback verdict |
| Model call fails entirely | Fallback verdict that still lists the real retrieved sources |
| Model cites a URL we never fetched | Discarded before it reaches the user |
| Firecrawl fails / page paywalled | Clear message naming the domain, suggesting paste-as-text |
| One video chunk unreadable | Skipped; the rest of the timeline continues |
| Postgres unreachable | No-persistence mode; fact-checking unaffected |
| Client disconnects mid-stream | Detected on the response socket; work stops |
| Rate limit (429) / transient 5xx | Retried with exponential backoff. A 401 fails fast — it will never succeed on retry |

Two contracts hold this together. `getEvidence` **never throws** — it always returns an array, possibly empty. `getVerdict` **never throws** — it always resolves to a well-formed verdict object. Because those two hold, the analysis loop can keep going no matter what any single claim does.

On the frontend, every path has a designed state: an empty state with runnable examples, skeleton cards shaped like the results they become, a live status ticker, a distinct "no verifiable claims found" state, error states with retry, and an explained no-database state. A screen that shows nothing is treated as a bug.

---

## Project structure

```
truthlens/
├── backend/src/
│   ├── config/env.js
│   ├── lib/groqClient.js
│   ├── services/{claimExtractor,evidence,verdict,pipeline,scraper,vision,transcription}.js
│   ├── db/{schema.sql,migrate.js,pool.js,analysisRepository.js}
│   ├── routes/{analyze,history}.js
│   ├── utils/{logger,json,sse}.js
│   └── server.js
├── frontend/src/
│   ├── components/{InputPanel,VerdictCard,ConfidenceMeter,States,HistoryView,Icons}.jsx
│   ├── hooks/{useAnalysis,useTheme}.js
│   ├── lib/{api,sseClient,verdicts}.js
│   ├── styles/{tokens,base,components}.css
│   └── App.jsx
├── telegram-bot/bot.js
├── extension/{manifest.json,background.js,content.js,popup.*}
├── scripts/
│   ├── generate-extension-icons.js
│   └── manual-tests/          one-off scripts for poking each API directly
├── .env.example
└── README.md
```

### Frontend notes

- **Design tokens** (`styles/tokens.css`) are the single source of truth for colour, type, spacing and motion. No component hardcodes a hex value, which is what makes the light/dark toggle a token swap rather than a hunt through stylesheets.
- **SSE over POST.** The browser's `EventSource` is GET-only with no body, which is useless when you are posting text or a video file. So `lib/sseClient.js` reads the response with `fetch` + `ReadableStream` and parses the wire format directly. Video upload goes through `XMLHttpRequest` instead, because `fetch` still cannot report upload progress — and for a 200 MB file, a progress bar is the difference between "working" and "frozen".
- **Colour is never the only signal.** Every verdict carries a label and an icon alongside its colour, and `prefers-reduced-motion` is honoured throughout.

---

## Troubleshooting

**"Cannot reach the TruthLens API"** — the backend is not running, or `VITE_API_URL` points somewhere else. Check <http://localhost:3000>.

**Every verdict comes back UNVERIFIABLE** — evidence retrieval is failing. Check the server log: you should see which provider answered. If all three fail, check your network and `TAVILY_API_KEY`.

**"URL scraping is not configured"** — `FIRECRAWL_API_KEY` is missing. Paste the article text instead, or add the key.

**`model_not_found` from Groq** — model availability changes over time. List what your account can actually use:

```bash
node -e "require('dotenv').config();const G=require('groq-sdk');new G({apiKey:process.env.GROQ_API_KEY}).models.list().then(r=>console.log(r.data.map(m=>m.id).sort().join('\n')))"
```

Then set `GROQ_TEXT_MODEL` / `GROQ_VISION_MODEL` in `.env`.

**Video analysis fails immediately** — `ffmpeg-static` should provide the binary automatically. Verify:

```bash
node -e "console.log(require('ffmpeg-static'))"
```

**History is always empty** — Postgres is not connected. Check the health endpoint's `database` flag, then run `npm run db:migrate`.

**Extension does nothing on a page** — content scripts cannot run on `chrome://` pages, the Chrome Web Store, or PDFs. Try an ordinary website.

---

## License

MIT

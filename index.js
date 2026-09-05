require('dotenv').config(); 
// Loads the .env file into this program.
// This makes process.env.GROQ_API_KEY and process.env.TAVILY_API_KEY
// available anywhere in this file. Without this line, both would be undefined.
const cors = require('cors');

const express = require('express');
// Imports the Express library — the tool that lets us build a web server
// (handle incoming requests, send back responses) without writing raw networking code.

const Groq = require('groq-sdk'); 
// Imports Groq's official toolbox/library for talking to their AI models easily.

const axios = require('axios');
// Imports axios — a generic tool for sending HTTP requests to any URL.
// We use this for Tavily, since Tavily doesn't have its own official library like Groq does.

const FirecrawlApp= require('@mendable/firecrawl-js').default;
const firecrawl= new FirecrawlApp({apiKey: process.env.FIRECRAWL_API_KEY});
const app = express();
// Creates the actual Express application/server object.
// From now on, "app" represents your entire running server —
// every route (like app.get, app.post) gets attached to this object.
app.use(cors());
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); 
// Creates an authenticated connection to Groq, using your secret key from .env.
// Every time you write groq.chat.completions.create(...), you're using this connection.

app.use(express.json()); 
// Middleware — code that runs automatically on EVERY incoming request, before your routes handle it.
// express.json() specifically looks for JSON data in incoming requests
// (like { "text": "some claim" }) and converts it into a real JavaScript object,
// attached to req.body. Without this, req.body would be undefined and your routes
// couldn't read anything the user sent.


/* ============================
   AI / EVIDENCE HELPER FUNCTIONS
   These three functions do the actual "thinking" work.
   None of them are routes — they're just reusable pieces
   that our routes will call later.
   ============================ */


async function extractClaims(text) {
  // Takes one input: "text" — the raw paragraph/claim the user submitted.
  // "async" means this function will pause and wait for a slow network call (to Groq),
  // without freezing the rest of the program while it waits.

  const response = await groq.chat.completions.create({
    // Sends a request to Groq's chat API and waits ("await") for the reply.
    // The full reply gets stored in "response".

    messages: [
      // "messages" is the conversation we're sending to Groq.
      // It's an array because a real chat could have many back-and-forth messages;
      // here we only send one.
      {
        role: 'user', 
        // "role: 'user'" means this message is from the human/us,
        // as opposed to 'assistant' (a previous AI reply) or 'system' (special instructions).

        content: `Extract each distinct factual claim from the following text. Respond ONLY with a JSON array of strings, nothing else - no explanation, no markdown formatting.
Text: "${text}"`
        // The actual instruction we're giving Groq, written with backticks (template literal)
        // so we can insert the "text" variable directly using ${text}.
        // We explicitly demand ONLY a JSON array back — no extra sentences —
        // so our code can reliably read the response as real data, not a paragraph.
      }
    ],

    model: 'openai/gpt-oss-120b',
    // Tells Groq which AI model to use for this request.
    // (The old model name, llama-3.3-70b-versatile, was retired/shut down by Groq.)
  });

  return JSON.parse(response.choices[0].message.content);
  // response.choices is an array of possible replies (we only asked for one, so [0]).
  // .message.content is where the actual text Groq wrote lives — 
  // at this point it's just a STRING that looks like JSON, e.g. '["claim1","claim2"]'.
  // JSON.parse(...) converts that string into a REAL JavaScript array we can use in code.
  // "return" sends this array back to whatever code called extractClaims(...).
}


async function getEvidence(claim) {
  // Takes one input: "claim" — a single claim string (one item from the array above).

  try {
    const tavilyResponse = await axios.post('https://api.tavily.com/search', {
      // Sends a POST request to Tavily's search endpoint and waits for the reply.
      // First argument = the URL we're sending to.
      // Second argument = the data we're sending, described below.

      api_key: process.env.TAVILY_API_KEY,
      // Our secret Tavily key, proving to Tavily that this request is really from us.

      query: claim,
      // The actual search query — here, we're searching for evidence about this specific claim.

      max_results: 5
      // Limits Tavily to sending back only the top 5 most relevant results,
      // so we don't get overwhelmed with data.
    });

    return tavilyResponse.data.results;
    // tavilyResponse is the full reply object (status codes, headers, etc — we don't need all of that).
    // tavilyResponse.data is the actual content Tavily sent back.
    // .results is specifically the array of search result objects
    // (each with title, content, url, score) — this is our "evidence."
    // We return just this array, since that's the only part we actually need.
  } catch (error) {
    // If Tavily is down, times out, or the network drops (e.g. ECONNRESET),
    // axios throws instead of returning a response — and without this catch,
    // that throw would bubble all the way up and crash the whole /api/analyze request.
    console.log('Tavily request failed for claim:', claim, error.message);

    return [];
    // Return an empty evidence array instead of throwing, so this one claim
    // just ends up with no evidence — the rest of the request keeps going.
  }
}


async function getVerdict(claim, evidence) {
  // Takes TWO inputs: the claim (string) and the evidence (array of result objects from Tavily).

  const evidenceText = evidence
    .map((e, i) => `Source ${i + 1} (${e.url}): ${e.content}`)
    .join('\n\n');
  // evidence.map(...) goes through each evidence object one at a time.
  // For each one (called "e", with its position in the array called "i"),
  // it builds a readable line like: "Source 1 (https://example.com): some snippet text"
  // .join('\n\n') then glues all these individual lines together into ONE big block of text,
  // with a blank line between each source, so it reads clearly.
  // We need this because Tavily gives us structured DATA (objects),
  // but our next Groq prompt needs plain readable TEXT.
  const today = new Date().toISOString().split('T')[0];
  const response = await groq.chat.completions.create({
    // Same idea as extractClaims — send a request to Groq, wait for the reply.

    messages: [
      {
        role: 'user',
                content: `You are a fact-checker. Today's date is ${today}. Given a claim and evidence from real sources, determine a verdict.

IMPORTANT: Evidence sources may be outdated. If a source describes a past status without confirming it's still current as of today, do not assume it's still true or false. If ambiguous, lean toward UNVERIFIABLE rather than confidently wrong.

Claim: "${claim}"

Evidence:
${evidenceText}

Respond ONLY with a JSON object in this exact format, nothing else:
{
  "verdict": "TRUE" | "FALSE" | "MISLEADING" | "UNVERIFIABLE",
  "confidence": <a plain integer number between 0 and 100, e.g. 82 - NEVER spell it out as a word like "seventy">,
  "reasoning": "a 1-2 sentence explanation",
  "sources": ["url1", "url2"]
}`
        // This prompt gives Groq THREE things: 
        // 1) the claim itself, 2) the real evidence we gathered, and 
        // 3) a strict JSON format to respond in (an OBJECT this time, not just an array,
        // because we need multiple labeled fields back: verdict, confidence, reasoning, sources).
      }
    ],
    model: 'openai/gpt-oss-120b',
  });

   try {
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.log('Failed to parse verdict JSON, using fallback:', error.message);
    return {
      verdict: "UNVERIFIABLE",
      confidence: 50,
      reasoning: "Could not generate a reliable verdict for this claim due to a formatting error.",
      sources: []
    };
  }
}
  // Same as before — convert Groq's text reply (a JSON-shaped string)
  // into a real JavaScript object we can actually use, then return it.


function isUrl(text) {
  // Checks if the input looks like a web link (starts with http:// or https://).
  // Returns true or false.
  return /^https?:\/\/\S+$/.test(text.trim());
}

async function scrapeArticle(url) {
  // Takes a URL, asks Firecrawl to visit that page and extract clean text from it.
  const result = await firecrawl.scrapeUrl(url, {
    formats: ['markdown']
  });
  return result.markdown;
}





/* ============================
   ROUTES
   These are the actual "doors" into your server —
   the URLs that the frontend (or Postman/curl) will send requests to.
   ============================ */


app.get('/', (req, res) => {
  // Defines what happens when someone visits the homepage ("/") using a GET request
  // (GET = what browsers normally do when you type a URL and hit enter).
  // "req" = information about the incoming request (not used here).
  // "res" = the tool we use to send a response back.

  res.send('Hello from Veristate backend!');
  // Sends back plain text — just a simple way to confirm the server is alive and reachable.
});


app.post('/api/analyze', async (req, res) => {
  // Defines what happens when someone sends a POST request (submits data) to /api/analyze.
  // This is the MAIN route — the real brain of Veristate.
  // "async" because this route will call several slow functions (Groq, Tavily) and must wait for them.

  
  
  const { text } = req.body;
  // Destructuring: req.body is the JSON data the frontend sent, e.g. { "text": "some paragraph" }.
  // This line pulls out just the "text" field into its own variable.
  // Equivalent to writing: const text = req.body.text;

  console.log('Received text:', text);
  // Prints the incoming text to your terminal — useful for debugging,
  // so you can see exactly what the server received while testing.

  let contentToAnalyze = text;
  // Starts as whatever the user sent. Uses "let" (not "const") because
  // this value might get REPLACED below if it turns out to be a URL.

  if (isUrl(text)) {
    // Checks if the input looks like a link. If yes, run this block.
    console.log('Detected a URL — scraping with Firecrawl...');
    contentToAnalyze = await scrapeArticle(text);
    // Overwrites contentToAnalyze with the actual scraped article text.
    console.log('Scraped content length:', contentToAnalyze.length);
  }
  // If the input was NOT a URL, this whole block is skipped,
  // and contentToAnalyze just stays equal to the original typed text.

  const claims = await extractClaims(contentToAnalyze);
  // Calls our first helper function — now using contentToAnalyze instead of text,
  // so this works correctly whether the input was plain text OR a scraped article.




  const results = [];
  // Creates an empty array. We'll fill this with one verdict object per claim,
  // as we loop through them below.

  for (const claim of claims) {
    // A "for...of" loop: goes through the "claims" array one item at a time.
    // On each pass, the current claim (a single string) is stored in the variable "claim".
    // Everything inside these { } runs once PER claim.

    const evidence = await getEvidence(claim);
    // For this specific claim, fetch real evidence from Tavily.

    const verdict = await getVerdict(claim, evidence);
    // Using this claim AND its evidence, ask Groq for a structured verdict.

    results.push({ claim, ...verdict });
    // Adds a new object to the "results" array.
    // { claim, ...verdict } combines the claim text with every field inside "verdict"
    // (verdict, confidence, reasoning, sources) into one flat object — 
    // e.g. { claim: "...", verdict: "TRUE", confidence: 90, reasoning: "...", sources: [...] }.
    // The "..." here is called the spread operator — it unpacks verdict's fields
    // directly into this new object, instead of nesting it inside a sub-object.
  }
  // Once the loop has gone through every single claim, we exit here.

  res.json({ results });
  // Sends the entire results array back to whoever called this route (the frontend, or Postman),
  // formatted as JSON: { "results": [ {...}, {...} ] }
});


app.listen(3000, () => {
  // Starts the server, telling it to listen for incoming requests on port 3000
  // (so your server is reachable at http://localhost:3000 while running locally).

  console.log('Server running on http://localhost:3000');
  // Prints a confirmation message to your terminal once the server successfully starts.
});
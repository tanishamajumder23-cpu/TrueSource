require('dotenv').config();
const Groq = require('groq-sdk');
const axios = require('axios');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getVerdict(claim, evidence) {
  const evidenceText = evidence
    .map((e, i) => `Source ${i + 1} (${e.url}): ${e.content}`)
    .join('\n\n');

  const response = await groq.chat.completions.create({
    messages: [
      {
        role: 'user',
        content: `You are a fact-checker. Given a claim and evidence from real sources, determine a verdict.

Claim: "${claim}"

Evidence:
${evidenceText}

Respond ONLY with a JSON object in this exact format, nothing else:
{
  "verdict": "TRUE" | "FALSE" | "MISLEADING" | "UNVERIFIABLE",
  "confidence": 0-100,
  "reasoning": "a 1-2 sentence explanation",
  "sources": ["url1", "url2"]
}`
      }
    ],
    model: 'openai/gpt-oss-120b',
  });

  console.log(response.choices[0].message.content);
}

async function testFullFlow() {
  const claim = "Coffee is bad for your health";

  const tavilyResponse = await axios.post('https://api.tavily.com/search', {
    api_key: process.env.TAVILY_API_KEY,
    query: claim,
    max_results: 3
  });

  await getVerdict(claim, tavilyResponse.data.results);
}

testFullFlow();
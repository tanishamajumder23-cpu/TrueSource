require('dotenv').config(); // loads the .env so the API key is available here
const express = require('express');
const Groq = require('groq-sdk'); // Groq's library for talking to the AI

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); // connects using our secret key
//loads Groq's toolbox so you can talk to their AI models.
app.use(express.json()); // lets Express understand JSON data sent to it, This is a middleware — a function that runs on every incoming request before it reaches your routes.
//Specifically, express.json() looks at incoming requests, and if they contain JSON data (like { "claim": "coffee cures cancer" }), it parses that text into a real JavaScript object and attaches it to req.body. Without this line, req.body would just be undefined, and your /fact-check route couldn't read what was sent.

// Homepage route — just to check the server is alive
app.get('/', (req, res) => {//When someone visits the homepage (/) using a GET request (which is what browsers do by default when you type a URL), run this function.
  res.send('Hello from Veristate backend!');//res.send(...) = send back plain text as the reply
});
/*

// Fact-check route — where claims will be sent
app.post('/fact-check', async (req, res) => {//when someone sends data (POST) to /fact-check, run this
   // async lets us await that without freezing the whole server.
  const { claim } = req.body;//This is called destructuring. If someone sent { "claim": "coffee cures cancer" }, then req.body is that whole object, and this line pulls out just the claim field into its own variable. It's equivalent to writing const claim = req.body.claim;, just shorter.

  console.log('Received claim:', claim);

  res.json({ message: 'Got your claim!', claim: claim });
});
*/

app.post('/fact-check', async (req, res) => {
  const { claim } = req.body;

  console.log('Received claim:', claim);

  const response = await groq.chat.completions.create({
    messages: [
      {
        role: 'user',
        content: `Is this claim true, false, or misleading? Explain briefly. Claim: "${claim}"`,
      },
    ],
    model: 'llama-3.3-70b-versatile',
  });

  const verdict = response.choices[0].message.content;

  res.json({ claim: claim, verdict: verdict });
});
// Starts the server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
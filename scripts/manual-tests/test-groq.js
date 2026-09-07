require('dotenv').config();//loads your .env file so process.env.GROQ_API_KEY becomes available in this file
const Groq = require('groq-sdk');//imports Groq's official library for making API calls easily
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
//creates a connection to Groq using your secret key from .env
async function testGroq() {//needed because API calls take a moment to respond, so we await the result instead of freezing everything else
  const response = await groq.chat.completions.create({//this is the actual API call; messages is what you're asking, model is which AI model to use
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    model: 'llama-3.3-70b-versatile',
  });

  console.log(response.choices[0].message.content);//this is where the AI's actual text reply lives inside the response object
}

testGroq();
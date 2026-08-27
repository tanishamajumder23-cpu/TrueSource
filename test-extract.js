require('dotenv').config();
const Groq=require('groq-sdk');
const groq= new Groq({apiKey: process.env.GROQ_API_KEY});
async function extractClaims(text){
    const response = await groq.chat.completions.create({
        messages:[
            {
                role:'user',
                content: `Extract each distinct factual claim from the following text. Respond ONLY with a JSON array of strings, nothing else - no explanation, no markdown formatting.
            Text:"${text}"`
            }
        ],
        model: 'openai/gpt-oss-120b',
    });
    console.log(response.choices[0].message.content);
}
extractClaims("Trump has nothing to do with Project 2025, and unemployment hit a 10- year low under his term.");
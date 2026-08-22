require ('dotenv').config();
/*What require means: in Node.js, your code doesn't 
automatically know about outside tools/libraries. 
require('something') is how you say "hey, go fetch 
that tool and let me use it in this file." 
Think of it like importing a toolbox. */
//dotenv is a small tool whose only job is 
// to read your .env file and make those values available in your code.
//.config() is just "run it now, go read that file."
//Without this line, process.env.TAVILY_API_KEY (used later) 
// would be empty — this line is what makes it work.
const axios=require('axios');//we're pulling in the axios toolbox.
//whenever you type axios.something, you're using that tool.
async function testTavily(){//defines a function — basically a named block of instructions you can run later by calling testTavily().
    /*The word async in front means: "
    this function is going to do something that 
    takes time (like waiting for the internet), 
    so give it permission to pause and wait without 
    freezing the whole program." Without async, 
    you can't use the await keyword inside it 
    (which shows up next). */
    const response= await axios.post('https://api.tavily.com/search',{
        /*axios.post(url, data) — this literally means 
        "send data to this web address." post is a 
        type of request — think of it like mailing a 
        letter (POST = sending something), as opposed 
        to just asking to look at a page 
        (that would be get). */
        api_key: process.env.TAVILY_API_KEY,
        query: 'Is coffee good for health?',
        max_results: 3
    });
    /*
    
    First argument, the URL: 'https://api.tavily.com/search' 
    — this is where we're sending our letter. 
    It's Tavily's specific address for handling 
    search requests. 
    
    
    Second argument, the { } object: this is 
    what's inside the letter. Three things:
    api_key: process.env.TAVILY_API_KEY — this proves to Tavily 
    "it's really me," using the secret key from 
    your .env file
    query: 'Is coffee good for health?' — this is the actual 
    question/claim we want evidence about
    max_results: 3 — tells Tavily "don't overwhelm me, 
    just give me your best 3 results"

    await — since sending this request and getting a reply 
    takes a moment (it's going over the internet), 
    await means "pause right here 
    and wait for the reply before moving to the next line.
    " Without it, your code would try to move on 
    before Tavily even responded.

    const response =  — once the reply comes back, 
    store the entire reply in a variable called response,
    so we can look inside it on the next line.
    */
    console.log(response.data.results);

}
testTavily();
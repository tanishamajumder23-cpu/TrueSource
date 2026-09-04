require('dotenv').config();

async function testScrape() {
  try {
    const { default: FirecrawlApp } = await import('@mendable/firecrawl-js');
    const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

    console.log('Starting scrape...');

    const result = await firecrawl.scrapeUrl('https://en.wikipedia.org/wiki/Artificial_intelligence', {
      formats: ['markdown']
    });

    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error occurred:', err);
  }
}

testScrape();
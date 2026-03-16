import { scrapeProfile } from './tools/scrapeTool.js';

async function run() {
  console.log("Linkedin scraping...");
  const result = await scrapeProfile("https://www.linkedin.com/in/hasan-zekeriya-simsek-444b05183/");
  console.log("Usage Warning:", result.usageWarning);
  console.log("Title:", result.title);
  console.log("Markdown Bytes:", result.markdown.length);
  console.log("Emails found:", result.emails);
}
run().catch(console.error);

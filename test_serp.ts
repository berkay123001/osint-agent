import 'dotenv/config';
import { searchReverseImage } from './src/tools/reverseImageTool.js';

async function run() {
    console.log("Testing SerpAPI Reverse Image Search with provided key...");
    const res = await searchReverseImage('https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png');
    console.log(JSON.stringify(res, null, 2));
}
run();

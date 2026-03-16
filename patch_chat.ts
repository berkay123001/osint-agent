import fs from 'fs';

const chatPath = '/home/berkayhsrt/Baykara/osint-agent/src/chat.ts';
let code = fs.readFileSync(chatPath, 'utf8');

const toolDefinition = `
  {
    type: "function",
    function: {
      name: "compare_images_phash",
      description: "İki görselin perceptual hash (pHash) değerlerini karşılaştırarak kriptografik olarak benzerliklerini ölçer. Bir haberdeki görselin başka bağlamdaki bir fotoğrafla aynı olup olmadığını analiz eder.",
      parameters: {
        type: "object",
        properties: {
          url1: { type: "string", description: "Birinci görselin tam URL'si" },
          url2: { type: "string", description: "Karşılaştırma yapılacak ikinci görselin tam URL'si" }
        },
        required: ["url1", "url2"]
      }
    }
  },`;

const toolExecution = `
          case 'compare_images_phash':
            console.log(chalk.blue(\`[Tool] Görseller karşılaştırılıyor: \${args.url1} <-> \${args.url2}...\`))
            toolResult = await compareImages(args.url1, args.url2)
            break;`;

// insert definition
code = code.replace(
  'const tools: OpenAI.Chat.ChatCompletionTool[] = [',
  'const tools: OpenAI.Chat.ChatCompletionTool[] = [' + toolDefinition
);

// insert execution
code = code.replace(
  "case 'search_person':",
  toolExecution + "\n          case 'search_person':"
);

fs.writeFileSync(chatPath, code);
console.log("Patched chat.ts!");

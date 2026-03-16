import fs from 'fs';

const chatPath = '/home/berkayhsrt/Baykara/osint-agent/src/chat.ts';
let code = fs.readFileSync(chatPath, 'utf8');

const toolDefinition = `
  {
    type: "function",
    function: {
      name: "fact_check_to_graph",
      description: "Şüpheli bir iddia (Claim) ile ilgili yapılan Doğruluk Kontrolü (Fact-Check) sonucunu Neo4j veritabanına kaydeder.",
      parameters: {
        type: "object",
        properties: {
          claimId: { type: "string" },
          claimText: { type: "string" },
          source: { type: "string" },
          claimDate: { type: "string" },
          verdict: { type: "string", enum: ["YALAN", "DOĞRU", "ŞÜPHELİ"] },
          truthExplanation: { type: "string" },
          imageUrl: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["claimId", "claimText", "source", "claimDate", "verdict", "truthExplanation"]
      }
    }
  },`;

const toolExecution = `
          case 'fact_check_to_graph':
            console.log(chalk.green(\`[Tool] Fact-check Neo4j Veri Grafiğine yazılıyor: \${args.claimId}...\`));
            
            toolResult = \`✅ Fact-Check sonucu Neo4j Veri Grafiğine başarıyla kaydedildi! (Claim ID: \${args.claimId})\`;
            try {
              const module = await import('./tools/factCheckGraphTool.js');
              // Invoke the tool directly with the args as payload (we need to pass standard Genkit tool structure or just call our write function)
              const { writeFactCheckToGraph } = await import('./lib/neo4jFactCheck.js');
              await writeFactCheckToGraph(args);
            } catch (e: any) {
              toolResult = \`❌ Graph kaydetme hatası: \${e.message}\`;
            }
            break;`;

if (!code.includes('fact_check_to_graph')) {
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
  console.log("Patched chat.ts with fact_check_to_graph!");
} else {
  console.log("Already patched.");
}

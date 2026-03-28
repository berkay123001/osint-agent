# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run chat                 # Interactive CLI chat (main usage mode)
npm run graph                # Start graph visualization server (port 3333)
npm run dev                  # GenKit development server
npm run build                # tsc compile to dist/

# Testing
npm test                     # Unit tests (chatHistory, githubGpgUtils, osintHeuristics, sherlock, github)
npm run test:tools           # All src/tools/*.test.ts files
npm run test:agent:unit      # Agent unit tests only (chatHistory, githubGpgUtils, osintHeuristics)
npm run test:graph:local     # Neo4j integration tests (requires NEO4J_ALLOW_CLEAR=1 + local Neo4j)
npm run test:seed            # Seed test graph data

# Database
npm run db:clear             # Clear Neo4j graph (requires NEO4J_ALLOW_CLEAR=1)

# CLI agent
npx tsx src/tools/agentCli.ts "question"    # Send question to agent
npx tsx src/tools/agentCli.ts --history     # Show session history
npx tsx src/tools/agentCli.ts --reset       # Reset session

# Graph server
./start.sh                   # Start graph UI (background, port 3333)
./stop.sh                    # Stop graph server
```

## Architecture

**Multi-agent OSINT system** routing through a supervisor to specialized sub-agents. All LLM calls go through OpenRouter API using Qwen models.

```
User → Supervisor (qwen3.5-plus) → Identity / Media / Academic agents
                                      ↓
                              Tool Registry (30+ tools)
                                      ↓
                           Neo4j + Search APIs + Python tools
```

### Agent routing (supervisorAgent.ts)
- **Identity queries** (username, email, GitHub) → IdentityAgent (qwen3.5-flash, maxToolCalls: 30)
- **Media queries** (images, fact-check, EXIF) → MediaAgent (qwen3.5-flash, maxToolCalls: 30)
- **Academic queries** (papers, plagiarism) → AcademicAgent (qwen3.5-plus, maxToolCalls: 60)
- **Graph queries, reports, general search** → handled directly by Supervisor

### Agent loop (baseAgent.ts)
- `runAgentLoop(history, config)` — shared loop for all agents
- Manages tool calls, empty response retries, JSON argument correction with global cap
- Strips `<think/>` tokens from Qwen model responses
- Uses OpenAI SDK client pointed at OpenRouter (`https://openrouter.ai/api/v1`)

### Key types (agents/types.ts)
- `AgentConfig` — name, systemPrompt, tools, executeTool, model, maxToolCalls
- `Message` — alias for `OpenAI.Chat.ChatCompletionMessageParam`
- `AgentResult` — finalResponse, toolCallCount, toolsUsed

### Tool Registry (lib/toolRegistry.ts)
Central dispatcher — agents call `executeTool(name, args)`, registry routes to the right implementation with session-based caching to avoid redundant API calls.

### Search chain (tools/searchTool.ts)
Three-tier fallback: Brave Search → Google CSE → Tavily. Social media `site:` queries skip Brave and start at Google CSE.

## Key Patterns

- **ES Modules**: `"type": "module"` in package.json. All local imports use `.js` extension (e.g., `import { foo } from './bar.js'`)
- **Zod schemas**: Tool parameters validated with zod in tool definitions
- **Neo4j queries**: Always parameterized — never interpolate values into Cypher strings
- **Session persistence**: Chat sessions saved to `.osint-sessions/` as JSON
- **Python subprocess**: Sherlock and Holehe invoked via `PYTHON_PATH` env var, with input validation (regex email check for Holehe)
- **SSRF protection**: URL tools block localhost and private IP ranges
- **Puppeteer stealth**: Web scraping uses puppeteer-extra-plugin-stealth for anti-bot bypass

## Environment

Required in `.env`:
- `OPENROUTER_API_KEY` — LLM access
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` — graph database
- `PYTHON_PATH` — Python binary with sherlock-project, holehe, scrapling installed

Search chain (at least one): `BRAVE_SEARCH_API_KEY`, `GOOGLE_SEARCH_API_KEY`+`GOOGLE_SEARCH_CX`, `TAVILY_API_KEY`

Optional: `GITHUB_TOKEN`, `HIBP_API_KEY`, `SERP_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, `GRAPH_PORT`

## Known Limitations

- **Twitter/X**: Nitter instances mostly blocked; falls back to Scrapling stealth scraping
- **noreply GitHub emails**: Skip Holehe scan for these, not useful
- **Flash model**: Can return empty responses after long tool chains (retry mechanism exists in baseAgent)
- **HIBP**: Free tier rate limit — 1 request per 6 seconds
- **Brave Search**: Free tier 2000 requests/month, auto-throttled at 1.1s/request

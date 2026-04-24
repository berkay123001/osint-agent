<div align="center">

# OSINT Agent

**Multi-agent open-source intelligence system**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org)
[![Neo4j](https://img.shields.io/badge/neo4j-5.x-008CC1)](https://neo4j.com)
[![OpenRouter](https://img.shields.io/badge/LLM-OpenRouter-purple)](https://openrouter.ai)

A multi-agent OSINT system designed for investigating individuals, usernames, emails, and media content; cross-verifying social media accounts; detecting fake content and academic plagiarism.

</div>

---

> **Academic Notice:** This project is part of an ongoing academic paper. Please do not reproduce the architecture or results without citation.

> **Legal Notice:** This tool is intended solely for ethical OSINT research, journalism, and cybersecurity studies. It only collects data from public sources. The user bears full responsibility for its use.

---

## Features

| Domain | Capability |
|--------|------------|
| Identity Investigation | Username scan across 400+ platforms (Sherlock), email registration check (Holehe), deep GitHub analysis, data breach check |
| Media Verification | Reverse image search, EXIF/metadata analysis, perceptual hash comparison, Wayback Machine archive |
| Academic Research | arXiv, Semantic Scholar, ORCID integration; plagiarism and originality detection |
| Visual Intelligence | Automated face analysis (DeepFace), cross-platform avatar comparison, reverse image search pipeline |
| Graph Analysis | Neo4j-based connection mapping, D3.js live visualization |
| Claim Verification | Multi-source independent verification, Reddit community analysis, source credibility labels |
| Strategy Agent | Research planning, quality review, and report synthesis via dedicated reasoning model |
| Obsidian Sync | Reports automatically sync to Obsidian vault + daily note system |

---

## Architecture

```
User → Supervisor (MiniMax M2.7)
              │
     ┌────────┼────────┐
     ▼        ▼        ▼
  Identity   Media   Academic
   Agent     Agent    Agent
 (Qwen 3.5) (Qwen 3.5) (Qwen 3.5)
     │        │        │
     └────────┼────────┘
              │
      Strategy Agent (DeepSeek v3.2)
      Plan → Review → Synthesize
              │
      Tool Registry (35+ tools)
              │
     ┌────────┼────────┐
     ▼        ▼        ▼
   Neo4j   Search    Python
   (Graph)  Chain   (Sherlock
                     Holehe
                     DeepFace
                     Scrapling)
```

| Agent | Model | Responsibility |
|-------|-------|---------------|
| **Supervisor** | MiniMax M2.7 | Coordination, synthesis, graph queries, reporting |
| **Identity Agent** | Qwen 3.5 Flash | Username, email, GitHub, breach investigation |
| **Media Agent** | Qwen 3.5 Flash | Image verification, fact-check, EXIF analysis |
| **Academic Agent** | Qwen 3.5 Flash | Paper survey, researcher profiles, plagiarism |
| **Strategy Agent** | DeepSeek v3.2 | Research planning, quality review, report synthesis |

### Strategy Agent Pipeline

Each sub-agent delegation follows a 4-phase pipeline:

```
Strategy Plan → Sub-Agent Execution → Strategy Review → Strategy Synthesis
                    ↓                       ↓
              (tool calls)         (quality check — if rejected,
                                   feedback injected into agent
                                   history, 1 retry allowed)
```

The Strategy Agent is **session-aware** — it remembers its own plan during review and synthesis, enabling coherent quality control.

---

## Installation

### Option 1: Quick Install (npm)

```bash
# Global install
npm install -g osint-agent

# Setup wizard (Docker, Neo4j, Python, .env)
osint --setup
```

### Option 2: Developer Install (from source)

```bash
git clone https://github.com/user/osint-agent.git
cd osint-agent
npm install
npm run build

# Setup wizard
node dist/cli.js --setup

# or with tsx directly
npx tsx src/cli.ts --setup
```

### What the Setup Wizard Does

`osint --setup` runs a 5-step interactive wizard:

| Step | Check | Auto Action |
|------|-------|-------------|
| 1. Docker | Version check | — |
| 2. SearXNG + Firecrawl | URL access test | If not running, `docker compose up -d` |
| 3. Neo4j | Connection test | If failed, install via Docker + set password |
| 4. Python | Version + package check | If missing, `pip install sherlock-project holehe scrapling` |
| 5. .env | File existence check | Copy from `.env.example` or create interactively |

### Uninstall

```bash
osint --uninstall
```

The uninstall wizard:
- Stops and removes Docker containers (osint-searxng, osint-neo4j, osint-deepface)
- Shuts down all services with `docker compose down`
- Deletes `.osint-sessions/` session files
- Prompts before deleting `.env` (API key protection)
- Shows remaining steps: `npm uninstall -g osint-agent`

### Requirements

| Component | Required? | Notes |
|-----------|-----------|-------|
| Node.js >= 18 | Yes | For `npm install -g` |
| OpenRouter API key | Yes | LLM access |
| Docker | Optional | SearXNG + Firecrawl + Neo4j + DeepFace (recommended) |
| Python >= 3.10 | Optional | Sherlock, Holehe, Scrapling |
| Neo4j >= 5.x | Optional | Graph analysis (auto via Docker) |

### Environment Variables

```bash
cp .env.example .env
```

```env
# Required
OPENROUTER_API_KEY=sk-or-v1-...

# Docker services (docker compose up -d)
SEARXNG_URL=http://localhost:8888
FIRECRAWL_URL=http://localhost:3002/v1/scrape

# Search engines (at least one)
BRAVE_SEARCH_API_KEY=BSA...
GOOGLE_SEARCH_API_KEY=AIza...
GOOGLE_SEARCH_CX=abc123...
TAVILY_API_KEY=tvly-...

# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123

# Python (Sherlock + Holehe + Scrapling)
PYTHON_PATH=/path/to/python

# Optional
GITHUB_TOKEN=ghp_...
HIBP_API_KEY=...
SERP_API_KEY=...
SEMANTIC_SCHOLAR_API_KEY=...
GRAPH_PORT=3333
FIRECRAWL_API_KEY=...
```

---

## Usage

### Interactive REPL

```bash
osint                  # npm global
npm run chat           # developer mode
```

```
        ╔════════════════════════╗
        ║   G . U . A . R . D   ║
        ╚════════════════════════╝

  Supervisor : minimax/minimax-m2.7
  Sub-agents : qwen/qwen3.5-flash-02-23

  Commands: /reset · /history · /resume · exit

  ❯ investigate torvalds GitHub account
```

**REPL Commands:**

| Command | Description |
|---------|-------------|
| `/reset` | Reset session, archive current session |
| `/history` | Session statistics (question/answer count) |
| `/resume` | List saved sessions, select and continue |
| `exit` | Archive session and exit |

**Session System:**
- Every conversation is auto-saved to `.osint-sessions/`
- `exit` and `/reset` archive the current session to a timestamped file
- `/resume` lets you pick a past session and continue where you left off

### Single Query Mode

```bash
osint "investigate torvalds GitHub account"
```

### Graph Visualization

```bash
osint --graph     # or ./start.sh
# → http://localhost:3333
```

Node colors: Red (Person), Blue (Username/Platform), Green (Fact), Orange (Claim), Yellow (Source)

---

## Search Chain

Four-tier cascading fallback:

```
SearXNG (self-hosted) → Brave Search → Google CSE → Tavily
  (100+ engines, unlimited)  (2000/month)   (100/day)    (last resort)
```

- Social media `site:` queries skip Brave and go directly to Google CSE
- `search_web_multi`: 3 parallel queries, URL-based dedup, max 30 results

---

## Source Credibility System

Every search result gets an auto-applied label:

| Label | Meaning |
|-------|---------|
| `Official institution (.gov/.edu)` | Government/university source |
| `Reference source` | Wikipedia, archive.org |
| `Tech press` | TechCrunch, Wired, Ars Technica |
| `Community discussion` | Reddit (with vote counts), HN, StackOverflow |
| `Product's own page` | Vendor claim + conflict of interest warning |
| `General blog platform` | Medium, dev.to — author expertise unverified |

### Claim Verification (`verify_claim`)

Multi-source evidence aggregation:

1. Scrape the primary source
2. Search community sources like Reddit/HN
3. Pull discussion details via Reddit JSON API (post score, comment scores, opinion currents)
4. Login wall detection — pages behind login walls are flagged

**Important:** A claim not appearing on a site does not mean the claim is false. Result returns `inconclusive`.

---

## DeepFace Visual Intelligence

Automated face analysis pipeline powered by DeepFace (Docker):

```bash
docker compose up -d deepface    # Starts on port 5000
```

| Feature | Details |
|---------|---------|
| Face Analysis | Age estimation (opencv + Facenet) |
| Face Verification | Same/different person detection with distance score |
| Cross-Platform Compare | Avatar matching across social media platforms |
| Auto Pipeline | `auto_visual_intel` — scrape profile → extract avatar → analyze → reverse search |

---

## Obsidian Integration

Reports automatically sync to Obsidian vault:

```
Agent_Knowladges/OSINT/OSINT-Agent/
├── 02 - Literature Research/    ← Sub-agent results (auto)
├── 04 - Research Reports/       ← generate_report (auto)
├── 06 - Daily/                  ← obsidian_daily
├── 07 - Notlar/                 ← Free-form notes
└── 08 - Profiller/              ← Person profiles ([[username]] wikilink)
```

Tools: `obsidian_write`, `obsidian_read`, `obsidian_search`, `obsidian_daily`, `obsidian_write_profile`

---

## Tool Reference

<details>
<summary><strong>Identity Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `run_sherlock` | Username scan across 400+ platforms |
| `run_maigret` | Advanced username search with account detection |
| `run_github_osint` | GitHub profile, GPG key, following analysis (deep mode) |
| `check_email_registrations` | Email platform registrations via Holehe |
| `check_breaches` | Data breach check via HIBP |
| `cross_reference` | Email/username pivot connections |
| `verify_profiles` | Live verification of found profiles |
| `search_person` | Person search by name + organization |
| `parse_gpg_key` | Extract hidden emails from GitHub GPG keys |
| `auto_visual_intel` | Automatic visual intelligence pipeline (avatar → face analysis → reverse search) |

</details>

<details>
<summary><strong>Media Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `reverse_image_search` | Google Lens / SerpApi reverse image search |
| `compare_images_phash` | Image similarity via perceptual hash |
| `extract_metadata` | URL/file EXIF and metadata extraction |
| `wayback_search` | Wayback Machine archive search |
| `nitter_profile` | Twitter/X profile info (Scrapling stealth) |
| `fact_check_to_graph` | Save claim verification result to graph |

</details>

<details>
<summary><strong>Academic Tools</strong></summary>

| Tool | Description |
|------|-------------|
| `search_academic_papers` | arXiv + Semantic Scholar paper search |
| `search_researcher_papers` | Researcher profile + publication list |
| `check_plagiarism` | Plagiarism detection via CrossRef/web |

</details>

<details>
<summary><strong>Search & Verification</strong></summary>

| Tool | Description |
|------|-------------|
| `search_web` | SearXNG → Brave → Google CSE → Tavily chain |
| `search_web_multi` | 3 parallel queries, URL dedup, max 30 results |
| `verify_claim` | Multi-source claim verification + Reddit community analysis |
| `scrape_profile` | Firecrawl → Puppeteer stealth → Scrapling chain |
| `web_fetch` | Page content fetching (academic URLs 50K char limit) |

</details>

<details>
<summary><strong>Graph & Database</strong></summary>

| Tool | Description |
|------|-------------|
| `query_graph` | Neo4j connection query |
| `list_graph_nodes` | Node list (with label filter) |
| `graph_stats` | Total node/relationship statistics |
| `save_finding` | Write verified finding to graph |
| `save_ioc` | Save cyber threat indicator |
| `link_entities` | Create relationship between two nodes |
| `mark_false_positive` | Label with ML tag (for GNN training) |
| `remove_false_positive` | Permanently delete noise nodes |
| `add_custom_node` | Add custom node (CryptoWallet, Malware, etc.) |
| `add_custom_relationship` | Add custom relationship (OWNS, DISTRIBUTES, etc.) |

</details>

<details>
<summary><strong>Report & Obsidian</strong></summary>

| Tool | Description |
|------|-------------|
| `generate_report` | Create Markdown report + Obsidian sync |
| `obsidian_write` | Write note to vault |
| `obsidian_append` | Extend existing note |
| `obsidian_read` | Read note |
| `obsidian_daily` | Update daily journal |
| `obsidian_write_profile` | Create person profile ([[wikilink]]) |
| `obsidian_list` | List directory contents |
| `obsidian_search` | Full-text search |

</details>

---

## CLI Reference

```bash
osint                       # Interactive REPL
osint "query"               # Single query mode
osint --setup               # Setup wizard
osint --uninstall           # Uninstall wizard
osint --graph               # Graph visualization (port 3333)
osint --version             # Version
osint --help                # Help
```

---

## Security

| Protection | Details |
|------------|---------|
| SSRF protection | localhost, 192.168.x, 10.x, 172.16-31.x blocked |
| Neo4j injection | All Cypher queries parameterized |
| Graph deletion | `NEO4J_ALLOW_CLEAR=1` + `isSafeClearTarget()` (localhost only) |
| Holehe injection | Email regex validation, no raw input to subprocess |
| API key protection | .env in gitignore, masked in logs |
| Login wall detection | Pages behind login/signup walls are flagged |

---

## Tests

```bash
npm test                              # Unit tests (64 tests)
npm run test:tools                    # Tool tests
npm run test:graph:local              # Neo4j integration (requires Docker)
```

---

## Project Structure

```
src/
├── agents/
│   ├── supervisorAgent.ts            # Coordinator agent
│   ├── identityAgent.ts              # Identity investigation
│   ├── mediaAgent.ts                 # Media verification
│   ├── academicAgent.ts              # Academic research
│   ├── strategyAgent.ts              # Plan/review/synthesize
│   ├── baseAgent.ts                  # Shared agent loop
│   └── types.ts                      # AgentConfig, Message, AgentResult
├── lib/
│   ├── toolRegistry.ts               # 35+ tool central dispatcher
│   ├── neo4j.ts                      # Graph database operations
│   ├── chatHistory.ts                # Session management
│   ├── sourceCredibility.ts          # Source labeling + Reddit analysis
│   ├── pivotAnalyzer.ts              # Pivot suggestions
│   ├── osintHeuristics.ts            # Username/email validation
│   └── logger.ts                     # Colored log system
├── tools/
│   ├── searchTool.ts                 # SearXNG → Brave → Google → Tavily
│   ├── scrapeTool.ts                 # Firecrawl → Puppeteer → Scrapling
│   ├── autoVisualIntel.ts            # Automated visual intelligence pipeline
│   ├── verifyClaimTool.ts            # Multi-source claim verification
│   ├── academicSearchTool.ts         # arXiv + Semantic Scholar + rate limiting
│   ├── setupCommand.ts               # Setup + uninstall wizard
│   ├── githubTool.ts, sherlockTool.ts, holeheTool.ts, ...
│   └── obsidianTool.ts               # Obsidian vault integration
├── cli.ts                            # Global CLI entry point (osint command)
├── chat.ts                           # Interactive REPL (session system)
└── graphServer.ts                    # Graph UI server
```

---

## Docker Services

```bash
docker compose up -d        # Start all services (SearXNG + Firecrawl + Neo4j + DeepFace)
docker compose up -d searxng  # Start only SearXNG
docker compose down          # Stop all services
docker compose logs -f       # View logs
```

| Service | Port | Description |
|---------|------|-------------|
| SearXNG | 8888 | Metasearch engine, JSON API at `/search?q=...&format=json` |
| Firecrawl | 3002 | Web scraper, REST API at `/v1/scrape` |
| Neo4j | 7687 | Graph database |
| DeepFace | 5000 | Face analysis and verification API |

---

## npm Publishing

```bash
npm run build
npm pack --dry-run          # Check package contents
npm publish --access public # First publish

# Updates
npm version patch           # 1.0.0 → 1.0.1
npm publish
```

---

## License

MIT — See [LICENSE](LICENSE) for details.

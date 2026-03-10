# OSINT Agent (Dijital Müfettiş)

## Project Overview
OSINT Agent is a command-line interface (CLI) application built with Node.js and TypeScript. It functions as an intelligent Open Source Intelligence (OSINT) assistant, leveraging Genkit and LLMs (via OpenRouter, primarily targeting `qwen/qwen3.5-flash-02-23`) to conduct automated investigations. The agent orchestrates various external tools to gather information about usernames, emails, and files, and maps the relationships between these entities into a Neo4j graph database.

## Architecture & Technologies
- **Language:** TypeScript / Node.js
- **AI Framework:** Genkit (for flows) & OpenAI SDK (via OpenRouter for chat completion)
- **Database:** Neo4j (used to store and query the investigation graph, e.g., Username -> USES_EMAIL -> Email -> REGISTERED_ON -> Platform)
- **Core Strategy:** The agent follows a "Pivot" strategy (e.g., finding an email from a username, then checking where that email is registered or if it has been breached).

## Key Tools & Capabilities
The agent utilizes several specialized tools to gather intelligence:
- **Sherlock (`run_sherlock`):** Searches for usernames across 400+ social platforms (requires a local Python installation of Sherlock).
- **GitHub OSINT (`run_github_osint`, `parse_gpg_key`):** Extracts profiles, emails, and hidden metadata from GitHub accounts and GPG keys.
- **Email Pivoting (`check_email_registrations`, `check_breaches`):** Uses Holehe to find platforms an email is registered on, and checks data breaches (HIBP or local DB).
- **Web & Metadata (`extract_metadata`, `wayback_search`, `web_fetch`):** Extracts EXIF/XMP data from files, searches the Wayback Machine, and fetches web page content.
- **Graph Management:** Tools to query connections, list nodes, and get stats from the Neo4j graph.

## Building and Running
The project uses `npm` for dependency management and scripts. Ensure `Neo4j` is running and environment variables (like `OPENROUTER_API_KEY`) are set in `.env`.

- **Start CLI Chat Interface:**
  ```bash
  npm run chat
  ```
- **Start Genkit Developer UI:**
  ```bash
  npm run dev
  ```
- **Build the Project:**
  ```bash
  npm run build
  ```

## Testing
The project includes Unit, Integration, and End-to-End (E2E) tests. Unit tests mock external dependencies, while integration tests require a local Neo4j Docker container.

- **Run Unit Tests (Fast):**
  ```bash
  npm run test
  # or
  npm run test:unit
  ```
- **Run Tool-Specific Tests:**
  ```bash
  npm run test:tools
  ```
- **Run Graph Integration Tests (Requires Neo4j):**
  ```bash
  npm run test:graph:local
  ```
- **Clear Graph Database:**
  ```bash
  npm run db:clear
  ```

## Development Conventions
- **Tool Creation:** New tools are added in the `src/tools/` directory and must have corresponding `.test.ts` files. External calls (like `fetch` or `spawn`) should be mocked in unit tests.
- **Graph Integration:** Information gathered by tools should be written to the Neo4j graph to establish relationships and enable pivoting (refer to `src/lib/neo4j.ts`).
- **AI Integration:** The main conversational logic is handled in `src/chat.ts`, which defines the tools available to the LLM and the system prompt guiding the investigation strategy. Genkit flows are located in `src/flows/`.

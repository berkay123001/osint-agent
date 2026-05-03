import { addCustomNodeTool, deleteCustomNodeTool, addCustomRelationshipTool } from '../tools/customGraphTool.js';
import 'dotenv/config'
import OpenAI from 'openai'
import * as readline from 'readline'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { logger } from './logger.js'
import { githubOsint } from '../tools/githubTool.js'
import { writeOsintToGraph, getConnections, getGraphStats, getGraphNodeCountsByLabel, listGraphNodes, pruneMisclassifiedFullNameUsernames, findLinkedIdentifiers, writeEmailRegistrations, writeBreachData, writeFollowingConnections, mergeRelation, closeNeo4j, clearGraph, deleteGraphNodeAndRelations, writeFinding, writeCybersecurityNode, linkEntities, markNodeMlLabel, batchWriteFindings } from './neo4j.js'
import { normalizeAssistantMessage, normalizeToolContent, sanitizeHistoryForProvider } from './chatHistory.js'
import { isLikelyUsernameCandidate } from './osintHeuristics.js'
import { extractMetadataFromUrl, extractMetadataFromFile, formatMetadata } from '../tools/metadataTool.js'
import { parseGithubGpgKey, parseGpgKeyFile, formatGpgResult } from '../tools/gpgParserTool.js'
import { waybackSearch, formatWaybackResult } from '../tools/waybackTool.js'
import { webFetch } from '../tools/webFetchTool.js'
import { checkEmailRegistrations, formatHoleheResult } from '../tools/holeheTool.js'
import { checkBreaches, formatBreachResult } from '../tools/breachCheckTool.js'
import { searchWeb, searchWebMulti, formatSearchResult } from '../tools/searchTool.js'
import { scrapeProfile, formatScrapeResult } from '../tools/scrapeTool.js'
import { formatSourceBadge } from './sourceCredibility.js'
import { verifyClaim, formatVerifyResult } from '../tools/verifyClaimTool.js'
import { verifySherlockProfiles, formatVerificationResults } from '../tools/profileVerifier.js'
import { fetchAndHashImage } from '../tools/imageHasher.js'
import { fetchNitterProfile, formatNitterResult } from '../tools/nitterTool.js'
import { findUnexploredPivots, formatUnexploredPivots } from './pivotAnalyzer.js'
import { compareImages } from '../tools/phashCompareTool.js';
import { writeFactCheckToGraph } from './neo4jFactCheck.js';
import { searchReverseImage, formatReverseImageResult } from '../tools/reverseImageTool.js';
import { autoVisualIntel } from '../tools/autoVisualIntel.js';
import { searchPerson, formatPersonSearchResult } from '../tools/personSearchTool.js'
import { searchAcademicPapers, formatAcademicResult, writeAcademicPapersToGraph, searchAuthorPapers, formatAuthorResult } from '../tools/academicSearchTool.js'
import type { AcademicSearchResult } from '../tools/academicSearchTool.js'
import { generateOsintReport } from '../tools/reportTool.js'
import { checkPlagiarism } from '../tools/plagiarismTool.js'
import { analyzeGpxFiles, formatGpxResult } from '../tools/gpxAnalyzerTool.js'
import { runMaigret, formatMaigretResult } from '../tools/maigretTool.js'
import { computeGraphConfidence, fetchGraphEvidence } from './graphConfidence.js'
import { obsidianWrite, obsidianAppend, obsidianRead, obsidianDailyLog, obsidianList, obsidianSearch, obsidianWriteProfile } from '../tools/obsidianTool.js'
import os from 'os'
import { writeFile, unlink } from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PYTHON = process.env.PYTHON_PATH || 'python3'

// ─── Report Content Buffer ────────────────────────────────────────────────────
// Supervisor sub-agent reports are written here. generate_report uses this buffer
// when additionalFindings is not provided (fallback when model can't JSON encode).
let _reportContentBuffer: string = '';
export function setReportContentBuffer(content: string): void { _reportContentBuffer = content; }
export function clearReportContentBuffer(): void { _reportContentBuffer = ''; }

// ─── Tool Definitions ────────────────────────────────────────────────
export const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_custom_node",
      description: "Adds a custom node to the Neo4j graph database. Used for saving findings outside standard objects (Username, Email, etc.), e.g. CryptoWallet, Malware. Use CamelCase for labels.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Node type (e.g. CryptoWallet, Malware)" },
          properties: { 
            type: "object", 
            additionalProperties: { type: "string" },
            description: "Node properties. Key-value (string:string) format."
          }
        },
        required: ["label", "properties"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_custom_node",
      description: "Deletes an erroneously added node from the graph database by ID or property.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Label of the node to delete. (e.g. CryptoWallet)" },
          matchKey: { type: "string", description: "Search key. (e.g. address)" },
          matchValue: { type: "string", description: "Search value. (e.g. 0x123...)" }
        },
        required: ["label", "matchKey", "matchValue"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_custom_relationship",
      description: "Adds a custom relationship (e.g. OWNS, DISTRIBUTES) between two objects in the graph database.",
      parameters: {
        type: "object",
        properties: {
          sourceLabel: { type: "string", description: "Source label (e.g. Username)" },
          sourceKey: { type: "string", description: "Source search key (e.g. value)" },
          sourceValue: { type: "string", description: "Source value (e.g. wgodbarrelv4)" },
          targetLabel: { type: "string", description: "Target label (e.g. Malware)" },
          targetKey: { type: "string", description: "Target search key (e.g. name)" },
          targetValue: { type: "string", description: "Target search value (e.g. Vidar)" },
          relationshipType: { type: "string", description: "Relationship type in UPPERCASE (e.g. DISTRIBUTES)" }
        },
        required: ["sourceLabel", "sourceKey", "sourceValue", "targetLabel", "targetKey", "targetValue", "relationshipType"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fact_check_to_graph",
      description: "Saves a Fact-Check result for a suspicious claim to the Neo4j database. Links the source, image, and claim together.",
      parameters: {
        type: "object",
        properties: {
          claimId: { type: "string" },
          claimText: { type: "string" },
          source: { type: "string" },
          claimDate: { type: "string" },
          verdict: { type: "string", enum: ["FALSE", "TRUE", "UNVERIFIED"] },
          truthExplanation: { type: "string" },
          imageUrl: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["claimId", "claimText", "source", "claimDate", "verdict", "truthExplanation"]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_finding',
      description: 'Writes a significant finding discovered during investigation to the Neo4j graph. Use only for verified or high-confidence findings — do not save speculative results.',
      parameters: {
        type: 'object',
        properties: {
          subject_label: { type: 'string', description: 'Subject node type (Username, Email, Person, Website, etc.)' },
          subject_value: { type: 'string', description: 'Subject node value' },
          finding_type: {
            type: 'string',
            enum: ['identity', 'location', 'affiliation', 'alias', 'association'],
            description: 'Finding category'
          },
          target_label: { type: 'string', description: 'Target node type' },
          target_value: { type: 'string', description: 'Target node value' },
          relation: { type: 'string', description: 'Relationship type (USES_EMAIL, LOCATED_IN, WORKS_AT, ALIAS_OF, ASSOCIATED_WITH, etc.)' },
          confidence: {
            type: 'string',
            enum: ['verified', 'high', 'medium', 'low'],
            description: 'Confidence level'
          },
          confidence_score: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: '⚠️ REQUIRED. C_v numeric confidence score (0–1). MUST be calculated before calling this tool. Formula: C_v = 0.25·C_source + 0.20·C_corroboration + 0.20·C_diversity - 0.20·P_contradiction - 0.15·P_falsePositive. Omitting this field will cause the call to be rejected.'
          },
          evidence: { type: 'string', description: 'Evidence for the finding (source URL or description)' },
        },
        required: ['subject_label', 'subject_value', 'finding_type', 'target_label', 'target_value', 'relation', 'confidence_score'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_save_findings',
      description: 'Writes multiple OSINT findings to the Neo4j graph in a single batch. Use instead of save_finding when there are 5+ findings — much more efficient (single API call). Maximum 30 findings. Each finding uses the subject→relation→target structure.',
      parameters: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            description: 'List of findings. Each element corresponds to a save_finding call.',
            items: {
              type: 'object',
              properties: {
                subject_label: { type: 'string', description: 'Subject node type (Username, Email, Person, Website, etc.)' },
                subject_value: { type: 'string', description: 'Subject node value' },
                target_label: { type: 'string', description: 'Target node type' },
                target_value: { type: 'string', description: 'Target node value' },
                relation: { type: 'string', description: 'Relationship type (USES_EMAIL, LOCATED_IN, WORKS_AT, etc.)' },
                confidence: { type: 'string', enum: ['verified', 'high', 'medium', 'low'], description: 'Confidence level' },
                confidence_score: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: '⚠️ REQUIRED. C_v numeric confidence score (0–1). MUST be calculated before including this finding. Formula: C_v = 0.25·C_source + 0.20·C_corroboration + 0.20·C_diversity - 0.20·P_contradiction - 0.15·P_falsePositive.'
                },
                evidence: { type: 'string', description: 'Short evidence note (max 200 characters)' },
              },
              required: ['subject_label', 'subject_value', 'target_label', 'target_value', 'relation', 'confidence_score'],
            },
            maxItems: 30,
          },
        },
        required: ['findings'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_ioc',
      description: 'Writes a cybersecurity threat indicator (IOC), threat actor, or research source to the Neo4j graph. Supports ThreatActor, C2Server, Malware, Campaign, IOC, PhishingDomain, Tool, Framework types. WARNING: For academic frameworks/tools (BloodHound, OpenCTI, THREATKG, etc.) use Tool or Framework — NOT Campaign.',
      parameters: {
        type: 'object',
        properties: {
          node_type: {
            type: 'string',
            description: 'Node type: ThreatActor | C2Server | Malware | Campaign | IOC | PhishingDomain | Tool | Framework'
          },
          value: { type: 'string', description: 'Node value (domain, IP, hash, name, etc.)' },
          properties: {
            type: 'object',
            description: 'Additional properties (category, tlp, description, firstSeen, etc.) — key-value pairs',
            additionalProperties: { type: 'string' }
          },
          linked_label: { type: 'string', description: 'Existing node type to link to (optional)' },
          linked_value: { type: 'string', description: 'Existing node value to link to (optional)' },
          linked_relation: { type: 'string', description: 'Relationship type (optional, e.g.: USES_C2, PART_OF_CAMPAIGN)' },
        },
        required: ['node_type', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_entities',
      description: 'Links two existing (or to-be-created) nodes in the graph. Use for general relationships like SAME_AS, ALIAS_OF, ASSOCIATED_WITH.',
      parameters: {
        type: 'object',
        properties: {
          from_label: { type: 'string', description: 'Source node type' },
          from_value: { type: 'string', description: 'Source node value' },
          to_label: { type: 'string', description: 'Target node type' },
          to_value: { type: 'string', description: 'Target node value' },
          relation: { type: 'string', description: 'Relationship type (SAME_AS, ALIAS_OF, ASSOCIATED_WITH, etc.)' },
          evidence: { type: 'string', description: 'Evidence for the relationship (optional)' },
          confidence: {
            type: 'string',
            enum: ['verified', 'high', 'medium', 'low'],
            description: 'Confidence level (optional)'
          },
        },
        required: ['from_label', 'from_value', 'to_label', 'to_value', 'relation'],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reverse_image_search",
      description: "Finds where and when an image was first shared on the internet (via Google Lens / SerpApi). Use to reveal the true source of misinformation or out-of-context photos (e.g., old earthquake photos).",
      parameters: {
        type: "object",
        properties: {
          imageUrl: { type: "string", description: "Full URL of the image to search" }
        },
        required: ["imageUrl"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "compare_images_phash",
      description: "Compares two images using perceptual hash (pHash) to measure visual similarity. Analyzes whether an image from a news article is the same as a photo in a different context.",
      parameters: {
        type: "object",
        properties: {
          url1: { type: "string", description: "Full URL of the first image" },
          url2: { type: "string", description: "Full URL of the second image to compare" }
        },
        required: ["url1", "url2"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "auto_visual_intel",
      description: "Automatically generates visual intelligence from profile URLs. Scrapes profile pages, finds avatar/profile photos, performs reverse image search (Google Lens), and runs pHash comparison across multiple platforms. No manual image upload needed — provide URLs and the rest is automatic.",
      parameters: {
        type: "object",
        properties: {
          profile_urls: {
            type: "string",
            description: "Comma-separated profile URLs. Example: 'https://kick.com/bbeckyg, https://tiktok.com/@bbeckyg3, https://instagram.com/bbeckyg01'"
          }
        },
        required: ["profile_urls"]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clear_graph',
      description:
        'Permanently deletes all nodes and relationships in the Neo4j graph database. Only use when the user explicitly requests database cleanup/deletion.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Set to true to confirm the deletion' },
        },
        required: ['confirm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_academic_papers',
      description: 'Searches academic papers via arXiv + Semantic Scholar. Supports DOI/venue-backed peer-reviewed filtering and automatically saves results to the Neo4j graph database (Paper→Author, Paper→Topic).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Research query (e.g. "reinforcement learning large language models 2024")' },
          maxResults: { type: 'string', description: 'How many papers to fetch? (default: 10, max: 50)' },
          sortBy: { type: 'string', description: '"submittedDate" (newest) or "relevance" (most relevant). Default: submittedDate.' },
          peerReviewedOnly: { type: 'boolean', description: 'When true, prioritize DOI/venue-backed likely peer-reviewed papers and suppress arXiv-only preprints when possible.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_researcher_papers',
      description: 'Fetches all publications, h-index, and citation counts for a researcher via the Semantic Scholar Author API. Works with a name + affiliation combination. Also ideal for researchers not on arXiv.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Researcher full name (e.g. "Bihter Das")' },
          affiliation: { type: 'string', description: 'Institution name — used to select the correct person (e.g. "Firat University")' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_false_positive',
      description: 'PERMANENTLY deletes a graph node and its relationships that was incorrectly added or does not match the target. ⚠️ If you want to keep it as a negative example for GNN training, use mark_false_positive instead.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Type/label of the node to delete (e.g. Username, Email, Person, Profile)' },
          value: { type: 'string', description: 'Specific value of the node to delete (e.g. target@gmail.com, targetUsername)' },
        },
        required: ['label', 'value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_false_positive',
      description: 'Labels a graph node for GNN training without deleting it (soft label). false_positive → kept as a negative training example; verified → confirmed positive; uncertain → exclude from training set. Unlike remove_false_positive, the node is not deleted.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Node type (e.g. Username, Email, Profile)' },
          value: { type: 'string', description: 'Node value' },
          ml_label: {
            type: 'string',
            enum: ['false_positive', 'verified', 'uncertain'],
            description: 'false_positive: this account is unrelated to the target; verified: confirmed target; uncertain: ambiguous'
          },
          reason: { type: 'string', description: 'Reason for the label (optional, e.g. "ZTE developer, not Linus")' },
        },
        required: ['label', 'value', 'ml_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Performs a web search using SearXNG (self-hosted, preferred), Brave Search, or Tavily AI (fallback). Use for name, email, dork (site:example.com), institution lookups, etc. DO NOT DIRECTLY ACCEPT RESULTS: Cross-check whether results overlap with the target\'s other known identifiers (email, username, etc.).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "sakurasnowangel83" or site:pastebin.com "target@mail.com")' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web_multi',
      description:
        'Runs multiple queries IN PARALLEL to search the same topic from different angles and returns URL-deduplicated results. Maximum 3 queries (comma-separated). Example: "gamma app free plan, gamma presentation no signup, gamma.app pricing 2025"',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'string',
            description: 'Comma-separated search queries (max 3). E.g. "free AI presentation, AI slides no signup, gamma app free"',
          },
        },
        required: ['queries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_claim',
      description:
        'Checks whether a claim ("free", "no signup required", "Turkey based", etc.) can be verified against multiple independent sources. If the vendor site does not explicitly state the claim, it searches community sources. Confidence: high=2+ independent sources, medium=1, low=vendor only, inconclusive=no evidence.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Main URL of the product/service to test the claim against' },
          claim: { type: 'string', description: 'Claim text to verify (e.g. "has a free tier, no credit card required")' },
        },
        required: ['url', 'claim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sherlock',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'The username or nickname to search' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_maigret',
      description: 'Search for a username across 3000+ platforms using Maigret. Complements Sherlock — uses different detection methods and covers more platforms (Pinterest, Discord, Facebook, Instagram, etc.). Slower than Sherlock but broader coverage. Use after run_sherlock for deeper username investigation.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Username to search for' },
          top_sites: { type: 'number', description: 'Number of top sites to check (default: 500, max ~3000). Use 500 for normal, 1500 for deep searches.' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_github_osint',
      description:
        'Extract emails, real name, company, location, bio, blog, GPG/SSH keys from a GitHub username using the official GitHub API. Use when investigating a GitHub user. Set deep=true for DEEP MODE: fetches all following accounts, filters out public figures (>500 followers), and maps real connections with their bios and locations — great for finding social circles and shared context (same university, same city).',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub username to investigate' },
          deep: { type: 'string', enum: ['true', 'false'], description: 'Set to true for deep mode: fetches following list, filters real people by follower count, reads their bios. Slower but reveals social connections.' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_graph_confidence',
      description:
        'Compute the graph-aware confidence score (Cv) for a node already in the investigation graph. Returns a numeric score [0–1], confidence level (verified/high/medium/low), and a breakdown: source quality, corroboration count, source diversity, contradiction penalty, false-positive penalty. Use after save_finding or when assessing how well-supported an entity is.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Node label to query (Username, Email, Person, Website, etc.)' },
          value: { type: 'string', description: 'Node value to query (e.g. "torvalds", "user@example.com")' },
        },
        required: ['label', 'value'],
      },
    },
  },  {
    type: 'function',
    function: {
      name: 'query_graph',
      description:
        'Query the investigation graph (Neo4j) to see all connections for a given username, email, or entity. Use when the user asks about relationships, connections, or the graph.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'The username, email, or entity to query connections for' },
        },
        required: ['value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_stats',
      description:
        'Get overall statistics of the investigation graph (total nodes and relationships). Use when the user asks how much data is in the graph.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_graph_nodes',
      description:
        'List nodes currently stored in the investigation graph, optionally filtered by label such as Username, Email, Person, Platform, or Profile. Use when the user asks what the nodes actually are.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional node label filter like Username, Email, Person, Platform, Profile' },
          limit: { type: 'string', description: 'Optional max number of nodes to list, default 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cross_reference',
      description:
        'Get all verified identifiers (emails, handles, websites) linked to a known username in the graph. Use this BEFORE searching for a real name to find pivot points. Returns the trust chain so you can search by verified email or handle instead of a common name.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'The seed username whose linked identifiers to retrieve' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_metadata',
      description:
        'Extract EXIF/XMP/IPTC metadata from a file URL (image, SVG, PDF, etc.). Reveals hidden info like author name, GPS coordinates, camera model, software, export filename. Use when investigating a file or image for hidden clues.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL of the file to analyze for metadata' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_gpg_key',
      description:
        'Download and parse a GitHub user\'s GPG public key to extract hidden email addresses and real names. Very effective when commit emails are masked with noreply@github.com. Use when investigating a GitHub user\'s identity.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'GitHub username whose GPG key to analyze' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wayback_search',
      description:
        'Search the Wayback Machine (archive.org) for archived/cached versions of a URL. Finds deleted profiles, old tweets, changed bios, removed content. Use when investigating deleted or modified online content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to search in Wayback Machine archives' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Download and read content from a URL (web pages, text files, JSON, etc.). Works best with open/public pages. NOTE: Google Scholar, ResearchGate, Academia.edu, and most university portal search pages block automated access (403). Do NOT try these. Instead prefer: ORCID (orcid.org/search), GitHub profiles, personal blog/portfolio pages, public API endpoints, news articles, and LinkedIn public pages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch content from' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_email_registrations',
      description:
        'Check which online platforms/services an email address is registered on (Holehe). This is the key PIVOT tool: use a discovered email to find linked accounts on Amazon, Spotify, Gravatar, WordPress, Adobe, etc. Results are written to the graph as Email→REGISTERED_ON→Platform.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address to check across platforms' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_breaches',
      description:
        'Check if an email address appears in known data breaches (Have I Been Pwned / local DB). Returns which breaches, what data was exposed (passwords, phone numbers, etc.), and breach dates. This is the LEAK DETECTION tool: finding an email in a breach can reveal linked accounts, old passwords, and hidden identities.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address to check for data breaches' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scrape_profile',
      description:
        'Scrape a webpage using Firecrawl (self-hosted or cloud). Works well on: GitHub, personal blogs, forums, CTF writeup sites, portfolio pages. Returns page as Markdown and auto-extracts emails, crypto wallets (BTC/ETH), Telegram links, and external URLs. NOTE: Twitter/X and Reddit are NOT supported by Firecrawl — use web_fetch for those (will auto-fallback to Puppeteer/Scrapling).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the profile/page to scrape (e.g. https://twitter.com/username, https://tiktok.com/@user)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_profiles',
      description:
        'Cross-verify Sherlock results: scrapes found profile URLs with Firecrawl to check whether the profile belongs to the target. Compares known email, real name, location, and blog against page content. If matched, confidence rises to "high". Use AFTER running Sherlock — first gather known information via GitHub OSINT.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Username being investigated (known identifiers are pulled from the graph)' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nitter_profile',
      description:
        'Read a Twitter/X profile via Nitter. Nitter is used because Firecrawl and web_fetch return 403 on Twitter. Fetches bio, location, website, join date, tweet/follower counts, and recent tweets. Free, no API key required.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Twitter/X username (without @)' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unexplored_pivots',
      description:
        'Find nodes and opportunities in the graph that have not yet been pivoted on (investigated). For example: an email was found but check_email_registrations was not run, or a website exists but was not scraped. Helps the agent automatically determine the "next most productive step".',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Root username for the investigation' },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_person',
      description:
        'Start an investigation using a real name. Performs a reverse lookup in the graph (Person node → Username/Email), derives possible usernames, and searches the web. IMPORTANT: False positive risk is high for common names — provide extra context (city, institution, profession). Running Sherlock with a full name also produces false results — find the username with this tool first, then use Sherlock.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Real name of the person being investigated (e.g. "John Doe")' },
          context: { type: 'string', description: 'Optional context: profession, city, institution (e.g. "Istanbul software developer")' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_plagiarism',
      description:
        'Performs plagiarism/authorship analysis and/or originality assessment on an academic text, paper section, or abstract.\n\nmode options:\n- "plagiarism" (default): Text copy detection — Jaccard similarity, CrossRef/Semantic Scholar comparison, web exact-phrase search.\n- "originality": Originality evaluation — temporal precedence (prior art), conceptual novelty (TF-IDF), journal credibility (DOAJ/predatory check), citation pattern analysis.\n- "full": Plagiarism + originality together.\n\nFindings are saved to Neo4j as (:Publication)-[:SIMILAR_TO {score}]->(:Publication). Use for questions like "Is this paper plagiarized?", "Is this paper original?", "Is this journal trustworthy?", "Is this author self-plagiarizing?".',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to analyze (abstract, paper section, or full text)' },
          mode: { type: 'string', enum: ['plagiarism', 'originality', 'full'], description: 'Analysis mode. Default: "plagiarism". Use "originality" for originality check, "full" for both.' },
          author: { type: 'string', description: 'Author full name — for self-plagiarism detection (optional)' },
          title: { type: 'string', description: 'Paper title — for CrossRef metadata lookup (optional)' },
          doi: { type: 'string', description: 'Paper DOI — for metadata lookup (optional, e.g. "10.1016/j.jss.2023.111234")' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_report',
      description:
        'Saves all findings as a structured Markdown report file after an investigation is complete.\n\n🟣 OBSIDIAN SYNC: Every time this tool runs the report is AUTOMATICALLY copied to the Obsidian vault:\n→ $OBSIDIAN_VAULT/04 - Research Reports/\nThis is an active code-level integration (syncToObsidian). The report will be ready when the user opens their Obsidian vault.\n\nreportType options:\n- "osint" (default): Person/username investigation — pulls profile/email/breach/platform data from the Neo4j graph.\n- "academic": Paper/topic research — use after AcademicAgent finishes.\n- "factcheck": News/image verification — use after MediaAgent finishes.\n\nCall IMMEDIATELY when the user says "generate report" / "give report" / "save", or when a sub-agent completes.\n⚠️ Send ONLY subject and reportType — content is read automatically from the internal buffer, do NOT send additionalFindings.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'The subject, person, or entity being investigated (username, paper topic, claim text, etc.)' },
          reportType: { type: 'string', enum: ['osint', 'academic', 'factcheck'], description: 'Report type. Use "academic" for paper/academic research, "factcheck" for image/news verification, "osint" for person investigation (default).' },
          title: { type: 'string', description: 'Optional report title' },
        },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_gpx',
      description:
        'Analyze GPS track files (GPX format) for OSINT investigations. Parses tracks, calculates geographic center, identifies repeated locations (hotspots), and reverse-geocodes coordinates to identify landmarks, cities, and addresses. Use for fitness tracker data (Strava, Garmin), GPS route forensics, and location pattern analysis. Returns: track names, timestamps, coordinate center, hotspot locations with addresses, and landmark identification.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description: 'Comma-separated list of GPX file paths to analyze (absolute or relative paths)',
          },
        },
        required: ['files'],
      },
    },
  },
  // ─── Obsidian Vault Tools ─────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'obsidian_write',
      description: 'Create or update a note in the Obsidian vault. Opens a record in the agent\'s own knowledge base. Vault root: Agent_Knowladges/OSINT/OSINT-Agent/. Example paths: "07 - Notlar/user-preferences.md", "08 - Profiller/torvalds.md"',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Relative file path from the Vault root (e.g. "07 - Notlar/important-findings.md")' },
          content: { type: 'string', description: 'Full Markdown content of the note' },
          overwrite: { type: 'boolean', description: 'true → overwrite (default), false → only create if it does not exist' },
        },
        required: ['note_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_append',
      description: 'Append content to the end of an existing note in the Obsidian vault. Use for daily log updates, research notes, and important findings.',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Relative file path from the Vault root' },
          content: { type: 'string', description: 'Markdown content to append' },
        },
        required: ['note_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_read',
      description: 'Read a note from the Obsidian vault. Use to recall previous notes, user preferences, or research context.',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Relative file path from the Vault root' },
        },
        required: ['note_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_daily',
      description: 'Add an entry to today\'s daily log (06 - Günlük/YYYY-MM-DD.md). Write important findings, user preferences, observations, and reminders here. Creates the file automatically if it does not exist.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'Text to add to the daily log (Markdown)' },
          tag: { type: 'string', description: 'Optional tag: "research" | "user-pref" | "observation" | "reminder"' },
        },
        required: ['entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_write_profile',
      description: 'Create a structured profile page for the investigated person (08 - Profiller/[username].md). Frontmatter metadata + Markdown summary. Use when a person investigation is complete or significant findings are obtained. Link to other profiles with Obsidian wikilinks [[username]].',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Profile owner username or identifier' },
          content: { type: 'string', description: 'Profile content (Markdown). Sections: ## Identity, ## Platforms, ## Findings, etc.' },
          real_name: { type: 'string', description: 'Real name (if known)' },
          emails: { type: 'string', description: 'Email addresses (comma-separated)' },
          platforms: { type: 'string', description: 'Platforms found on (comma-separated)' },
          confidence: { type: 'string', description: 'Confidence level: verified | high | medium | low', enum: ['verified', 'high', 'medium', 'low'] },
        },
        required: ['username', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_list',
      description: 'List the contents of a directory in the Obsidian vault. Use to explore existing notes or view the vault structure.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Directory to list (relative path). Leave empty to list the vault root.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obsidian_search',
      description: 'Perform full-text search in the Obsidian vault. Scans all .md files and returns matching files with context lines. Use to find previous research, profile notes, or user preferences. Example: "torvalds", "GitHub", "user-pref"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search for (case-insensitive)' },
          limit: { type: 'number', description: 'Maximum number of results (default: 10)' },
        },
        required: ['query'],
      },
    },
  },
]

// ─── Tool Executors ──────────────────────────────────────────────────
function resolveSherlockPath(): string {
  if (process.env.SHERLOCK_BIN && process.env.SHERLOCK_BIN !== 'sherlock') {
    return process.env.SHERLOCK_BIN
  }
  const homeDir = process.env.HOME || os.homedir()
  const candidates = [
    path.join(homeDir, 'anaconda3', 'bin', 'sherlock'),
    path.join(homeDir, 'miniconda3', 'bin', 'sherlock'),
    path.join(homeDir, '.local', 'bin', 'sherlock'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  try {
    const which = execSync('which sherlock 2>/dev/null', { encoding: 'utf-8' }).trim()
    if (which) return which
  } catch { /* not in PATH */ }
  return 'sherlock'
}

async function runSherlock(username: string): Promise<string> {
  if (!isLikelyUsernameCandidate(username)) {
    return `Sherlock is only suitable for username/handle searches. "${username}" contains a space; this looks like a real name and may produce false positives.`
  }

  const SHERLOCK_BIN = resolveSherlockPath()
  return new Promise((resolve) => {
    logger.info('TOOL', `🌐 Scanning Sherlock for ${username}...`)
    logger.info('TOOL', '(This may take 1-2 minutes)')
    const proc = spawn(
      SHERLOCK_BIN,
      [
        username,
        '--print-found',
        '--timeout', '10',
      ],
      { timeout: 180000 }
    )
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', () => {})
    proc.on('close', async () => {
      const lines = out.split('\n').filter((l) => l.startsWith('[+'))
      logger.info('TOOL', `✅ Sherlock: ${lines.length} platforms found`)

      // Write to graph
      try {
        const platforms = lines.map((l) => {
          const urlMatch = l.match(/https?:\/\/[^\s]+/)
          const nameMatch = l.match(/\[\+\]\s+([^:]+):/)
          return { platform: nameMatch?.[1]?.trim() || 'unknown', url: urlMatch?.[0] || '' }
        }).filter(p => p.url)
        const stats = await writeOsintToGraph(username, { platforms }, 'sherlock')
        logger.info('GRAPH', `💾 Written to graph: ${stats.nodesCreated} nodes, ${stats.relsCreated} relationships`)
      } catch (e) {
        logger.warn('GRAPH', '⚠️  Graph write skipped (Neo4j connection may be unavailable)')
      }

      resolve(out || 'No results found.')
    })
    proc.on('error', (e) => resolve(`Sherlock error: ${e.message}`))
  })
}

async function runGithubOsint(username: string, deep = false): Promise<string> {
  logger.info('TOOL', `🐙 GitHub API OSINT: ${username}${deep ? ' (DEEP MODE)' : ''}...`)
  const result = await githubOsint(username, deep)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return result.error
  }
  logger.info('TOOL', `✅ GitHub OSINT: ${result.emails.length} emails found`)

  // Write to graph
  try {
    const profile = result.profile as Record<string, string | null>
    const stats = await writeOsintToGraph(username, {
      emails: result.emails,
      realName: profile.name || undefined,
      location: profile.location || undefined,
      company: profile.company || undefined,
      twitter: profile.twitter_username || undefined,
      blog: profile.blog || undefined,
      avatarUrl: profile.avatar_url || undefined,
      platforms: result.socialAccounts?.map(acc => ({
        platform: acc.provider,
        url: acc.url
      })),
    }, 'github_api')
    logger.info('GRAPH', `💾 Written to graph: ${stats.nodesCreated} nodes, ${stats.relsCreated} relationships`)
  } catch {
    logger.warn('GRAPH', '⚠️  Graph write skipped (Neo4j connection may be unavailable)')
  }

  // Deep mode: write following connections to graph
  if (result.following.length > 0) {
    const realPeople = result.following.filter(f => !f.skipped)
    logger.info('TOOL', `🔍 Following analysis: ${realPeople.length} real people (${result.following.length - realPeople.length} skipped)`)
    try {
      const stats = await writeFollowingConnections(username, result.following, 'github_api')
      logger.info('GRAPH', `💾 Following written to graph: ${stats.nodesCreated} nodes, ${stats.relsCreated} relationships`)
    } catch {
      logger.warn('GRAPH', '⚠️  Following graph write skipped')
    }
  }

  return result.rawSummary
}

  // Session-based caching: prevents repeated calls with the same arguments.
  const toolCache = new Map<string, string>();

  // Tool name alias mapping — handles common model typos
  const TOOL_ALIASES: Record<string, string> = {
    'web_search': 'search_web',
    'search_internet': 'search_web',
    'web_search_multi': 'search_web_multi',
    'search_webpage': 'web_fetch',
    'fetch_url': 'web_fetch',
    'fetch_page': 'web_fetch',
    'reverse_image': 'reverse_image_search',
    'image_reverse_search': 'reverse_image_search',
    'check_plagiarism': 'check_plagiarism',
  };

  export async function executeTool(
    name: string,
    args: Record<string, string>
  ): Promise<string> {
    // Resolve alias — if model called a non-existent tool, try the canonical name
    name = TOOL_ALIASES[name] ?? name;
    const cacheableTools = new Set([
      'run_sherlock', 'run_maigret', 'run_github_osint', 'cross_reference', 'extract_metadata',
      'parse_gpg_key', 'wayback_search', 'web_fetch', 'check_email_registrations',
      'check_breaches', 'search_web', 'search_web_multi', 'scrape_profile', 'verify_profiles',
      'nitter_profile', 'search_person', 'fact_check_to_graph', 'analyze_gpx', 'verify_claim'
    ]);

    const cacheKey = `${name}:${JSON.stringify(args)}`;

    if (cacheableTools.has(name) && toolCache.has(cacheKey)) {
      logger.debug('TOOL', `⚡ [Cache Hit] ${name} (${JSON.stringify(args)}) retrieved from cache. Not re-executed.`);
      return `[⚡ ALREADY FETCHED — This tool was already called with the same parameters. The result below is from cache; no need to call it again — proceed using this data.]\n\n` + toolCache.get(cacheKey)!;
    }

    let result = '';

    if (name === 'run_sherlock') result = await runSherlock(args.username)
    else if (name === 'run_maigret') {
      const maigretResult = await runMaigret(args.username, args.top_sites ? Number(args.top_sites) : 500)
      result = formatMaigretResult(maigretResult)
    }
    else if (name === 'run_github_osint') result = await runGithubOsint(args.username, args.deep === 'true')
    else if (name === 'query_graph') result = await queryGraph(args.value)
    else if (name === 'query_graph_confidence') {
      try {
        const evidence = await fetchGraphEvidence(args.label, args.value)
        const gcResult = computeGraphConfidence(evidence)
        const pct = (gcResult.score * 100).toFixed(1)
        const { cSource, cCorroboration, cDiversity, pContradiction, pFalsePositive } = gcResult.components
        result = [
          `📊 Graph Confidence — ${args.label}:${args.value}`,
          `Score: ${pct}% → ${gcResult.level}`,
          `  source_quality:         ${(cSource * 100).toFixed(1)}%`,
          `  corroboration:          ${(cCorroboration * 100).toFixed(1)}%`,
          `  diversity:              ${(cDiversity * 100).toFixed(1)}%`,
          `  contradiction_penalty:  -${(pContradiction * 100).toFixed(1)}%`,
          `  false_positive_penalty: -${(pFalsePositive * 100).toFixed(1)}%`,
        ].join('\n')
      } catch (e: any) {
        result = `❌ query_graph_confidence error: ${e.message}`
      }
    }
    else if (name === 'graph_stats') result = await graphStats()
    else if (name === 'list_graph_nodes') result = await runListGraphNodes(args.label, args.limit)
    else if (name === 'cross_reference') result = await runCrossReference(args.username)
    else if (name === 'extract_metadata') result = await runExtractMetadata(args.url)
    else if (name === 'parse_gpg_key') result = await runParseGpgKey(args.username)
    else if (name === 'wayback_search') result = await runWaybackSearch(args.url)
    else if (name === 'web_fetch') result = await runWebFetch(args.url)
    else if (name === 'check_email_registrations') result = await runEmailRegistrations(args.email)
    else if (name === 'check_breaches') result = await runBreachCheck(args.email)
    else if (name === 'search_web') result = await runSearchWeb(args.query)
    else if (name === 'search_web_multi') result = await runSearchWebMulti(args.queries)
    else if (name === 'scrape_profile') result = await runScrapeProfile(args.url)
    else if (name === 'verify_profiles') result = await runVerifyProfiles(args.username)
    else if (name === 'verify_claim') result = await runVerifyClaim(args.url, args.claim)
    else if (name === 'nitter_profile') result = await runNitterProfile(args.username)
    else if (name === 'unexplored_pivots') result = await runUnexploredPivots(args.username)
    else if (name === 'search_person') result = await runSearchPerson(args.name, args.context)
    else if (name === 'clear_graph') result = await runClearGraph(args.confirm === 'true' || (args.confirm as unknown) === true)
    else if (name === 'remove_false_positive') result = await runRemoveFalsePositive(args.label, args.value)
    else if (name === 'mark_false_positive') {
      const mlLabel = args.ml_label as 'false_positive' | 'verified' | 'uncertain'
      logger.info('TOOL', `🏷️  ML label: ${args.label}:${args.value} → ${mlLabel}`)
      try {
        const updated = await markNodeMlLabel(args.label, args.value, mlLabel, args.reason)
        if (updated) {
          result = `✅ Node labeled: ${args.label}:${args.value} → mlLabel="${mlLabel}"${args.reason ? ` (${args.reason})` : ''}. Node is retained in graph — will be used as ${mlLabel === 'false_positive' ? 'negative example' : mlLabel === 'verified' ? 'positive example' : 'excluded'} in GNN training.`
        } else {
          result = `⚠️ Node not found: ${args.label}:${args.value} — not present in graph.`
        }
      } catch (e: any) {
        result = `❌ Labeling error: ${e.message}`
      }
    }
        else if (name === 'fact_check_to_graph') {
      logger.info('TOOL', `🧠 Fact Check Record (Neo4j): ${args.claimId}`)
      try {
        // Safely parse tags — model may send a plain comma-separated string or invalid JSON
        let parsedTags: string[] = [];
        if (args.tags) {
          try {
            const parsed = JSON.parse(args.tags);
            parsedTags = Array.isArray(parsed) ? parsed : [String(parsed)];
          } catch {
            // fallback: treat as comma-separated plain string
            parsedTags = String(args.tags).split(',').map((t: string) => t.trim()).filter(Boolean);
          }
        }
        // Sanitize claimId: strip whitespace and trailing commas/garbage
        const claimId = String(args.claimId ?? '').trim().replace(/[,\s]+$/, '') || 'unknown-claim';
        await writeFactCheckToGraph({
           claimId,
           claimText: args.claimText,
           source: args.source,
           claimDate: args.claimDate,
           verdict: args.verdict as 'FALSE' | 'TRUE' | 'UNVERIFIED',
           truthExplanation: args.truthExplanation,
           imageUrl: args.imageUrl,
           tags: parsedTags
        });
        result = `✅ Fact-Check result successfully saved to Neo4j Data Graph! (Claim ID: ${args.claimId})`;
      } catch (e: any) {
        result = `❌ Graph save error: ${e.message}`;
      }
    }
    else if (name === 'analyze_gpx') {
      const files = args.files.split(',').map((f: string) => f.trim()).filter(Boolean)
      logger.info('TOOL', `📍 GPX analysis: ${files.length} files`)
      try {
        const gpxResult = await analyzeGpxFiles(files)
        result = formatGpxResult(gpxResult)
      } catch (e: any) {
        result = `❌ GPX analysis error: ${e.message}`
      }
    }
    else if (name === 'batch_save_findings') {
      const findings = args.findings
      if (!Array.isArray(findings) || findings.length === 0) {
        result = '❌ findings is empty or invalid — at least 1 finding is required.'
      } else {
        logger.info('TOOL', `💾 Batch findings write (Neo4j): ${findings.length} findings`)
        try {
          const stats = await batchWriteFindings(
            findings.map((f: Record<string, unknown>) => ({
              subjectLabel: f.subject_label as string,
              subjectValue: f.subject_value as string,
              targetLabel: f.target_label as string,
              targetValue: f.target_value as string,
              relation: f.relation as string,
              confidence: (f.confidence as any) ?? 'medium',
              confidenceScore: typeof f.confidence_score === 'number' ? f.confidence_score : undefined,
              evidence: f.evidence as string | undefined,
            }))
          )
          const parts = [`✅ ${findings.length} findings written to Neo4j graph in batch. (${stats.nodesCreated} nodes, ${stats.relsCreated} relationships)`]
          if (stats.errors.length > 0) {
            parts.push(`⚠️ ${stats.errors.length} errors: ${stats.errors.join('; ')}`)
          }
          result = parts.join('\n')
        } catch (e: any) {
          result = `❌ Batch graph write error: ${e.message}`
        }
      }
    }
    else if (name === 'save_finding') {
      if (args.confidence_score === undefined || args.confidence_score === null || args.confidence_score === '') {
        result = `❌ save_finding REJECTED: confidence_score is REQUIRED. Calculate C_v = 0.25·C_source + 0.20·C_corroboration + 0.20·C_diversity - 0.20·P_contradiction - 0.15·P_falsePositive before calling this tool, then retry with confidence_score included.`;
      } else {
        logger.info('TOOL', `💾 Saving finding (Neo4j): ${args.subject_label}:${args.subject_value} -[${args.relation}]-> ${args.target_label}:${args.target_value}`)
        try {
          const stats = await writeFinding(args.subject_label, args.subject_value, {
            type: args.finding_type as 'identity' | 'location' | 'affiliation' | 'alias' | 'association',
            targetLabel: args.target_label,
            targetValue: args.target_value,
            relation: args.relation,
            confidence: (args.confidence as any) ?? 'medium',
            confidenceScore: typeof args.confidence_score === 'number' ? args.confidence_score : (parseFloat(args.confidence_score as any) || undefined),
            evidence: args.evidence,
          })
          result = `✅ Finding saved to Neo4j graph. (${stats.nodesCreated} nodes, ${stats.relsCreated} relationships created)`
        } catch (e: any) {
          result = `❌ Graph write error: ${e.message}`
        }
      }
    }
    else if (name === 'save_ioc') {
      logger.info('TOOL', `🛡️  Saving IOC (Neo4j): ${args.node_type}:${args.value}`)
      try {
        const props: Record<string, string> = {}
        if (args.properties && typeof args.properties === 'object') {
          Object.assign(props, args.properties)
        }
        const linkedTo = args.linked_label && args.linked_value && args.linked_relation
          ? { label: args.linked_label, value: args.linked_value, relation: args.linked_relation }
          : undefined
        const stats = await writeCybersecurityNode(args.node_type, args.value, props, linkedTo)
        result = `✅ IOC saved to Neo4j graph. (${stats.nodesCreated} nodes, ${stats.relsCreated} relationships created)`
      } catch (e: any) {
        result = `❌ Graph write error: ${e.message}`
      }
    }
    else if (name === 'link_entities') {
      logger.info('TOOL', `🔗 Linking entities (Neo4j): ${args.from_label}:${args.from_value} -[${args.relation}]-> ${args.to_label}:${args.to_value}`)
      try {
        const stats = await linkEntities(
          args.from_label, args.from_value,
          args.to_label, args.to_value,
          args.relation,
          { evidence: args.evidence, confidence: (args.confidence as any) ?? 'medium' }
        )
        result = `✅ Entities linked. (${stats.nodesCreated} nodes, ${stats.relsCreated} relationships created)`
      } catch (e: any) {
        result = `❌ Graph write error: ${e.message}`
      }
    }
    else if (name === 'reverse_image_search') {
      logger.info('TOOL', `🖼️ Reverse Image Search (SerpApi): ${args.imageUrl}`)
      const res = await searchReverseImage(args.imageUrl)
      result = formatReverseImageResult(res)
    }
    else if (name === 'compare_images_phash') {
      logger.info('TOOL', `🧩 pHash Comparison: ${args.url1} vs ${args.url2}`)
      result = await compareImages(args.url1, args.url2)
    }
    else if (name === 'auto_visual_intel') {
      const urls = (args.profile_urls || '').split(',').map((u: string) => u.trim()).filter(Boolean)
      logger.info('TOOL', `🖼️ Auto Visual Intel: ${urls.length} profiles`)
      result = await autoVisualIntel(urls)
    }
    else if (name === 'add_custom_node') {
      logger.info('TOOL', `➕ Adding custom node: ${args.label}`);
      const res = await addCustomNodeTool({ label: args.label, properties: args.properties as any });
      result = JSON.stringify(res);
    }
    else if (name === 'delete_custom_node') {
      logger.info('TOOL', `➖ Deleting custom node: ${args.label} (${args.matchKey}: ${args.matchValue})`);
      const res = await deleteCustomNodeTool({ label: args.label, matchKey: args.matchKey, matchValue: args.matchValue });
      result = JSON.stringify(res);
    }
    else if (name === 'add_custom_relationship') {
      logger.info('TOOL', `🔗 Adding custom relationship: ${args.sourceLabel} -[${args.relationshipType}]-> ${args.targetLabel}`);
      const res = await addCustomRelationshipTool({
        sourceLabel: args.sourceLabel,
        sourceKey: args.sourceKey,
        sourceValue: args.sourceValue,
        targetLabel: args.targetLabel,
        targetKey: args.targetKey,
        targetValue: args.targetValue,
        relationshipType: args.relationshipType
      });
      result = JSON.stringify(res);
    }
    else if (name === 'search_researcher_papers') {
      logger.info('TOOL', `👤 Researcher Search (Semantic Scholar): ${args.name}`)
      const authorResult = await searchAuthorPapers(args.name, args.affiliation)
      result = formatAuthorResult(authorResult)
      // Write to graph — convert AuthorPaper to AcademicPaper format
      if (authorResult.author && authorResult.author.papers.length > 0) {
        try {
          const { getDriver } = await import('./neo4j.js')
          const driver = getDriver()
          const neo4jWrite = async (query: string, params: Record<string, unknown>) => {
            const session = driver.session()
            try { await session.run(query, params) } finally { await session.close() }
          }
          const papers = authorResult.author.papers.map((p) => ({
            arxivId: p.arxivId ?? p.paperId,
            title: p.title,
            authors: [authorResult.author!.name],
            abstract: '',
            publishedDate: p.year ? `${p.year}-01-01` : '',
            updatedDate: '',
            categories: [],
            pdfUrl: p.doi ? `https://doi.org/${p.doi}` : '',
            htmlUrl: p.arxivId ? `https://arxiv.org/abs/${p.arxivId}` : '',
            totalCitations: p.citationCount,
          }))
          const stats = await writeAcademicPapersToGraph(papers, args.name, neo4jWrite)
          logger.info('GRAPH', `💾 Written to graph: ${stats.papersCreated} papers, ${stats.authorsLinked} author links`)
          result += `\n\n💾 Neo4j Graph: ${stats.papersCreated} Paper nodes, ${stats.authorsLinked} AUTHORED_BY relationships created.`
        } catch {
          logger.warn('GRAPH', '⚠️  Graph write skipped (Neo4j connection may be unavailable)')
        }
      }
    }
    else if (name === 'generate_report') {
      logger.info('TOOL', `📄 Generating report [${args.reportType || 'osint'}]: ${args.subject}`)
      // If additionalFindings is absent, read from buffer (fallback when model can't JSON encode)
      const findings = args.additionalFindings || _reportContentBuffer || undefined;
      if (!args.additionalFindings && _reportContentBuffer) {
        logger.debug('TOOL', `ℹ️  additionalFindings argument was missing — used internal buffer (${_reportContentBuffer.length} chars)`);
      }
      try {
        const reportResult = await generateOsintReport({
          subject: args.subject,
          reportType: (args.reportType as 'osint' | 'academic' | 'factcheck') ?? 'osint',
          title: args.title,
          additionalFindings: findings,
        })
        logger.info('TOOL', `✅ Report saved: ${reportResult.filePath}`)
        result = [
          `✅ **Report generated successfully!**`,
          ``,
          `📁 **File:** \`${reportResult.filePath}\``,
          ``,
          `---`,
          ``,
          reportResult.markdown,
        ].join('\n')
      } catch (e) {
        const msg = (e as Error).message
        logger.error('TOOL', `❌ Report error: ${msg}`)
        result = `❌ Report generation error: ${msg}`
      }
    }
    else if (name === 'check_plagiarism') {
      const label = args.title ?? args.doi ?? args.author ?? 'text'
      logger.info('TOOL', `🔬 Plagiarism Analysis: ${label}`)
      try {
        const report = await checkPlagiarism({
          text: args.text,
          mode: (args.mode as 'plagiarism' | 'originality' | 'full') ?? 'plagiarism',
          author: args.author,
          title: args.title,
          doi: args.doi,
        })
        const riskEmoji = { clean: '🟢', low: '🔵', medium: '🟡', high: '🔴', critical: '🚨' }[report.overallRisk]
        logger.info('TOOL', `✅ Analysis complete: ${riskEmoji} ${report.overallRisk.toUpperCase()} — ${report.matches.length} matches`)
        result = report.markdown
      } catch (e) {
        const msg = (e as Error).message
        logger.error('TOOL', `❌ Plagiarism analysis error: ${msg}`)
        result = `❌ Plagiarism analysis error: ${msg}`
      }
    }
    else if (name === 'search_academic_papers') {
      const maxResults = parseInt(args.maxResults ?? '10') || 10
      const sortBy = (args.sortBy as 'relevance' | 'submittedDate' | 'lastUpdatedDate') ?? 'submittedDate'
      logger.info('TOOL', `🔬 Academic Search (arXiv + Semantic Scholar): ${args.query}`)
      const searchResult = await searchAcademicPapers(args.query, maxResults, sortBy, {
        peerReviewedOnly: String(args.peerReviewedOnly).toLowerCase() === 'true',
      })
      const ssNote = (searchResult as AcademicSearchResult & { _ssNote?: string })._ssNote
      if (ssNote) logger.debug('TOOL', ssNote)
      result = formatAcademicResult(searchResult)
      // Write to graph
      try {
        const { getDriver } = await import('./neo4j.js')
        const driver = getDriver()
        const neo4jWrite = async (query: string, params: Record<string, unknown>) => {
          const session = driver.session()
          try { await session.run(query, params) } finally { await session.close() }
        }
        const stats = await writeAcademicPapersToGraph(searchResult.papers, args.query, neo4jWrite)
        logger.info('GRAPH', `💾 Written to graph: ${stats.papersCreated} papers, ${stats.authorsLinked} author links`)
        result += `\n\n💾 Neo4j Graph: ${stats.papersCreated} Paper nodes, ${stats.authorsLinked} AUTHORED_BY relationships created.`
      } catch {
        logger.warn('GRAPH', '⚠️  Graph write skipped (Neo4j connection may be unavailable)')
      }
    }
    else if (name === 'obsidian_write') {
      const overwrite = String(args.overwrite) !== 'false'
      logger.info('OBSIDIAN', `🟣 Writing to Obsidian: ${args.note_path}`)
      result = await obsidianWrite(args.note_path, args.content, overwrite)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_append') {
      logger.info('OBSIDIAN', `🟣 Obsidian'a ekleniyor: ${args.note_path}`)
      result = await obsidianAppend(args.note_path, args.content)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_read') {
      logger.info('OBSIDIAN', `🟣 Obsidian okunuyor: ${args.note_path}`)
      result = await obsidianRead(args.note_path)
    }
    else if (name === 'obsidian_daily') {
      logger.info('OBSIDIAN', '🟣 Günlüğe kaydediliyor...')
      result = await obsidianDailyLog(args.entry, args.tag)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_write_profile') {
      logger.info('OBSIDIAN', `🟣 Profil oluşturuluyor: ${args.username}`)
      const metadata = {
        realName: args.real_name,
        emails: args.emails ? String(args.emails).split(',').map((s: string) => s.trim()) : undefined,
        platforms: args.platforms ? String(args.platforms).split(',').map((s: string) => s.trim()) : undefined,
        confidence: args.confidence as 'verified' | 'high' | 'medium' | 'low' | undefined,
      }
      result = await obsidianWriteProfile(args.username, args.content, metadata)
      logger.info('OBSIDIAN', result)
    }
    else if (name === 'obsidian_list') {
      logger.info('OBSIDIAN', `🟣 Obsidian dizini listeleniyor: ${args.dir || '(vault kökü)'}`)
      result = await obsidianList(args.dir)
    }
    else if (name === 'obsidian_search') {
      logger.info('OBSIDIAN', `🟣 Obsidian'da aranıyor: ${args.query}`)
      const limit = args.limit ? parseInt(String(args.limit), 10) : 10
      result = await obsidianSearch(args.query, limit)
      logger.debug('OBSIDIAN', result.slice(0, 200))
    }
    else result = `Unknown tool: ${name}`;

    if (cacheableTools.has(name) && !result.startsWith('Unknown tool')) {
      toolCache.set(cacheKey, result);
    }
    
    return result;
  }

async function runExtractMetadata(url: string): Promise<string> {
  logger.info('TOOL', `🔍 Metadata çıkarılıyor: ${url}...`)
  const result = await extractMetadataFromUrl(url)
  const interesting = Object.keys(result.interestingFields).length
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
  } else {
    logger.info('TOOL', `✅ ${Object.keys(result.fields).length} metadata alanı bulundu (${interesting} OSINT-relevant)`)
  }
  return formatMetadata(result)
}

async function runParseGpgKey(username: string): Promise<string> {
  logger.info('TOOL', `🔑 GPG key analizi: ${username}...`)
  let result = await parseGithubGpgKey(username)

  // GitHub .gpg endpoint boş döndüyse → repo'da raw PGP dosyası arama yap
  if (result.error && result.emails.length === 0) {
    logger.debug('TOOL', `🔍 Repo'da PGP key aranıyor (${username}/PGP)...`)
    const rawUrls = [
      `https://raw.githubusercontent.com/${username}/PGP/main/pgp.asc`,
      `https://raw.githubusercontent.com/${username}/PGP/main/publickey`,
      `https://raw.githubusercontent.com/${username}/pgp/main/pgp.asc`,
      `https://raw.githubusercontent.com/${username}/PGP/master/pgp.asc`,
      `https://raw.githubusercontent.com/${username}/gpg/main/key.asc`,
    ]
    for (const rawUrl of rawUrls) {
      try {
        const raw = await webFetch(rawUrl)
        if (!raw.error && raw.textContent && raw.textContent.includes('BEGIN PGP PUBLIC KEY')) {
          logger.info('TOOL', `✅ Repo'da PGP key bulundu: ${rawUrl}`)
          const tmpFile = `${os.tmpdir()}/pgp-${Date.now()}.asc`
          await writeFile(tmpFile, raw.textContent)
          result = await parseGpgKeyFile(tmpFile)
          result = { ...result, source: rawUrl }
          await unlink(tmpFile).catch(() => {})
          break
        }
      } catch { /* bu URL'de yok, devam */ }
    }
  }

  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
  } else {
    logger.info('TOOL', `✅ ${result.emails.length} email, ${result.names.length} isim bulundu`)
  }

  // Email'leri grafa yaz
  if (result.emails.length > 0) {
    try {
      const stats = await writeOsintToGraph(username, { emails: result.emails, realName: result.names[0] }, 'gpg_key')
      logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
    }
  }

  return formatGpgResult(result)
}

async function runWaybackSearch(url: string): Promise<string> {
  logger.info('TOOL', `📸 Wayback Machine aranıyor: ${url}...`)
  const result = await waybackSearch(url)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
  } else {
    logger.info('TOOL', `✅ ${result.snapshots.length} arşiv snapshot'ı bulundu`)
  }
  return formatWaybackResult(result)
}

async function runWebFetch(url: string): Promise<string> {
  logger.info('TOOL', `🌐 Sayfa çekiliyor: ${url}...`)
  let result = await webFetch(url)

  // SSRF / internal network block — do NOT fall through to scraper (scraper has no SSRF check)
  if (result.error && (
    result.error.includes('İç ağ adreslerine erişim engellendi') ||
    result.error.includes('Sadece http/https desteklenir') ||
    result.error.includes('Geçersiz URL')
  )) {
    logger.warn('TOOL', `🚫 Erişim engellendi: ${result.error}`)
    return `❌ Erişim engellendi: ${result.error}`
  }

  // HİBRİT FALLBACK: Eğer 403 (Cloudflare/Bot protection) veya bağlantı hatası alırsak, Firecrawl API'sine (scrapeTool) düş.
  if (result.error || result.statusCode === 403 || result.statusCode === 401) {
    logger.warn('TOOL', `⚠️ curl engellendi (HTTP ${result.statusCode || 'Hata'}). Firecrawl Stealth Proxy'ye geçiliyor...`)
    try {
      const scrapeResult = await scrapeProfile(url)
      if (!scrapeResult.error) {
        logger.info('TOOL', '✅ Firecrawl ile başarıyla çekildi (Markdown okundu)')
        // Scrape sonuçlarını formatlayıp dön
        return formatScrapeResult(scrapeResult)
      } else {
        logger.error('TOOL', `❌ Firecrawl da başarısız: ${scrapeResult.error}`)
        return `Fetch ve Scrape hatası: ${scrapeResult.error}`
      }
    } catch (e) {
      logger.error('TOOL', `❌ Scrape modülü hatası: ${(e as Error).message}`)
      return `Scrape hatası: ${(e as Error).message}`
    }
  }

  logger.info('TOOL', `✅ ${result.contentType} (HTTP ${result.statusCode})`)
  if (result.textContent) {
    // Akademik URL'ler için deep-read modu: 50K — diğerleri için 8K
    const isDeepReadUrl = /ar5iv\.|arxiv\.org\/(abs|pdf)|doi\.org|dergipark\.org\.tr|ncbi\.nlm\.nih\.gov|pubmed\.|semanticscholar\.org/.test(url)
    const limit = isDeepReadUrl ? 50000 : 8000
    if (isDeepReadUrl) logger.debug('TOOL', `📖 Deep-read modu aktif (${limit.toLocaleString()} char)`)
    return result.textContent.slice(0, limit)
  }

  // PDF → text dönüşümü (pdftotext CLI)
  if (result.savedTo && result.contentType?.includes('pdf')) {
    try {
      const { execFileSync } = await import('child_process')
      const txtOutput = result.savedTo.replace(/\.pdf$/, '.txt')
      execFileSync('pdftotext', ['-layout', result.savedTo, txtOutput], { timeout: 15000 })
      const { readFile: readPdf } = await import('fs/promises')
      const pdfText = await readPdf(txtOutput, 'utf-8')
      const limit = 50000
      if (pdfText && pdfText.trim().length > 50) {
        logger.info('TOOL', `📄 PDF → text dönüştürüldü (${pdfText.length} char)`)
        return pdfText.slice(0, limit)
      }
    } catch (pdfErr) {
      logger.warn('TOOL', `PDF dönüştürme hatası: ${(pdfErr as Error).message}`)
    }
  }

  return `Binary dosya indirildi: ${result.savedTo} (${result.contentType})`
}

async function runEmailRegistrations(email: string): Promise<string> {
  logger.info('TOOL', `📧 Email kayıt kontrolü (Holehe): ${email}...`)
  logger.info('TOOL', '(120+ platform taranıyor, ~30-60sn)')
  const result = await checkEmailRegistrations(email)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return formatHoleheResult(result)
  }
  logger.info('TOOL', `✅ ${result.totalChecked} platform tarandı, ${result.services.length} kayıt bulundu`)

  // Grafa yaz: Email → REGISTERED_ON → Platform
  if (result.services.length > 0) {
    try {
      const stats = await writeEmailRegistrations(email, result.services, 'holehe')
      logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
    }
  }

  return formatHoleheResult(result)
}



async function runClearGraph(confirm: boolean): Promise<string> {
  if (!confirm) return 'Silme işlemi onaylanmadı.';
  logger.warn('GRAPH', '⚠️  Graf veritabanı temizleniyor...');
  try {
    process.env.NEO4J_ALLOW_CLEAR = '1';
    await clearGraph();
    logger.info('GRAPH', '✅ Graf veritabanı başarıyla temizlendi.');
    return 'Tüm graf veritabanı kalıcı olarak silindi ve sıfırlandı.';
  } catch (e) {
    logger.error('GRAPH', `❌ Hata: ${(e as Error).message}`);
    return `Temizleme hatası: ${(e as Error).message}`;
  }
}

async function runRemoveFalsePositive(label: string, value: string): Promise<string> {
  logger.warn('GRAPH', `🧹 False Positive Temizleniyor: ${label}(${value})`);
  try {
    const success = await deleteGraphNodeAndRelations(label, value);
    if (success) {
      logger.info('GRAPH', '✅ Düğüm ve ilişkileri Graf’tan silindi.');
      return `Başarı: ${label} etiketli ve ${value} değerli düğüm (ve bağlı ilişkileri) sinildi.`;
    } else {
      logger.warn('GRAPH', '⚠️ Eşleşen düğüm bulunamadı veya silinemedi.');
      return `Hata: ${label} etiketli ve ${value} değerli düğüm bulunamadı.`;
    }
  } catch (e) {
    logger.error('GRAPH', `❌ Temizleme hatası: ${(e as Error).message}`);
    return `Temizleme hatası: ${(e as Error).message}`;
  }
}

async function runSearchWeb(query: string): Promise<string> {
  logger.info('SEARCH', `🔎 Web'de aranıyor (Dorking): ${query}...`)
  const result = await searchWeb(query)
  if (result.error) {
    logger.error('SEARCH', `❌ ${result.error}`)
    return formatSearchResult(result)
  }
  logger.info('SEARCH', `✅ ${result.results.length} sonuç bulundu`)

  // Kaynak etiketlerini sonuçlara ekle
  const lines: string[] = []
  const header = formatSearchResult(result)
  // Header formatSearchResult'dan gelir, sonuçları ayır
  const headerLines = header.split('\n')
  for (const line of headerLines) {
    lines.push(line)
    // "   URL: https://..." satırından sonra kaynak etiketi ekle
    if (line.trim().startsWith('URL:')) {
      const url = line.trim().replace(/^URL:\s*/, '')
      const resultItem = result.results.find(r => r.url === url)
      lines.push(`   ${formatSourceBadge(url, resultItem?.snippet)}`)
    }
  }
  return lines.join('\n')
}

async function runSearchWebMulti(queriesRaw: string): Promise<string> {
  const queries = queriesRaw.split(',').map(q => q.trim()).filter(Boolean).slice(0, 3)
  logger.info('SEARCH', `🔎 Paralel arama (${queries.length} sorgu): ${queries.join(' | ')}`)
  const result = await searchWebMulti(queries)
  logger.info('SEARCH', `✅ ${result.totalUnique} benzersiz sonuç`)

  const lines: string[] = [
    `🔍 Paralel Web Arama (${queries.length} sorgu): ${queries.join(', ')}`,
    `Benzersiz sonuç: ${result.totalUnique}`,
    '',
    `⚠️ SİSTEM NOTU: Sonuçları doğrudan %100 doğru kabul etmeyin.`,
    '',
  ]
  result.results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`)
    lines.push(`   URL: ${r.url}`)
    lines.push(`   ${formatSourceBadge(r.url, r.snippet)}`)
    lines.push(`   Özet: ${r.snippet}`)
    lines.push('')
  })
  return lines.join('\n')
}

async function runVerifyClaim(url: string, claim: string): Promise<string> {
  logger.info('TOOL', `🔍 İddia doğrulama: "${claim}" @ ${url}`)
  // claim metninden basit anahtar kelimeler çıkar
  const keywords = claim
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['olan', 'için', 'veya', 'and', 'the', 'with', 'that', 'this'].includes(w))
    .slice(0, 5)
  const result = await verifyClaim(claim, url, keywords)
  logger.info('TOOL', `✅ Doğrulama tamamlandı — güven: ${result.confidence}`)
  return formatVerifyResult(result)
}

async function runScrapeProfile(url: string): Promise<string> {  logger.info('TOOL', `🕷️  Sayfa kazınıyor: ${url}...`)
  const result = await scrapeProfile(url)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    if (result.usageWarning) logger.warn('TOOL', result.usageWarning)
    return formatScrapeResult(result)
  }
  const found = [result.emails.length, result.cryptoWallets.length, result.usernameHints.length]
    .map((n, i) => n > 0 ? `${n} ${['email', 'cüzdan', 'handle'][i]}` : '')
    .filter(Boolean).join(', ')
  logger.info('TOOL', `✅ Sayfa alındı${found ? ` — ${found}` : ''}: ${result.title || url}`)

  return formatScrapeResult(result)
}

async function runBreachCheck(email: string): Promise<string> {
  logger.info('TOOL', `🔓 Veri sızıntısı kontrolü: ${email}...`)
  const result = await checkBreaches(email)
  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return formatBreachResult(result)
  }
  logger.info('TOOL', `✅ ${result.breaches.length} sızıntı bulundu (kaynak: ${result.source})`)

  // Grafa yaz: Email → LEAKED_IN → Breach
  if (result.breaches.length > 0) {
    try {
      const stats = await writeBreachData(email, result.breaches, result.source === 'hibp' ? 'hibp' : 'local_breach_db')
      logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
    } catch {
      logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
    }
  }

  return formatBreachResult(result)
}

async function runVerifyProfiles(username: string): Promise<string> {
  logger.info('TOOL', `🔍 Profil doğrulama başlatılıyor: ${username}...`)

  // Graftan bilinen tanımlayıcıları çek
  let known: { emails: string[]; realNames: string[]; handles: string[]; websites: string[]; avatarUrl?: string }
  try {
    known = await findLinkedIdentifiers(username)
  } catch {
    return 'Neo4j bağlantısı kurulamadı — bilinen tanımlayıcılar çekilemedi.'
  }

  if (known.emails.length === 0 && known.realNames.length === 0 && !known.avatarUrl) {
    return `"${username}" için grafta bilinen email, gerçek isim veya avatar yok. Önce run_github_osint ile bilgi topla.`
  }

  // Eğer bilinen avatar URL'si varsa, hash'ini baştan hesapla ki her profilde tekrar indirmeyelim
  let avatarHash: string | undefined;
  if (known.avatarUrl) {
    logger.debug('TOOL', '🖼️ Hedefin bilinen bir avatarı var, referans hash hesaplanıyor...');
    avatarHash = (await fetchAndHashImage(known.avatarUrl)) || undefined;
    if (avatarHash) {
      logger.info('TOOL', `✅ Referans avatar hash eşleşti: ${avatarHash.substring(0, 16)}...`);
    } else {
      logger.warn('TOOL', '⚠️ Referans avatar indirilemedi veya hash hesaplanamadı.');
    }
  }

  // Graftan Sherlock profil URL'lerini çek
  let profiles: Array<{ platform: string; url: string }>
  try {
    const connections = await getConnections(username)
    profiles = connections
      .filter(c => c.relation === 'HAS_PROFILE')
      .map(c => {
        // Platform adını URL'den çıkar
        const urlMatch = c.to.match(/(?:www\.)?([^./]+)\.\w+/)
        return { platform: urlMatch?.[1] || 'unknown', url: c.to }
      })
  } catch {
    return 'Neo4j bağlantısı kurulamadı — profiller çekilemedi.'
  }

  if (profiles.length === 0) {
    return `"${username}" için grafta doğrulanacak profil yok. Önce run_sherlock çalıştır.`
  }

  logger.info('TOOL', `📋 ${profiles.length} profil bulundu, doğrulama yapılıyor (max 10)...`)

  const knownIds = {
    username,
    realName: known.realNames[0],
    emails: known.emails,
    avatarUrl: known.avatarUrl,
    avatarHash: avatarHash
  }

  const { results, verified, unverified, skipped } = await verifySherlockProfiles(profiles, knownIds, 10)

  logger.info('TOOL', `✅ Doğrulama tamamlandı: ${verified} doğrulandı, ${unverified} doğrulanmadı, ${skipped} atlandı`)

  // Doğrulanan profillerin güven seviyesini grafta yükselt
  for (const r of results.filter(r => r.verified)) {
    try {
      await mergeRelation('Username', username, 'Profile', r.url, 'HAS_PROFILE', {
        source: 'profile_verification',
        confidence: 'high',
      })
    } catch { /* sessiz geç */ }
  }

  return formatVerificationResults(results)
}

async function runNitterProfile(username: string): Promise<string> {
  logger.info('TOOL', `🐦 Twitter/X profil çekiliyor (Scrapling Stealth): ${username}...`)
  const result = await fetchNitterProfile(username)

  if (result.error) {
    logger.error('TOOL', `❌ ${result.error}`)
    return formatNitterResult(result)
  }

  logger.info('TOOL', `✅ Twitter profili çekildi: ${result.displayName || username}`)

  // Grafa yaz
  try {
    const data: Record<string, string | undefined> = {}
    if (result.displayName) data.realName = result.displayName
    if (result.location) data.location = result.location
    if (result.website) data.blog = result.website

    const stats = await writeOsintToGraph(username, {
      realName: data.realName,
      location: data.location,
      blog: data.blog,
    }, 'nitter')
    logger.info('GRAPH', `💾 Grafa yazıldı: ${stats.nodesCreated} node, ${stats.relsCreated} ilişki`)
  } catch {
    logger.warn('GRAPH', '⚠️  Graf yazma atlandı')
  }

  return formatNitterResult(result)
}

async function runUnexploredPivots(username: string): Promise<string> {
  logger.info('TOOL', `🧭 Keşfedilmemiş pivot noktaları aranıyor: ${username}...`)
  try {
    const pivots = await findUnexploredPivots(username)
    logger.info('TOOL', `✅ ${pivots.suggestions.length} öneri bulundu`)
    return formatUnexploredPivots(pivots)
  } catch (e) {
    logger.error('TOOL', `❌ ${(e as Error).message}`)
    return `Pivot analizi hatası: ${(e as Error).message}`
  }
}

async function runSearchPerson(name: string, context?: string): Promise<string> {
  logger.info('TOOL', `👤 İsim araştırması: ${name}${context ? ` (${context})` : ''}...`)
  const result = await searchPerson(name, context)

  if (result.graphMatches.length > 0) {
    const totalUsernames = result.graphMatches.reduce((sum, m) => sum + m.linkedUsernames.length, 0)
    logger.info('TOOL', `✅ Grafta ${result.graphMatches.length} eşleşme, ${totalUsernames} bağlı username bulundu`)
  } else {
    logger.info('TOOL', '⚠️ Grafta eşleşme yok — web araması yapıldı')
  }

  return formatPersonSearchResult(result)
}

async function queryGraph(value: string): Promise<string> {
  logger.info('GRAPH', `📊 Graf sorgulanıyor: ${value}...`)
  try {
    const connections = await getConnections(value)
    if (connections.length === 0) return `"${value}" için grafta bağlantı bulunamadı.`
    const lines = connections.map((c) => {
      const meta = c.confidence ? ` [✅ ${c.confidence}${c.source ? ` via ${c.source}` : ''}]` : ''
      return `${c.from} --[${c.relation}]--> ${c.to} (${c.toLabel})${meta}`
    })
    logger.info('GRAPH', `✅ ${connections.length} bağlantı bulundu`)
    return `Graf bağlantıları (${value}):\n${lines.join('\n')}`
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function runCrossReference(username: string): Promise<string> {
  logger.info('GRAPH', `🔗 Çapraz doğrulama: ${username}...`)
  try {
    const ids = await findLinkedIdentifiers(username)
    const lines: string[] = [`Çapraz doğrulama sonuçları (“${username}” için doğrulanmış tanımlayıcılar):`]

    if (ids.emails.length > 0) lines.push(`- Email: ${ids.emails.join(', ')}`)
    if (ids.realNames.length > 0) lines.push(`- Gerçek isim: ${ids.realNames.join(', ')}`)
    if (ids.handles.length > 0) lines.push(`- Bağlı handle: ${ids.handles.join(', ')}`)
    if (ids.websites.length > 0) lines.push(`- Website: ${ids.websites.join(', ')}`)

    if (lines.length === 1) {
      lines.push('- Hiçbir doğrulanmış tanımlayıcı bulunamadı. Önce run_github_osint veya run_sherlock ile bilgi toplamalısın.')
    } else {
      lines.push('')
      lines.push('💡 Strateji: Bu doğrulanmış bilgileri kullanarak pivot yap.')
      lines.push('- Email ile arama yap (platformlarda email ile kayıtlı mı?)')
      lines.push('- Diğer handle\'ları Sherlock ile tara')
      lines.push(`- “${ids.realNames[0] || username}” ismi çok yaygınsa, yalnızca isim eşleşmesine güvenme — email veya handle eşleşmesi gerekli.`)
    }

    logger.info('GRAPH', `✅ ${ids.emails.length} email, ${ids.handles.length} handle, ${ids.realNames.length} isim bulundu`)
    return lines.join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function graphStats(): Promise<string> {
  logger.info('GRAPH', '📊 Graf istatistikleri çekiliyor...')
  try {
    const stats = await getGraphStats()
    logger.info('GRAPH', `✅ ${stats.nodes} node, ${stats.relationships} ilişki`)
    return `Graf istatistikleri:\n- Toplam node: ${stats.nodes}\n- Toplam ilişki: ${stats.relationships}`
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function runListGraphNodes(label?: string, limit?: string): Promise<string> {
  logger.info('GRAPH', '🧩 Graf node listesi çekiliyor...')
  try {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 50
    const counts = await getGraphNodeCountsByLabel()
    const nodes = await listGraphNodes(Number.isFinite(parsedLimit) ? parsedLimit : 50, label)

    const lines: string[] = ['Graf node özeti:', 'Not: Bu sayılar ve listeler tüm graf içindir; tek bir kullanıcıya otomatik olarak atfedilmemelidir.']
    for (const item of counts) {
      lines.push(`- ${item.label}: ${item.count}`)
    }

    if (nodes.length === 0) {
      lines.push(label
        ? `- ${label} etiketi için node bulunamadı.`
        : '- Listelenecek node bulunamadı.')
      return lines.join('\n')
    }

    lines.push('')
    lines.push(label ? `${label} node'ları:` : `İlk ${nodes.length} node:`)
    for (const node of nodes) {
      lines.push(`- ${node.label}: ${node.value}`)
    }

    logger.info('GRAPH', `✅ ${nodes.length} node listelendi`)
    return lines.join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}

async function repairGraphNoise(): Promise<string> {
  logger.info('GRAPH', '🧹 Graf gürültüsü temizleniyor...')
  try {
    const result = await pruneMisclassifiedFullNameUsernames()
    logger.info('GRAPH', `✅ ${result.usernamesRemoved} username, ${result.profilesRemoved} profil temizlendi`)
    return [
      'Graf temizleme özeti:',
      `- Silinen hatalı Username node: ${result.usernamesRemoved}`,
      `- Silinen ilişkili Profile node: ${result.profilesRemoved}`,
      `- Silinen orphan Platform node: ${result.orphanPlatformsRemoved}`,
    ].join('\n')
  } catch {
    return 'Neo4j bağlantısı kurulamadı.'
  }
}


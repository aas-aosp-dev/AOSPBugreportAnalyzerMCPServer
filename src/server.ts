import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { request } from "undici";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_OWNER = process.env.GITHUB_DEFAULT_OWNER ?? "aas-aosp-dev";
const DEFAULT_REPO = process.env.GITHUB_DEFAULT_REPO ?? "AOSPBugreportAnalyzer";
const USER_AGENT = "AOSPBugreportAnalyzerMCPServer";

const server = new McpServer({
  name: "aospbugreportanalyzer-mcp",
  version: "0.1.0",
  description: "MCP server that exposes minimal GitHub tools for AOSPBugreportAnalyzer"
});

function requireToken() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set. Please configure a GitHub token as an environment variable."
    );
  }
}

function safeSerialize(payload: unknown) {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return String(payload);
  }
}

async function callGithub(url: string, headers: Record<string, string>) {
  requireToken();

  try {
    console.log("[MCP-SERVER] Calling GitHub API:", {
      url,
      headers: { Accept: headers.Accept },
      hasToken: Boolean(GITHUB_TOKEN)
    });

    const response = await request(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": USER_AGENT,
        ...headers
      }
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const snippet = (await response.body.text()).slice(0, 200);
      console.log("[MCP-SERVER] GitHub API non-2xx response", {
        status: response.statusCode,
        bodySnippet: snippet
      });
      throw new Error(`GitHub API error: ${response.statusCode} ${snippet}`);
    }

    console.log("[MCP-SERVER] GitHub API response status:", response.statusCode);

    return response;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to call GitHub API: ${error.message}`);
    }
    throw error;
  }
}

function registerTools() {
  console.error(
    "[MCP-SERVER] Registering tools: github.list_pull_requests, github.get_pr_diff, fs.save_summary"
  );

  const githubListInputSchema = {
    type: "object",
    properties: {
      owner: { type: "string", default: DEFAULT_OWNER },
      repo: { type: "string", default: DEFAULT_REPO },
      state: {
        type: "string",
        enum: ["open", "closed", "all"],
        default: "open"
      }
    },
    required: [],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  } as const;

  const githubListOutputSchema = {
    type: "object",
    properties: {
      pullRequests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: "integer" },
            title: { type: "string" },
            url: { type: "string", format: "uri" },
            state: { type: "string" }
          },
          required: ["number", "title", "url", "state"],
          additionalProperties: false
        },
        default: []
      }
    },
    required: ["pullRequests"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  } as const;

  const githubGetPrDiffInputSchema = {
    type: "object",
    properties: {
      owner: { type: "string", default: DEFAULT_OWNER },
      repo: { type: "string", default: DEFAULT_REPO },
      number: { type: "integer", minimum: 1 }
    },
    required: ["number"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  } as const;

  const githubGetPrDiffOutputSchema = {
    type: "object",
    properties: {
      diff: { type: "string" }
    },
    required: ["diff"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  } as const;

  const fsSaveSummaryInputSchema = {
    type: "object",
    properties: {
      fileName: {
        type: "string",
        description: "File name for the summary, e.g. pr-43-summary.md"
      },
      content: {
        type: "string",
        description: "Markdown content to write"
      }
    },
    required: ["fileName", "content"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  } as const;

  const fsSaveSummaryOutputSchema = {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Absolute path to the written file"
      }
    },
    required: ["filePath"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  } as const;

  console.error("[MCP-SERVER] About to register tool schemas via JSON Schema");
  console.error("[MCP-SERVER] github.list_pull_requests inputSchema.type:", githubListInputSchema.type);
  console.error("[MCP-SERVER] github.get_pr_diff inputSchema.type:", githubGetPrDiffInputSchema.type);
  console.error("[MCP-SERVER] fs.save_summary inputSchema.type:", fsSaveSummaryInputSchema.type);

  server.registerTool(
    "github.list_pull_requests",
    {
      description: "List pull requests for a GitHub repository",
      inputSchema: githubListInputSchema,
      outputSchema: githubListOutputSchema
    },
    async (input, { requestId }) => {
      console.error("[MCP-SERVER] Tool github.list_pull_requests called:", {
        requestId,
        args: input
      });

      try {
        const owner = input.owner ?? DEFAULT_OWNER;
        const repo = input.repo ?? DEFAULT_REPO;
        const state = input.state ?? "open";
        console.log("[MCP-SERVER] github.list_pull_requests GitHub call", {
          owner,
          repo,
          state,
          hasToken: Boolean(GITHUB_TOKEN)
        });
        const response = await callGithub(
          `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}`,
          { Accept: "application/vnd.github+json" }
        );

        const rawBody = await response.body.text();
        console.log("[MCP-SERVER] github.list_pull_requests GitHub response", {
          requestId,
          status: response.statusCode,
          bodySnippet: rawBody.slice(0, 500)
        });

        const data = JSON.parse(rawBody) as Array<{
          number: number;
          title: string;
          html_url: string;
          state: string;
        }>;

        const simplified = data.map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: pr.state
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${simplified.length} PR(s) in ${owner}/${repo} (state=${state})`
            }
          ],
          structuredContent: {
            pullRequests: simplified
          }
        };
      } catch (error) {
        console.error(
          "[MCP-SERVER] Error in github.list_pull_requests:",
          error
        );
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while listing pull requests";
        return {
          content: [
            {
              type: "text",
              text: `GitHub API error while listing PRs for ${owner}/${repo}: ${message}`
            }
          ],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "fs.save_summary",
    {
      description: "Save summary content into a Markdown file and return the path",
      inputSchema: fsSaveSummaryInputSchema,
      outputSchema: fsSaveSummaryOutputSchema
    },
    async (args, { requestId }) => {
      console.error("[MCP-SERVER] Tool fs.save_summary called:", {
        requestId,
        args
      });

      try {
        const { fileName, content } = args as {
          fileName: string;
          content: string;
        };
        const summariesDir = path.join(process.cwd(), "summaries");
        await fs.promises.mkdir(summariesDir, { recursive: true });

        const safeFileName = fileName
          .replace(/[\/\\]/g, "_")
          .replace(/\.\./g, "")
          .replace(/\s+/g, "_");
        const fullPath = path.join(summariesDir, safeFileName);

        await fs.promises.writeFile(fullPath, content, "utf-8");

        console.error("[MCP-SERVER] Saved summary to:", fullPath);

        return {
          content: [
            {
              type: "text",
              text: `Summary saved to ${fullPath}`
            }
          ],
          structuredContent: {
            filePath: fullPath
          }
        };
      } catch (error) {
        console.error("[MCP-SERVER] Error in fs.save_summary:", error);
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while saving summary";
        return {
          content: [
            {
              type: "text",
              text: `Failed to save summary: ${message}`
            }
          ],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "github.get_pr_diff",
    {
      description: "Get unified diff for a specific GitHub pull request",
      inputSchema: githubGetPrDiffInputSchema,
      outputSchema: githubGetPrDiffOutputSchema
    },
    async (input, { requestId }) => {
      console.error("[MCP-SERVER] Tool github.get_pr_diff called:", {
        requestId,
        args: input
      });

      try {
        const owner = input.owner ?? DEFAULT_OWNER;
        const repo = input.repo ?? DEFAULT_REPO;
        const number = input.number;
        console.log("[MCP-SERVER] github.get_pr_diff GitHub call", {
          owner,
          repo,
          number,
          hasToken: Boolean(GITHUB_TOKEN)
        });
        const response = await callGithub(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
          { Accept: "application/vnd.github.v3.diff" }
        );

        const diff = await response.body.text();
        console.log("[MCP-SERVER] github.get_pr_diff GitHub response", {
          requestId,
          status: response.statusCode,
          bodySnippet: diff.slice(0, 500)
        });

        return {
          content: [
            {
              type: "text",
              text: `Unified diff for PR #${number} in ${owner}/${repo} (length ${diff.length} chars)`
            }
          ],
          structuredContent: {
            diff
          }
        };
      } catch (error) {
        console.error("[MCP-SERVER] Error in github.get_pr_diff:", error);
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while fetching PR diff";
        return {
          content: [
            {
              type: "text",
              text: `GitHub API error while fetching diff for PR #${number} in ${owner}/${repo}: ${message}`
            }
          ],
          isError: true
        };
      }
    }
  );
}

async function main() {
  console.error("[MCP-SERVER] Starting server...");
  registerTools();

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error("[MCP-SERVER] Transport error:", error);
  };

  try {
    await server.connect(transport);
    console.error(
      "[MCP-SERVER] Connected to StdioServerTransport, waiting for requests..."
    );
  } catch (err) {
    console.error("[MCP-SERVER] Error while connecting transport:", err);
    throw err;
  }

  const existingOnMessage = transport.onmessage;
  if (existingOnMessage) {
    transport.onmessage = (message) => {
      console.log(
        "[MCP-SERVER] Received JSON-RPC message:",
        safeSerialize(message)
      );
      return existingOnMessage(message);
    };
  }

  const originalSend = transport.send.bind(transport);
  transport.send = async (message: unknown) => {
    console.log(
      "[MCP-SERVER] Sending JSON-RPC message:",
      safeSerialize(message)
    );
    return originalSend(message);
  };
}

main().catch((err) => {
  console.error("[MCP-SERVER] Fatal error in main:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[MCP-SERVER] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[MCP-SERVER] Unhandled rejection:", reason);
});

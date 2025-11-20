import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { request } from "undici";
import { z } from "zod";

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

async function callGithub(url: string, headers: Record<string, string>) {
  requireToken();

  try {
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
      throw new Error(`GitHub API error: ${response.statusCode} ${snippet}`);
    }

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

  const githubListInputSchema = z
    .object({
      owner: z.string().default(DEFAULT_OWNER).optional(),
      repo: z.string().default(DEFAULT_REPO).optional(),
      state: z.enum(["open", "closed", "all"]).default("open").optional()
    })
    .strict();

  const githubListOutputSchema = z
    .object({
      pullRequests: z
        .array(
          z
            .object({
              number: z.number().int(),
              title: z.string(),
              url: z.string().url(),
              state: z.string()
            })
            .strict()
        )
        .default([])
    })
    .strict();

  const githubGetPrDiffInputSchema = z
    .object({
      owner: z.string().default(DEFAULT_OWNER).optional(),
      repo: z.string().default(DEFAULT_REPO).optional(),
      number: z.number().int().min(1)
    })
    .strict();

  const githubGetPrDiffOutputSchema = z
    .object({
      diff: z.string()
    })
    .strict();

  const fsSaveSummaryInputSchema = z
    .object({
      fileName: z
        .string()
        .describe("File name for the summary, e.g. pr-43-summary.md"),
      content: z
        .string()
        .describe(
          "Markdown content of the summary. Will be written to the file as-is."
        )
    })
    .strict();

  const fsSaveSummaryOutputSchema = z
    .object({
      filePath: z.string().describe("Absolute path to the written file")
    })
    .strict();

  console.error("[MCP-SERVER] About to register tool schemas via Zod");
  console.error(
    "[MCP-SERVER] github.list_pull_requests schema type:",
    githubListInputSchema._def.typeName
  );
  console.error(
    "[MCP-SERVER] github.get_pr_diff schema type:",
    githubGetPrDiffInputSchema._def.typeName
  );
  console.error(
    "[MCP-SERVER] fs.save_summary schema type:",
    fsSaveSummaryInputSchema._def.typeName
  );

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
        const { owner, repo, state } = input;
        const response = await callGithub(
          `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}`,
          { Accept: "application/vnd.github+json" }
        );

        const data = (await response.body.json()) as Array<{
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
        throw error;
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
        throw error;
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
        const { owner, repo, number } = input;
        const response = await callGithub(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
          { Accept: "application/vnd.github.v3.diff" }
        );

        const diff = await response.body.text();

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
        throw error;
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
      console.error("[MCP-SERVER] Received JSON-RPC message:", message);
      return existingOnMessage(message);
    };
  }

  const originalSend = transport.send.bind(transport);
  transport.send = async (message: unknown) => {
    console.error("[MCP-SERVER] Sending JSON-RPC message:", message);
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

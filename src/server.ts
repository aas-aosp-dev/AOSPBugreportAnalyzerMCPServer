import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

server.on("initialized", (params) => {
  console.error("[MCP-SERVER] Initialized with:", JSON.stringify(params, null, 2));
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
    "[MCP-SERVER] Registering tools: github.list_pull_requests, github.get_pr_diff"
  );

  server.registerTool(
    "github.list_pull_requests",
    {
      description: "List pull requests for a GitHub repository",
      inputSchema: z.object({
        owner: z.string().default(DEFAULT_OWNER),
        repo: z.string().default(DEFAULT_REPO),
        state: z.enum(["open", "closed", "all"]).default("open")
      }),
      outputSchema: z.object({
        pullRequests: z.array(
          z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.string()
          })
        )
      })
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
        return {
          pullRequests: data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            state: pr.state
          }))
        };
      } catch (error) {
        console.error("[MCP-SERVER] Error in github.list_pull_requests:", error);
        throw error;
      }
    }
  );

  server.registerTool(
    "github.get_pr_diff",
    {
      description: "Get unified diff for a specific GitHub pull request",
      inputSchema: z.object({
        owner: z.string().default(DEFAULT_OWNER),
        repo: z.string().default(DEFAULT_REPO),
        number: z.number().int().positive()
      }),
      outputSchema: z.object({
        diff: z.string()
      })
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
        return { diff };
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
  await server.connect(transport);
  console.error(
    "[MCP-SERVER] Connected to StdioServerTransport, waiting for requests..."
  );
}

main().catch((err) => {
  console.error("[MCP-SERVER] Fatal error in main:", err);
  process.exit(1);
});

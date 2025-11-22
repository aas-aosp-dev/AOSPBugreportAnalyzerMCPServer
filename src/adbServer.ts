import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

interface AdbDeviceInfo {
  serial: string;
  state: string;
  model: string;
  device: string;
}

type ChunkWithToString = { toString: (encoding?: string) => string };

const server = new McpServer({
  name: "aospbugreportanalyzer-adb-mcp",
  version: "0.1.0"
});

const listDevicesInputSchema = z.object({}).strict();

const listDevicesOutputSchema = z
  .object({
    devices: z.array(
      z
        .object({
          serial: z.string(),
          state: z.string(),
          model: z.string(),
          device: z.string()
        })
        .strict()
    )
  })
  .strict();

const getBugreportInputSchema = z
  .object({
    serial: z
      .string()
      .describe("adb serial of the device (from adb devices)")
  })
  .strict();

const getBugreportOutputSchema = z
  .object({
    filePath: z
      .string()
      .describe("Absolute path to the saved bugreport file")
  })
  .strict();

function registerTools() {
  server.registerTool(
    "adb.list_devices",
    {
      description: "List adb devices with serial, state, model and device name",
      inputSchema: listDevicesInputSchema,
      outputSchema: listDevicesOutputSchema
    },
    async (
      args: unknown,
      { requestId }: RequestHandlerExtra<ServerRequest, ServerNotification>
    ) => {
      console.error("[MCP-ADB] Tool adb.list_devices called, requestId:", requestId);

      try {
        const proc = spawn("adb", ["devices", "-l"]);

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: ChunkWithToString) => {
          stdout += chunk.toString("utf-8");
        });

        proc.stderr.on("data", (chunk: ChunkWithToString) => {
          stderr += chunk.toString("utf-8");
        });

        const exitCode: number = await new Promise((resolve, reject) => {
          proc.on("error", (error: Error) => reject(error));
          proc.on("close", (code: number | null) => resolve(code ?? 0));
        });

        if (exitCode !== 0) {
          console.error(
            "[MCP-ADB] adb devices -l exited with code",
            exitCode,
            "stderr:",
            stderr
          );
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `adb devices -l failed with code ${exitCode}: ${stderr.trim()}`
              }
            ]
          };
        }

        const devices: AdbDeviceInfo[] = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("List of devices"))
          .map((line) => {
            const parts = line.split(/\s+/);
            const serial = parts[0] ?? "";
            const state = parts[1] ?? "";

            let model = "";
            let device = "";

            for (const part of parts.slice(2)) {
              if (part.startsWith("model:")) {
                model = part.slice("model:".length);
              }
              if (part.startsWith("device:")) {
                device = part.slice("device:".length);
              }
            }

            return {
              serial,
              state,
              model,
              device
            };
          });

        return {
          content: [
            {
              type: "text",
              text: `Found ${devices.length} adb device(s)`
            }
          ],
          structuredContent: {
            devices
          }
        };
      } catch (error) {
        console.error("[MCP-ADB] Error in adb.list_devices:", error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to list adb devices: ${message}`
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "adb.get_bugreport",
    {
      description: "Capture a bugreport from the specified adb device",
      inputSchema: getBugreportInputSchema,
      outputSchema: getBugreportOutputSchema
    },
    async (
      args: unknown,
      { requestId }: RequestHandlerExtra<ServerRequest, ServerNotification>
    ) => {
      if (
        !args ||
        typeof args !== "object" ||
        typeof (args as { serial?: unknown }).serial !== "string"
      ) {
        throw new Error("Invalid arguments: 'serial' (string) is required");
      }

      const { serial } = args as { serial: string };

      console.error(
        "[MCP-ADB] Tool adb.get_bugreport called, requestId:",
        requestId,
        "serial:",
        serial
      );

      const bugreportsDir = path.join(process.cwd(), "bugreports");
      await fs.promises.mkdir(bugreportsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `bugreport-${serial}-${timestamp}.txt`;
      const fullPath = path.join(bugreportsDir, fileName);

      const proc = spawn("adb", ["-s", serial, "bugreport"]);
      const writeStream = fs.createWriteStream(fullPath, { encoding: "utf-8" });

      proc.stdout.pipe(writeStream);

      let stderr = "";
      proc.stderr.on("data", (chunk: ChunkWithToString) => {
        stderr += chunk.toString("utf-8");
      });

      const exitCode: number = await new Promise((resolve, reject) => {
        proc.on("error", (error: Error) => reject(error));
        proc.on("close", (code: number | null) => resolve(code ?? 0));
      });

      if (exitCode !== 0) {
        console.error(
          "[MCP-ADB] adb bugreport failed with code",
          exitCode,
          "stderr:",
          stderr
        );
        await fs.promises.rm(fullPath, { force: true });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `adb bugreport failed with code ${exitCode}: ${stderr.trim()}`
            }
          ]
        };
      }

      console.error("[MCP-ADB] Saved bugreport to:", fullPath);

      return {
        content: [
          {
            type: "text",
            text: `Bugreport saved to ${fullPath}`
          }
        ],
        structuredContent: {
          filePath: fullPath
        }
      };
    }
  );

  console.error("[MCP-ADB] Registered tools: adb.list_devices, adb.get_bugreport");
}

async function main() {
  console.error("[MCP-ADB] Starting ADB MCP server...");
  registerTools();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP-ADB] Connected to StdioServerTransport, waiting for requests...");
}

main().catch((err) => {
  console.error("[MCP-ADB] Fatal error in main:", err);
  process.exit(1);
});

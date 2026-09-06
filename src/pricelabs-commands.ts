import {
  deleteDataRepoFile,
  listDataRepoDir,
  loadControlDataRepoConfig,
  readDataRepoJson,
  upsertDataRepoJson,
  type GithubContentItem,
} from "./control-data-repo.js";
import { loadPriceLabsConfig, PriceLabsMcpClient, type McpToolDefinition } from "./pricelabs-mcp.js";

type PriceLabsCommandAction = "list_tools" | "call_tool";

interface PriceLabsCommand {
  id?: string;
  action?: PriceLabsCommandAction;
  toolName?: string;
  arguments?: Record<string, unknown>;
  confirmed?: boolean;
  status?: string;
  createdAt?: string;
  attemptStartedAt?: string;
}

const PENDING_DIR = "commands/pricelabs/pending";
const RESULTS_DIR = "commands/pricelabs/results";
const POLL_MS = 30_000;

function commandIdOf(item: GithubContentItem, command?: PriceLabsCommand): string {
  const raw = String(command?.id || item.name.replace(/\.json$/i, ""));
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function explicitReadOnly(tool: McpToolDefinition | undefined): boolean {
  return tool?.annotations?.readOnlyHint === true;
}

function toolLooksWrite(toolName: string, tool?: McpToolDefinition): boolean {
  if (explicitReadOnly(tool)) return false;
  if (tool?.annotations?.destructiveHint === true) return true;
  const value = toolName.toLowerCase();
  return /(update|set|change|create|delete|remove|accept|apply|refresh|override|write|edit|enable|disable|map|unmap|sync|push|publish|archive)/.test(value);
}

async function executeCommand(client: PriceLabsMcpClient, command: PriceLabsCommand): Promise<unknown> {
  switch (command.action) {
    case "list_tools":
      return { tools: await client.listTools() };

    case "call_tool": {
      const toolName = String(command.toolName || "").trim();
      if (!toolName) throw new Error("toolName is required");
      const tools = await client.listTools();
      const tool = tools.find((entry) => entry.name === toolName);
      if (!tool) throw new Error(`Unknown PriceLabs MCP tool: ${toolName}`);
      const isWrite = toolLooksWrite(toolName, tool);
      if (isWrite && command.confirmed !== true) {
        throw new Error(`Write command rejected: confirmed=true is required for ${toolName}`);
      }
      const output = await client.callTool(toolName, command.arguments ?? {});
      return { toolName, isWrite, output };
    }

    default:
      throw new Error(`Unsupported PriceLabs action: ${String(command.action || "")}`);
  }
}

let running = false;

export async function processPriceLabsCommands(): Promise<void> {
  const priceLabs = loadPriceLabsConfig();
  const repo = loadControlDataRepoConfig();
  if (!priceLabs || !repo || running) return;
  running = true;

  try {
    const client = new PriceLabsMcpClient(priceLabs);
    const items = (await listDataRepoDir(repo, PENDING_DIR))
      .filter((item) => item.type === "file" && item.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 10);

    for (const item of items) {
      let currentSha = item.sha;
      let command: PriceLabsCommand | undefined;
      let commandId = commandIdOf(item);

      try {
        const loaded = await readDataRepoJson<PriceLabsCommand>(repo, item.path);
        if (!loaded) continue;
        command = loaded.value;
        currentSha = loaded.sha;
        commandId = commandIdOf(item, command);
        const resultPath = `${RESULTS_DIR}/${commandId}.json`;

        const existing = await readDataRepoJson<unknown>(repo, resultPath);
        if (existing) {
          await deleteDataRepoFile(repo, item.path, currentSha, `Remove already processed PriceLabs command ${commandId}`);
          continue;
        }

        // Do not retry a write after an uncertain process crash. Some PriceLabs writes
        // may be non-idempotent (e.g. accepting a recommendation), so duplicate execution
        // is worse than asking for verification.
        if (command.status === "sending") {
          await upsertDataRepoJson(repo, resultPath, {
            id: commandId,
            ok: false,
            uncertain: true,
            action: command.action,
            toolName: command.toolName,
            processedAt: new Date().toISOString(),
            error: "A previous PriceLabs write may already have reached the MCP server. It was not retried automatically to avoid a duplicate write.",
          }, `Record uncertain PriceLabs command ${commandId}`);
          await deleteDataRepoFile(repo, item.path, currentSha, `Archive uncertain PriceLabs command ${commandId}`);
          continue;
        }

        let shouldMarkSending = false;
        if (command.action === "call_tool" && command.toolName) {
          const tools = await client.listTools();
          const tool = tools.find((entry) => entry.name === command?.toolName);
          shouldMarkSending = toolLooksWrite(command.toolName, tool);
        }

        if (shouldMarkSending) {
          const marked: PriceLabsCommand = {
            ...command,
            id: commandId,
            status: "sending",
            attemptStartedAt: new Date().toISOString(),
          };
          currentSha = (await upsertDataRepoJson(repo, item.path, marked, `Mark PriceLabs command ${commandId} as sending`)) ?? currentSha;
          command = marked;
        }

        const output = await executeCommand(client, command);
        await upsertDataRepoJson(repo, resultPath, {
          id: commandId,
          ok: true,
          action: command.action,
          processedAt: new Date().toISOString(),
          output,
        }, `Complete PriceLabs command ${commandId}`);
        await deleteDataRepoFile(repo, item.path, currentSha, `Remove completed PriceLabs command ${commandId}`);
        console.error(`[pricelabs-command] OK — ${command.action}${command.toolName ? `/${command.toolName}` : ""} (${commandId})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await upsertDataRepoJson(repo, `${RESULTS_DIR}/${commandId}.json`, {
            id: commandId,
            ok: false,
            action: command?.action,
            toolName: command?.toolName,
            processedAt: new Date().toISOString(),
            error: message,
          }, `Fail PriceLabs command ${commandId}`);
          await deleteDataRepoFile(repo, item.path, currentSha, `Remove failed PriceLabs command ${commandId}`);
        } catch (archiveErr) {
          console.error(`[pricelabs-command] archive FAILED — ${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}`);
        }
        console.error(`[pricelabs-command] FAILED — ${commandId}: ${message}`);
      }
    }
  } catch (err) {
    console.error(`[pricelabs-command] poll FAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

export function startPriceLabsCommandProcessor(): void {
  const priceLabs = loadPriceLabsConfig();
  const repo = loadControlDataRepoConfig();
  if (!priceLabs || !repo) {
    console.error("[pricelabs-command] disabled (PriceLabs OAuth or GitHub sync credentials missing)");
    return;
  }
  void processPriceLabsCommands();
  setInterval(() => void processPriceLabsCommands(), POLL_MS).unref();
  console.error(`[pricelabs-command] enabled — polling ${repo.repo}/${PENDING_DIR} every ${POLL_MS / 1000}s`);
}

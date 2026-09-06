import { loadControlDataRepoConfig, upsertDataRepoJson } from "./control-data-repo.js";
import { loadPriceLabsConfig, PriceLabsMcpClient, type McpToolDefinition } from "./pricelabs-mcp.js";

function requiredFields(tool: McpToolDefinition): string[] {
  const raw = tool.inputSchema?.required;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

function safeSnapshotTool(tool: McpToolDefinition): boolean {
  const name = tool.name.toLowerCase();
  const readOnly = tool.annotations?.readOnlyHint === true || /^(get|list|search|find|read)_/.test(name);
  const writeLike = /(update|set|change|create|delete|remove|accept|apply|refresh|override|write|edit|enable|disable|map|unmap|sync|push|publish|archive)/.test(name);
  if (!readOnly || writeLike || requiredFields(tool).length > 0) return false;
  // Keep automatic snapshots small and account-oriented. Heavy market/neighbourhood
  // analysis remains on-demand through the command queue.
  return /(listing|portfolio|group)/.test(name) && !/(market|neigh|str_|reservation|booking|schema|profile)/.test(name);
}

let running = false;

export async function runPriceLabsSync(): Promise<void> {
  const priceLabs = loadPriceLabsConfig();
  const repo = loadControlDataRepoConfig();
  if (!priceLabs || !repo || running) return;
  running = true;

  try {
    const syncedAt = new Date().toISOString();
    const client = new PriceLabsMcpClient(priceLabs);
    const tools = await client.listTools();

    await upsertDataRepoJson(repo, "pricelabs/tools.json", {
      syncedAt,
      mcpUrl: priceLabs.mcpUrl,
      count: tools.length,
      data: tools,
    }, "Sync PriceLabs MCP tool catalog");

    const snapshots: Record<string, unknown> = {};
    const snapshotErrors: Record<string, string> = {};
    const candidates = tools.filter(safeSnapshotTool).slice(0, 6);
    for (const tool of candidates) {
      try {
        snapshots[tool.name] = await client.callTool(tool.name, {});
      } catch (err) {
        snapshotErrors[tool.name] = err instanceof Error ? err.message : String(err);
      }
    }

    if (Object.keys(snapshots).length > 0) {
      await upsertDataRepoJson(repo, "pricelabs/account-snapshot.json", {
        syncedAt,
        tools: Object.keys(snapshots),
        data: snapshots,
      }, "Sync PriceLabs account snapshot");
    }

    await upsertDataRepoJson(repo, "reports/pricelabs-sync-status.json", {
      syncedAt,
      ok: true,
      mcpUrl: priceLabs.mcpUrl,
      toolCount: tools.length,
      automaticSnapshotTools: Object.keys(snapshots),
      snapshotErrors,
      commandQueue: "commands/pricelabs/pending",
      note: "PriceLabs is connected through its MCP OAuth client. The full MCP tool catalog is stored in pricelabs/tools.json; any tool can be executed on demand through the PriceLabs command queue.",
    }, "Update PriceLabs sync status");

    console.error(`[pricelabs-sync] OK — ${tools.length} tools, ${Object.keys(snapshots).length} account snapshots`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pricelabs-sync] FAILED: ${message}`);
    try {
      await upsertDataRepoJson(repo, "reports/pricelabs-sync-status.json", {
        syncedAt: new Date().toISOString(),
        ok: false,
        error: message,
      }, "Record PriceLabs sync failure");
    } catch {
      // Keep the original PriceLabs error as the useful log line.
    }
  } finally {
    running = false;
  }
}

export function startPriceLabsSync(): void {
  const priceLabs = loadPriceLabsConfig();
  const repo = loadControlDataRepoConfig();
  if (!priceLabs || !repo) {
    console.error("[pricelabs-sync] disabled (set PriceLabs OAuth and GitHub sync credentials)");
    return;
  }
  const parsed = Number(process.env.PRICELABS_SYNC_INTERVAL_MINUTES || process.env.GITHUB_SYNC_INTERVAL_MINUTES || "30");
  const intervalMinutes = Number.isFinite(parsed) && parsed >= 5 ? parsed : 30;
  void runPriceLabsSync();
  setInterval(() => void runPriceLabsSync(), intervalMinutes * 60_000).unref();
  console.error(`[pricelabs-sync] enabled — every ${intervalMinutes} min -> ${repo.repo}`);
}

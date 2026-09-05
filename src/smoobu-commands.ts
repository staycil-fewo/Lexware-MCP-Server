import { loadSmoobuConfig, smoobuGet, smoobuPost, type SmoobuConfig } from "./smoobu-sync.js";

type SmoobuCommandAction = "send_guest_message" | "get_guest_messages" | "send_host_message";

interface SmoobuCommand {
  id?: string;
  action?: SmoobuCommandAction;
  reservationId?: number | string;
  subject?: string;
  messageBody?: string;
  internal?: boolean;
  confirmed?: boolean;
  createdAt?: string;
  status?: string;
  attemptStartedAt?: string;
}

interface GithubItem {
  name: string;
  path: string;
  sha: string;
  type: string;
}

interface MessagePage {
  page_count?: number;
  page_size?: number;
  total_items?: number;
  page?: number;
  messages?: Array<Record<string, unknown>>;
}

const PENDING_DIR = "commands/smoobu/pending";
const RESULTS_DIR = "commands/smoobu/results";
const POLL_MS = 30_000;

function githubHeaders(cfg: SmoobuConfig) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "staycil-smoobu-command-processor",
  };
}

function githubContentUrl(cfg: SmoobuConfig, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${cfg.repo}/contents/${encoded}`;
}

async function listPending(cfg: SmoobuConfig): Promise<GithubItem[]> {
  const response = await fetch(`${githubContentUrl(cfg, PENDING_DIR)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: githubHeaders(cfg),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`GitHub pending list ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const items = (await response.json()) as GithubItem[];
  return items.filter((item) => item.type === "file" && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
}

async function readJsonFile(cfg: SmoobuConfig, item: GithubItem): Promise<SmoobuCommand> {
  const response = await fetch(`${githubContentUrl(cfg, item.path)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: githubHeaders(cfg),
  });
  if (!response.ok) throw new Error(`GitHub command read ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (!payload.content || payload.encoding !== "base64") throw new Error("Command file has no base64 content");
  return JSON.parse(Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8")) as SmoobuCommand;
}

async function pathExists(cfg: SmoobuConfig, path: string): Promise<boolean> {
  const response = await fetch(`${githubContentUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: githubHeaders(cfg),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub lookup ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return true;
}

async function upsertJson(cfg: SmoobuConfig, path: string, value: unknown, message: string): Promise<string | undefined> {
  const base = githubContentUrl(cfg, path);
  let sha: string | undefined;
  const lookup = await fetch(`${base}?ref=${encodeURIComponent(cfg.branch)}`, { headers: githubHeaders(cfg) });
  if (lookup.ok) sha = ((await lookup.json()) as { sha?: string }).sha;
  else if (lookup.status !== 404) throw new Error(`GitHub lookup ${lookup.status}: ${(await lookup.text()).slice(0, 500)}`);

  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64");
  const response = await fetch(base, {
    method: "PUT",
    headers: { ...githubHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!response.ok) throw new Error(`GitHub write ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const data = (await response.json()) as { content?: { sha?: string } };
  return data.content?.sha;
}

async function deleteFile(cfg: SmoobuConfig, path: string, sha: string, message: string): Promise<void> {
  const response = await fetch(githubContentUrl(cfg, path), {
    method: "DELETE",
    headers: { ...githubHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: cfg.branch }),
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`GitHub delete ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

async function allGuestMessages(cfg: SmoobuConfig, reservationId: number): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 200; page++) {
    const response = await smoobuGet<MessagePage>(cfg, `/api/reservations/${reservationId}/messages`, {
      page,
      onlyRelatedToGuest: true,
    });
    rows.push(...(response.messages ?? []));
    if (page >= (response.page_count ?? 1)) break;
  }
  return rows;
}

function reservationIdOf(command: SmoobuCommand): number {
  const id = Number(command.reservationId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("reservationId must be a positive integer");
  return id;
}

async function executeCommand(cfg: SmoobuConfig, command: SmoobuCommand): Promise<unknown> {
  const reservationId = reservationIdOf(command);
  switch (command.action) {
    case "get_guest_messages":
      return {
        reservationId,
        messages: await allGuestMessages(cfg, reservationId),
      };

    case "send_guest_message": {
      if (command.confirmed !== true) throw new Error("Write command rejected: confirmed=true is required");
      const messageBody = String(command.messageBody ?? "").trim();
      if (!messageBody) throw new Error("messageBody is required");
      const subject = typeof command.subject === "string" ? command.subject : "";
      const response = await smoobuPost<Record<string, unknown>>(
        cfg,
        `/api/reservations/${reservationId}/messages/send-message-to-guest`,
        { subject, messageBody },
      );
      return { reservationId, subject, messageBody, response };
    }

    case "send_host_message": {
      if (command.confirmed !== true) throw new Error("Write command rejected: confirmed=true is required");
      const messageBody = String(command.messageBody ?? "").trim();
      if (!messageBody) throw new Error("messageBody is required");
      const subject = typeof command.subject === "string" ? command.subject : "";
      const response = await smoobuPost<Record<string, unknown>>(
        cfg,
        `/api/reservations/${reservationId}/messages/send-message-to-host`,
        { subject, messageBody, internal: command.internal === true },
      );
      return { reservationId, subject, messageBody, internal: command.internal === true, response };
    }

    default:
      throw new Error(`Unsupported action: ${String(command.action ?? "")}`);
  }
}

let running = false;

export async function processSmoobuCommands(): Promise<void> {
  const cfg = loadSmoobuConfig();
  if (!cfg || running) return;
  running = true;
  try {
    const items = (await listPending(cfg)).slice(0, 10);
    for (const item of items) {
      let currentSha = item.sha;
      let command: SmoobuCommand | undefined;
      let commandId = item.name.replace(/\.json$/i, "");
      try {
        command = await readJsonFile(cfg, item);
        commandId = String(command.id || commandId).replace(/[^a-zA-Z0-9._-]/g, "_");
        const resultPath = `${RESULTS_DIR}/${commandId}.json`;

        if (await pathExists(cfg, resultPath)) {
          await deleteFile(cfg, item.path, currentSha, `Remove already processed Smoobu command ${commandId}`);
          continue;
        }

        // A command left in "sending" state means the process may have died after Smoobu accepted it.
        // Never auto-resend in that state; return the current conversation for manual verification instead.
        if (command.status === "sending") {
          const reservationId = reservationIdOf(command);
          const messages = await allGuestMessages(cfg, reservationId).catch(() => []);
          await upsertJson(cfg, resultPath, {
            id: commandId,
            ok: false,
            uncertain: true,
            action: command.action,
            reservationId,
            processedAt: new Date().toISOString(),
            error: "Previous send attempt may already have reached Smoobu. It was not resent automatically to avoid duplicate guest messages.",
            messages,
          }, `Record uncertain Smoobu command ${commandId}`);
          await deleteFile(cfg, item.path, currentSha, `Archive uncertain Smoobu command ${commandId}`);
          continue;
        }

        if (command.action === "send_guest_message" || command.action === "send_host_message") {
          const marked = { ...command, id: commandId, status: "sending", attemptStartedAt: new Date().toISOString() };
          currentSha = (await upsertJson(cfg, item.path, marked, `Mark Smoobu command ${commandId} as sending`)) ?? currentSha;
          command = marked;
        }

        const output = await executeCommand(cfg, command);
        await upsertJson(cfg, resultPath, {
          id: commandId,
          ok: true,
          action: command.action,
          processedAt: new Date().toISOString(),
          output,
        }, `Complete Smoobu command ${commandId}`);
        await deleteFile(cfg, item.path, currentSha, `Remove completed Smoobu command ${commandId}`);
        console.error(`[smoobu-command] OK — ${command.action} (${commandId})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await upsertJson(cfg, `${RESULTS_DIR}/${commandId}.json`, {
            id: commandId,
            ok: false,
            action: command?.action,
            processedAt: new Date().toISOString(),
            error: message,
          }, `Fail Smoobu command ${commandId}`);
          await deleteFile(cfg, item.path, currentSha, `Remove failed Smoobu command ${commandId}`);
        } catch (archiveErr) {
          console.error(`[smoobu-command] archive FAILED — ${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}`);
        }
        console.error(`[smoobu-command] FAILED — ${commandId}: ${message}`);
      }
    }
  } catch (err) {
    console.error(`[smoobu-command] poll FAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

export function startSmoobuCommandProcessor(): void {
  const cfg = loadSmoobuConfig();
  if (!cfg) {
    console.error("[smoobu-command] disabled (Smoobu/GitHub sync credentials missing)");
    return;
  }
  void processSmoobuCommands();
  setInterval(() => void processSmoobuCommands(), POLL_MS).unref();
  console.error(`[smoobu-command] enabled — polling ${cfg.repo}/${PENDING_DIR} every ${POLL_MS / 1000}s`);
}

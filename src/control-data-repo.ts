export interface ControlDataRepoConfig {
  repo: string;
  token: string;
  branch: string;
}

export interface GithubContentItem {
  name: string;
  path: string;
  sha: string;
  type: string;
}

export function loadControlDataRepoConfig(): ControlDataRepoConfig | null {
  const repo = process.env.GITHUB_SYNC_REPO?.trim();
  const token = process.env.GITHUB_SYNC_TOKEN?.trim();
  if (!repo || !token) return null;
  return {
    repo,
    token,
    branch: process.env.GITHUB_SYNC_BRANCH?.trim() || "main",
  };
}

function headers(cfg: ControlDataRepoConfig): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "staycil-control-hub",
  };
}

function contentUrl(cfg: ControlDataRepoConfig, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${cfg.repo}/contents/${encoded}`;
}

export async function listDataRepoDir(cfg: ControlDataRepoConfig, path: string): Promise<GithubContentItem[]> {
  const response = await fetch(`${contentUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg),
  });
  if (response.status === 404) return [];
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub list ${response.status}: ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text) as GithubContentItem[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function readDataRepoJson<T>(cfg: ControlDataRepoConfig, path: string): Promise<{ value: T; sha: string } | null> {
  const response = await fetch(`${contentUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg),
  });
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub read ${response.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { content?: string; encoding?: string; sha?: string };
  if (!payload.content || payload.encoding !== "base64" || !payload.sha) throw new Error(`GitHub ${path} did not contain base64 file content`);
  const decoded = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { value: JSON.parse(decoded) as T, sha: payload.sha };
}

export async function upsertDataRepoJson(
  cfg: ControlDataRepoConfig,
  path: string,
  value: unknown,
  message = `Update control data: ${path}`,
): Promise<string | undefined> {
  const base = contentUrl(cfg, path);
  let sha: string | undefined;
  const lookup = await fetch(`${base}?ref=${encodeURIComponent(cfg.branch)}`, { headers: headers(cfg) });
  if (lookup.ok) sha = ((await lookup.json()) as { sha?: string }).sha;
  else if (lookup.status !== 404) throw new Error(`GitHub lookup ${lookup.status}: ${(await lookup.text()).slice(0, 500)}`);

  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64");
  const response = await fetch(base, {
    method: "PUT",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub write ${response.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { content?: { sha?: string } };
  return payload.content?.sha;
}

export async function deleteDataRepoFile(
  cfg: ControlDataRepoConfig,
  path: string,
  sha: string,
  message = `Delete control data: ${path}`,
): Promise<void> {
  const response = await fetch(contentUrl(cfg, path), {
    method: "DELETE",
    headers: { ...headers(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: cfg.branch }),
  });
  if (response.status === 404) return;
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub delete ${response.status}: ${text.slice(0, 500)}`);
}

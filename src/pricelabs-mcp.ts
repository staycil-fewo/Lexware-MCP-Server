type JsonObject = Record<string, unknown>;

interface OAuthProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface OAuthAuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface PriceLabsConfig {
  mcpUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenEndpoint?: string;
  scopes?: string;
  tokenAuthMethod?: "client_secret_basic" | "client_secret_post";
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
  annotations?: JsonObject;
}

interface RpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: number | string | null;
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
}

interface ToolListResult {
  tools?: McpToolDefinition[];
  nextCursor?: string;
}

interface AccessTokenState {
  token: string;
  expiresAt: number;
}

const DEFAULT_MCP_URL = "https://mcp.pricelabs.co/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function loadPriceLabsConfig(): PriceLabsConfig | null {
  const clientId = clean(process.env.PRICELABS_MCP_CLIENT_ID);
  const clientSecret = clean(process.env.PRICELABS_MCP_CLIENT_SECRET);
  const refreshToken = clean(process.env.PRICELABS_MCP_REFRESH_TOKEN);
  if (!clientId || !clientSecret || !refreshToken) return null;

  const tokenAuthRaw = clean(process.env.PRICELABS_OAUTH_TOKEN_AUTH_METHOD);
  const tokenAuthMethod = tokenAuthRaw === "client_secret_basic" || tokenAuthRaw === "client_secret_post"
    ? tokenAuthRaw
    : undefined;

  return {
    mcpUrl: clean(process.env.PRICELABS_MCP_URL) || DEFAULT_MCP_URL,
    clientId,
    clientSecret,
    refreshToken,
    tokenEndpoint: clean(process.env.PRICELABS_OAUTH_TOKEN_URL),
    scopes: clean(process.env.PRICELABS_OAUTH_SCOPES),
    tokenAuthMethod,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`OAuth metadata ${response.status} from ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

function protectedResourceCandidates(resourceUrl: string): string[] {
  const resource = new URL(resourceUrl);
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  return unique([
    `${resource.origin}/.well-known/oauth-protected-resource${path}`,
    `${resource.origin}/.well-known/oauth-protected-resource`,
  ]);
}

function authMetadataCandidates(issuerUrl: string): string[] {
  const issuer = new URL(issuerUrl);
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const trimmed = issuerUrl.replace(/\/$/, "");
  return unique([
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${trimmed}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${trimmed}/.well-known/openid-configuration`,
  ]);
}

export async function discoverPriceLabsOAuth(mcpUrl = DEFAULT_MCP_URL): Promise<{
  protectedResource?: OAuthProtectedResourceMetadata;
  authorizationServer: OAuthAuthorizationServerMetadata;
}> {
  let protectedResource: OAuthProtectedResourceMetadata | undefined;
  let protectedLastError: unknown;

  for (const candidate of protectedResourceCandidates(mcpUrl)) {
    try {
      protectedResource = await getJson<OAuthProtectedResourceMetadata>(candidate);
      if (protectedResource.authorization_servers?.length) break;
    } catch (err) {
      protectedLastError = err;
    }
  }

  const authorizationServers = protectedResource?.authorization_servers ?? [];
  const fallbackIssuer = new URL(mcpUrl).origin;
  const issuers = unique([...authorizationServers, fallbackIssuer]);
  let authLastError: unknown;

  for (const issuer of issuers) {
    for (const candidate of authMetadataCandidates(issuer)) {
      try {
        const authorizationServer = await getJson<OAuthAuthorizationServerMetadata>(candidate);
        if (authorizationServer.token_endpoint) {
          return { protectedResource, authorizationServer };
        }
      } catch (err) {
        authLastError = err;
      }
    }
  }

  const details = authLastError instanceof Error
    ? authLastError.message
    : protectedLastError instanceof Error
      ? protectedLastError.message
      : "no OAuth metadata endpoint responded";
  throw new Error(`Could not discover PriceLabs OAuth metadata: ${details}`);
}

async function requestTokenWithMethod(
  tokenEndpoint: string,
  cfg: PriceLabsConfig,
  method: "client_secret_basic" | "client_secret_post",
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
  });
  if (cfg.scopes) body.set("scope", cfg.scopes);
  body.set("resource", cfg.mcpUrl);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (method === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64")}`;
  } else {
    body.set("client_id", cfg.clientId);
    body.set("client_secret", cfg.clientSecret);
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PriceLabs OAuth token ${response.status} (${method}): ${text.slice(0, 400)}`);
  }
  const data = JSON.parse(text) as OAuthTokenResponse;
  if (!data.access_token) throw new Error("PriceLabs token endpoint returned no access_token");
  return data;
}

async function refreshPriceLabsAccessToken(cfg: PriceLabsConfig): Promise<AccessTokenState> {
  let metadata: OAuthAuthorizationServerMetadata | undefined;
  let tokenEndpoint = cfg.tokenEndpoint;
  if (!tokenEndpoint || !cfg.tokenAuthMethod) {
    const discovered = await discoverPriceLabsOAuth(cfg.mcpUrl);
    metadata = discovered.authorizationServer;
    tokenEndpoint ||= metadata.token_endpoint;
  }
  if (!tokenEndpoint) throw new Error("PriceLabs OAuth token endpoint is unavailable");

  const advertised = metadata?.token_endpoint_auth_methods_supported ?? [];
  const methods = unique([
    cfg.tokenAuthMethod,
    advertised.includes("client_secret_post") ? "client_secret_post" : undefined,
    advertised.includes("client_secret_basic") ? "client_secret_basic" : undefined,
    "client_secret_post",
    "client_secret_basic",
  ]) as Array<"client_secret_basic" | "client_secret_post">;

  let lastError: unknown;
  for (const method of methods) {
    try {
      const token = await requestTokenWithMethod(tokenEndpoint, cfg, method);
      const ttlSeconds = Number.isFinite(Number(token.expires_in)) ? Math.max(60, Number(token.expires_in)) : 3600;
      // Refresh at least one minute before expiry.
      return { token: token.access_token, expiresAt: Date.now() + Math.max(60, ttlSeconds - 60) * 1000 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PriceLabs OAuth refresh failed");
}

function parseSse(text: string): RpcResponse[] {
  const responses: RpcResponse[] = [];
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      responses.push(JSON.parse(data) as RpcResponse);
    } catch {
      // Ignore keep-alive / non-JSON SSE events.
    }
  }
  return responses;
}

function parseRpcPayload(text: string, contentType: string): RpcResponse[] {
  if (!text.trim()) return [];
  if (contentType.includes("text/event-stream")) return parseSse(text);
  const parsed = JSON.parse(text) as RpcResponse | RpcResponse[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class PriceLabsMcpClient {
  private access?: AccessTokenState;
  private sessionId?: string;
  private initialized = false;
  private nextId = 1;

  constructor(private readonly cfg: PriceLabsConfig) {}

  private async accessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.expiresAt > Date.now()) return this.access.token;
    this.access = await refreshPriceLabsAccessToken(this.cfg);
    return this.access.token;
  }

  private async rawRpc(
    method: string,
    params?: JsonObject,
    options: { notification?: boolean; retryAuth?: boolean } = {},
  ): Promise<RpcResponse | undefined> {
    const notification = options.notification === true;
    const id = notification ? undefined : this.nextId++;
    const payload: JsonObject = {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
      ...(id !== undefined ? { id } : {}),
    };

    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const response = await fetch(this.cfg.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (response.status === 401 && options.retryAuth !== false) {
      await this.accessToken(true);
      this.initialized = false;
      this.sessionId = undefined;
      return this.rawRpc(method, params, { ...options, retryAuth: false });
    }

    const text = await response.text();
    if (!response.ok) throw new Error(`PriceLabs MCP ${response.status}: ${text.slice(0, 500)}`);
    const returnedSession = response.headers.get("mcp-session-id") || response.headers.get("Mcp-Session-Id");
    if (returnedSession) this.sessionId = returnedSession;
    if (notification) return undefined;

    const messages = parseRpcPayload(text, response.headers.get("content-type") || "");
    const matched = messages.find((message) => message.id === id) ?? messages.find((message) => message.error || message.result !== undefined);
    if (!matched) throw new Error(`PriceLabs MCP returned no JSON-RPC response for ${method}`);
    if (matched.error) throw new Error(`PriceLabs MCP ${method}: ${matched.error.message || "unknown JSON-RPC error"}`);
    return matched;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const response = await this.rawRpc("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "staycil-control-hub", version: "1.0.0" },
    });
    if (!response?.result) throw new Error("PriceLabs MCP initialize returned no result");
    await this.rawRpc("notifications/initialized", undefined, { notification: true });
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.ensureInitialized();
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.rawRpc("tools/list", cursor ? { cursor } : undefined);
      const result = response?.result as ToolListResult | undefined;
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool<T = unknown>(name: string, args: JsonObject = {}): Promise<T> {
    await this.ensureInitialized();
    const response = await this.rawRpc("tools/call", { name, arguments: args });
    return response?.result as T;
  }
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  loadControlDataRepoConfig,
  readDataRepoJson,
  upsertDataRepoJson,
} from "./control-data-repo.js";

type EncryptedTokenVault = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: string;
};

const VAULT_PATH = "secrets/pricelabs-refresh-token.enc.json";
const originalFetch = globalThis.fetch.bind(globalThis);

let cachedRefreshToken: string | undefined;
let vaultLoaded = false;
let vaultLoadPromise: Promise<void> | undefined;
let refreshLock: Promise<void> = Promise.resolve();

function encryptionKey(): Buffer | null {
  const explicit = process.env.PRICELABS_TOKEN_ENCRYPTION_KEY?.trim();
  if (explicit) {
    const decoded = Buffer.from(explicit, "base64");
    if (decoded.length === 32) return decoded;
    return createHash("sha256").update(explicit, "utf8").digest();
  }

  // Reuse existing server-only secret material as key derivation input so the
  // encrypted vault can live safely in the private control-data repo without
  // introducing another mandatory environment variable.
  const githubToken = process.env.GITHUB_SYNC_TOKEN?.trim();
  if (!githubToken) return null;
  return createHash("sha256")
    .update("staycil-pricelabs-token-v1\0", "utf8")
    .update(githubToken, "utf8")
    .digest();
}

function encryptToken(token: string, key: Buffer): EncryptedTokenVault {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

function decryptToken(vault: EncryptedTokenVault, key: Buffer): string {
  if (vault.version !== 1 || vault.algorithm !== "aes-256-gcm") {
    throw new Error("unsupported PriceLabs token vault format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(vault.iv, "base64"));
  decipher.setAuthTag(Buffer.from(vault.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(vault.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function loadVaultToken(): Promise<void> {
  if (vaultLoaded) return;
  if (vaultLoadPromise) return vaultLoadPromise;

  vaultLoadPromise = (async () => {
    try {
      const repo = loadControlDataRepoConfig();
      const key = encryptionKey();
      if (!repo || !key) return;
      const stored = await readDataRepoJson<EncryptedTokenVault>(repo, VAULT_PATH);
      if (!stored) return;
      cachedRefreshToken = decryptToken(stored.value, key).trim() || undefined;
    } catch (err) {
      console.error(`[pricelabs-oauth] token vault read failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      vaultLoaded = true;
    }
  })();

  return vaultLoadPromise;
}

async function persistVaultToken(token: string): Promise<void> {
  if (!token || token === cachedRefreshToken) return;
  cachedRefreshToken = token;
  const repo = loadControlDataRepoConfig();
  const key = encryptionKey();
  if (!repo || !key) {
    console.error("[pricelabs-oauth] refresh token rotated but encrypted persistence is unavailable");
    return;
  }
  try {
    await upsertDataRepoJson(
      repo,
      VAULT_PATH,
      encryptToken(token, key),
      "Persist encrypted PriceLabs OAuth refresh token",
    );
    console.error("[pricelabs-oauth] refresh-token rotation persisted (encrypted)");
  } catch (err) {
    console.error(`[pricelabs-oauth] token vault write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function tokenEndpointMatches(url: URL): boolean {
  const configured = process.env.PRICELABS_OAUTH_TOKEN_URL?.trim();
  if (configured) {
    try {
      const expected = new URL(configured);
      return expected.origin === url.origin && expected.pathname === url.pathname;
    } catch {
      // Fall through to the PriceLabs-host check.
    }
  }
  return url.hostname === "pricelabs.co" || url.hostname.endsWith(".pricelabs.co");
}

function bodyParams(init?: RequestInit): URLSearchParams | null {
  const body = init?.body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  return null;
}

async function inspectAndPersistRotation(response: Response): Promise<void> {
  if (!response.ok) return;
  try {
    const payload = await response.clone().json() as { refresh_token?: unknown };
    if (typeof payload.refresh_token === "string" && payload.refresh_token.trim()) {
      await persistVaultToken(payload.refresh_token.trim());
    }
  } catch {
    // Token endpoint responses are expected to be JSON; leave non-JSON untouched.
  }
}

async function performTokenFetch(
  input: string | URL | Request,
  init: RequestInit,
  params: URLSearchParams,
): Promise<Response> {
  await loadVaultToken();

  const originalToken = params.get("refresh_token") || "";
  const vaultToken = cachedRefreshToken;
  const usingVault = Boolean(vaultToken && vaultToken !== originalToken);
  if (usingVault && vaultToken) params.set("refresh_token", vaultToken);

  const response = await originalFetch(input, { ...init, body: params.toString() });
  if (response.ok) {
    await inspectAndPersistRotation(response);
    return response;
  }

  // A freshly re-authorized token may have been placed in Render while the vault
  // still contains an older token. If the vault candidate is rejected, retry once
  // with the request's original token and then replace the vault on success.
  if (usingVault && originalToken && response.status === 400) {
    const retryParams = new URLSearchParams(params);
    retryParams.set("refresh_token", originalToken);
    const retry = await originalFetch(input, { ...init, body: retryParams.toString() });
    if (retry.ok) await inspectAndPersistRotation(retry);
    return retry;
  }

  return response;
}

const patchedFetch: typeof fetch = async (input, init) => {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return originalFetch(input, init);
  }

  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST" || !tokenEndpointMatches(url)) return originalFetch(input, init);

  const params = bodyParams(init);
  if (!params || params.get("grant_type") !== "refresh_token" || !params.get("refresh_token")) {
    return originalFetch(input, init);
  }

  // Serialize refreshes so multiple MCP clients cannot spend the same rotating
  // refresh token concurrently.
  let release!: () => void;
  const previous = refreshLock;
  refreshLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await performTokenFetch(input, init ?? {}, params);
  } finally {
    release();
  }
};

globalThis.fetch = patchedFetch;

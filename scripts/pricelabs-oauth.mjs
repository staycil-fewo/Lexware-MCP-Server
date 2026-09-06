#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const DEFAULT_MCP_URL = "https://mcp.pricelabs.co/mcp";
const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function clean(value) {
  const v = String(value || "").trim();
  return v || undefined;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function promptLine(label) {
  process.stdout.write(label);
  return await new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const onData = (chunk) => {
      const text = String(chunk);
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(text.slice(0, nl).replace(/\r$/, "").trim());
    };
    process.stdin.on("data", onData);
  });
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return promptLine(label);
  }
  process.stdout.write(label);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      const ch = String(chunk);
      if (ch === "\u0003") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }
      if (ch === "\r" || ch === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} from ${url}: ${text.slice(0, 250)}`);
  return JSON.parse(text);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function protectedResourceCandidates(resourceUrl) {
  const resource = new URL(resourceUrl);
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  return unique([
    `${resource.origin}/.well-known/oauth-protected-resource${path}`,
    `${resource.origin}/.well-known/oauth-protected-resource`,
  ]);
}

function authMetadataCandidates(issuerUrl) {
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

async function discoverOAuth(mcpUrl) {
  let protectedResource;
  for (const url of protectedResourceCandidates(mcpUrl)) {
    try {
      protectedResource = await getJson(url);
      if (protectedResource?.authorization_servers?.length) break;
    } catch {}
  }

  const issuers = unique([...(protectedResource?.authorization_servers || []), new URL(mcpUrl).origin]);
  let lastError;
  for (const issuer of issuers) {
    for (const url of authMetadataCandidates(issuer)) {
      try {
        const auth = await getJson(url);
        if (auth.authorization_endpoint && auth.token_endpoint) return { protectedResource, auth, metadataUrl: url };
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError || new Error("Could not discover PriceLabs OAuth endpoints");
}

function openBrowser(url) {
  if (process.argv.includes("--no-open")) return false;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForAuthorizationCode(redirectUri, expectedState) {
  const uri = new URL(redirectUri);
  const port = Number(uri.port || 80);
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);
        if (url.pathname !== uri.pathname) {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        const description = url.searchParams.get("error_description");
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (state !== expectedState) throw new Error("OAuth state mismatch");
        if (error) throw new Error(`PriceLabs authorization failed: ${error}${description ? ` — ${description}` : ""}`);
        if (!code) throw new Error("PriceLabs callback contained no authorization code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>PriceLabs verbunden ✅</h2><p>Du kannst dieses Fenster schließen und zum Terminal zurückgehen.</p>");
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
        server.close();
        reject(err);
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`\nCallback wartet auf ${redirectUri}`);
    });
  });
}

async function exchangeCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri, codeVerifier, mcpUrl, scopes, advertisedMethods }) {
  const methods = unique([
    ...(advertisedMethods || []).filter((m) => m === "client_secret_post" || m === "client_secret_basic"),
    "client_secret_post",
    "client_secret_basic",
  ]);
  let lastError;

  for (const method of methods) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      resource: mcpUrl,
    });
    if (scopes) body.set("scope", scopes);
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (method === "client_secret_basic") {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
    } else {
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
    }

    const response = await fetch(tokenEndpoint, { method: "POST", headers, body: body.toString() });
    const text = await response.text();
    if (response.ok) return { token: JSON.parse(text), tokenAuthMethod: method };
    lastError = new Error(`Token exchange ${response.status} (${method}): ${text.slice(0, 400)}`);
  }
  throw lastError || new Error("PriceLabs token exchange failed");
}

async function main() {
  const mcpUrl = clean(arg("--mcp-url") || process.env.PRICELABS_MCP_URL) || DEFAULT_MCP_URL;
  const redirectUri = clean(arg("--redirect-uri") || process.env.PRICELABS_OAUTH_REDIRECT_URI) || DEFAULT_REDIRECT_URI;
  let clientId = clean(arg("--client-id") || process.env.PRICELABS_MCP_CLIENT_ID);
  if (!clientId) clientId = clean(await promptLine("PriceLabs Client-ID: "));
  if (!clientId) throw new Error("Client-ID fehlt");

  let clientSecret = clean(process.env.PRICELABS_MCP_CLIENT_SECRET);
  if (!clientSecret) clientSecret = clean(await promptSecret("PriceLabs Client Secret (wird nicht angezeigt): "));
  if (!clientSecret) throw new Error("Client Secret fehlt");

  console.log("PriceLabs OAuth-Metadaten werden ermittelt …");
  const { protectedResource, auth, metadataUrl } = await discoverOAuth(mcpUrl);
  console.log(`OAuth-Metadaten: ${metadataUrl}`);

  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(24));
  const configuredScopes = clean(arg("--scopes") || process.env.PRICELABS_OAUTH_SCOPES);
  const supportedScopes = unique([...(protectedResource?.scopes_supported || []), ...(auth.scopes_supported || [])]);
  const scopes = configuredScopes || (supportedScopes.length ? supportedScopes.join(" ") : undefined);

  const authUrl = new URL(auth.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", mcpUrl);
  if (scopes) authUrl.searchParams.set("scope", scopes);

  console.log(`\nAngefragte Scopes: ${scopes || "(PriceLabs entscheidet im Consent-Screen)"}`);
  const codePromise = waitForAuthorizationCode(redirectUri, state);
  const opened = openBrowser(authUrl.toString());
  if (!opened) console.log(`\nÖffne diese URL im Browser:\n${authUrl}\n`);
  else console.log("Browser wurde geöffnet. In PriceLabs bitte alle gewünschten Rechte freigeben (Read, Write und Customization Write).\n");

  const code = await codePromise;
  const { token, tokenAuthMethod } = await exchangeCode({
    tokenEndpoint: auth.token_endpoint,
    clientId,
    clientSecret,
    code,
    redirectUri,
    codeVerifier,
    mcpUrl,
    scopes,
    advertisedMethods: auth.token_endpoint_auth_methods_supported,
  });

  if (!token.access_token) throw new Error("Token endpoint returned no access_token");
  if (!token.refresh_token) throw new Error("PriceLabs returned no refresh_token. Reconnect and ensure offline/long-lived access is allowed.");

  const tokenFile = {
    createdAt: new Date().toISOString(),
    mcpUrl,
    redirectUri,
    authorizationEndpoint: auth.authorization_endpoint,
    tokenEndpoint: auth.token_endpoint,
    tokenAuthMethod,
    scopes: token.scope || scopes || "",
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
  };
  await writeFile(".pricelabs-oauth.json", `${JSON.stringify(tokenFile, null, 2)}\n`, { mode: 0o600 });

  const renderEnv = [
    `PRICELABS_MCP_URL=${mcpUrl}`,
    `PRICELABS_MCP_CLIENT_ID=${clientId}`,
    `PRICELABS_MCP_CLIENT_SECRET=${clientSecret}`,
    `PRICELABS_MCP_REFRESH_TOKEN=${token.refresh_token}`,
    `PRICELABS_OAUTH_TOKEN_URL=${auth.token_endpoint}`,
    `PRICELABS_OAUTH_TOKEN_AUTH_METHOD=${tokenAuthMethod}`,
    ...(token.scope || scopes ? [`PRICELABS_OAUTH_SCOPES=${token.scope || scopes}`] : []),
  ].join("\n") + "\n";
  await writeFile(".pricelabs-render-env", renderEnv, { mode: 0o600 });

  console.log("\n✅ OAuth erfolgreich.");
  console.log("Secrets wurden lokal gespeichert in:");
  console.log("  .pricelabs-oauth.json");
  console.log("  .pricelabs-render-env");
  console.log("Beide Dateien sind für .gitignore vorgesehen. NICHT committen und NICHT in Chats posten.");
  console.log("\nNächster Schritt: Werte aus .pricelabs-render-env direkt als Environment Variables bei Render eintragen.");
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

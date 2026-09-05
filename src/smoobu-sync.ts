import { createHash, createHmac, randomUUID } from "node:crypto";

interface SmoobuConfig {
  apiKey: string;
  apiSecret?: string;
  repo: string;
  token: string;
  branch: string;
  intervalMinutes: number;
}

interface BookingPage {
  page_count?: number;
  page_size?: number;
  total_items?: number;
  page?: number;
  bookings?: Array<Record<string, unknown>>;
}

function loadConfig(): SmoobuConfig | null {
  const apiKey = process.env.SMOOBU_API_KEY?.trim();
  const apiSecret = process.env.SMOOBU_API_SECRET?.trim() || undefined;
  const repo = process.env.GITHUB_SYNC_REPO?.trim();
  const token = process.env.GITHUB_SYNC_TOKEN?.trim();
  if (!apiKey || !repo || !token) return null;
  const branch = process.env.GITHUB_SYNC_BRANCH?.trim() || "main";
  const parsed = Number(process.env.SMOOBU_SYNC_INTERVAL_MINUTES || process.env.GITHUB_SYNC_INTERVAL_MINUTES || "30");
  const intervalMinutes = Number.isFinite(parsed) && parsed >= 5 ? parsed : 30;
  return { apiKey, apiSecret, repo, token, branch, intervalMinutes };
}

function canonicalQuery(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function smoobuGet<T>(cfg: SmoobuConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const query = canonicalQuery(params);
  const url = `https://login.smoobu.com${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };

  if (cfg.apiSecret) {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const nonce = randomUUID();
    const bodyHash = createHash("sha256").update("").digest("hex");
    const canonical = ["GET", path, query, timestamp, nonce, bodyHash, cfg.apiKey].join("\n");
    const signature = createHmac("sha256", cfg.apiSecret).update(canonical).digest("base64");
    headers["X-API-Key"] = cfg.apiKey;
    headers["X-Timestamp"] = timestamp;
    headers["X-Nonce"] = nonce;
    headers["X-Signature"] = signature;
  } else {
    // Legacy auth remains usable only during Smoobu's migration window.
    headers["Api-Key"] = cfg.apiKey;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Smoobu ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

async function allBookings(cfg: SmoobuConfig): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 500; page++) {
    const res = await smoobuGet<BookingPage>(cfg, "/api/reservations", {
      page,
      pageSize: 100,
      showCancellation: true,
      excludeBlocked: false,
      includePriceElements: true,
    });
    rows.push(...(res.bookings ?? []));
    if (page >= (res.page_count ?? 1)) break;
  }
  return rows;
}

function sanitizeBooking(row: Record<string, unknown>) {
  return {
    id: row.id,
    referenceId: row["reference-id"],
    type: row.type,
    arrival: row.arrival,
    departure: row.departure,
    createdAt: row["created-at"],
    modifiedAt: row["modified-at"] ?? row.modifiedAt,
    apartment: row.apartment,
    channel: row.channel,
    adults: row.adults,
    children: row.children,
    price: row.price,
    pricePaid: row["price-paid"],
    prepayment: row.prepayment,
    prepaymentPaid: row["prepayment-paid"],
    deposit: row.deposit,
    depositPaid: row["deposit-paid"],
    isBlockedBooking: row["is-blocked-booking"],
    priceElements: row.priceElements,
  };
}

function nightsBetween(arrival: unknown, departure: unknown): number {
  if (typeof arrival !== "string" || typeof departure !== "string") return 0;
  const from = Date.parse(`${arrival}T00:00:00Z`);
  const to = Date.parse(`${departure}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.round((to - from) / 86_400_000);
}

function bookingReports(bookings: ReturnType<typeof sanitizeBooking>[]) {
  type Bucket = { bookings: number; nights: number; revenue: number };
  const months = new Map<string, Bucket>();
  const apartments = new Map<string, Bucket>();
  const channels = new Map<string, Bucket>();

  for (const row of bookings) {
    if (row.type === "cancellation" || row.isBlockedBooking === true) continue;
    const month = typeof row.arrival === "string" ? row.arrival.slice(0, 7) : "unknown";
    const nights = nightsBetween(row.arrival, row.departure);
    const revenue = typeof row.price === "number" ? row.price : Number(row.price) || 0;
    const apartmentName = typeof row.apartment === "object" && row.apartment ? String((row.apartment as Record<string, unknown>).name ?? "unknown") : "unknown";
    const channelName = typeof row.channel === "object" && row.channel ? String((row.channel as Record<string, unknown>).name ?? "unknown") : "unknown";

    for (const [map, key] of [[months, month], [apartments, apartmentName], [channels, channelName]] as const) {
      const bucket = map.get(key) ?? { bookings: 0, nights: 0, revenue: 0 };
      bucket.bookings += 1;
      bucket.nights += nights;
      bucket.revenue += revenue;
      map.set(key, bucket);
    }
  }

  const sortMonths = (map: Map<string, Bucket>) => Object.fromEntries([...map.entries()].sort(([a], [b]) => b.localeCompare(a)));
  const sortRevenue = (map: Map<string, Bucket>) => Object.fromEntries([...map.entries()].sort(([, a], [, b]) => b.revenue - a.revenue));
  return { months: sortMonths(months), apartments: sortRevenue(apartments), channels: sortRevenue(channels) };
}

async function upsertJson(cfg: SmoobuConfig, path: string, value: unknown): Promise<void> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const base = `https://api.github.com/repos/${cfg.repo}/contents/${encodedPath}`;
  const commonHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${cfg.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "staycil-smoobu-sync",
  };
  let sha: string | undefined;
  const lookup = await fetch(`${base}?ref=${encodeURIComponent(cfg.branch)}`, { headers: commonHeaders });
  if (lookup.ok) sha = ((await lookup.json()) as { sha?: string }).sha;
  else if (lookup.status !== 404) throw new Error(`GitHub lookup ${lookup.status}: ${(await lookup.text()).slice(0, 500)}`);

  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64");
  const response = await fetch(base, {
    method: "PUT",
    headers: { ...commonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Sync Smoobu data: ${path}`, content, branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

let running = false;

export async function runSmoobuSync(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg || running) return;
  running = true;
  try {
    const syncedAt = new Date().toISOString();
    const [me, apartmentList, rawBookings] = await Promise.all([
      smoobuGet<Record<string, unknown>>(cfg, "/api/me"),
      smoobuGet<{ apartments?: Array<Record<string, unknown>> }>(cfg, "/api/apartments"),
      allBookings(cfg),
    ]);
    const bookings = rawBookings.map(sanitizeBooking);
    const apartments = apartmentList.apartments ?? [];
    const reports = bookingReports(bookings);

    await upsertJson(cfg, "smoobu/account.json", { syncedAt, data: { id: me.id } });
    await upsertJson(cfg, "smoobu/apartments.json", { syncedAt, count: apartments.length, data: apartments });
    await upsertJson(cfg, "smoobu/bookings.json", { syncedAt, count: bookings.length, data: bookings });
    await upsertJson(cfg, "reports/smoobu-performance.json", {
      syncedAt,
      basis: "Smoobu reservation price grouped by arrival month. Cancellations and blocked bookings excluded. This is booking revenue, not bank cash received.",
      ...reports,
    });
    await upsertJson(cfg, "reports/smoobu-sync-status.json", {
      syncedAt,
      ok: true,
      authMode: cfg.apiSecret ? "hmac" : "legacy",
      apartmentCount: apartments.length,
      bookingCount: bookings.length,
    });
    console.error(`[smoobu-sync] OK — ${apartments.length} apartments, ${bookings.length} bookings (${cfg.apiSecret ? "HMAC" : "legacy auth"})`);
  } catch (err) {
    console.error(`[smoobu-sync] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

export function startSmoobuSync(): void {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("[smoobu-sync] disabled (set SMOOBU_API_KEY; GitHub sync credentials are reused)");
    return;
  }
  void runSmoobuSync();
  setInterval(() => void runSmoobuSync(), cfg.intervalMinutes * 60_000).unref();
  console.error(`[smoobu-sync] enabled — every ${cfg.intervalMinutes} min -> ${cfg.repo} (${cfg.apiSecret ? "HMAC" : "legacy auth"})`);
}

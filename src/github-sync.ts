import type { LexwareClient } from "./lexware/client.js";

interface Paged<T> {
  content: T[];
  totalPages: number;
  totalElements: number;
  number: number;
  size: number;
}

interface SyncConfig {
  token: string;
  repo: string;
  branch: string;
  intervalMinutes: number;
}

interface PaymentItem {
  paymentItemType?: string;
  postingDate?: string;
  amount?: number;
  currency?: string;
}

interface PaymentInfo {
  openAmount?: number;
  currency?: string;
  paymentStatus?: string;
  voucherType?: string;
  voucherStatus?: string;
  paidDate?: string;
  paymentItems?: PaymentItem[];
}

function loadSyncConfig(): SyncConfig | null {
  const token = process.env.GITHUB_SYNC_TOKEN?.trim();
  const repo = process.env.GITHUB_SYNC_REPO?.trim();
  if (!token || !repo) return null;
  const branch = process.env.GITHUB_SYNC_BRANCH?.trim() || "main";
  const parsed = Number(process.env.GITHUB_SYNC_INTERVAL_MINUTES || "30");
  const intervalMinutes = Number.isFinite(parsed) && parsed >= 5 ? parsed : 30;
  return { token, repo, branch, intervalMinutes };
}

async function allPages<T>(client: LexwareClient, path: string, query: Record<string, string | number | boolean> = {}): Promise<T[]> {
  const size = 250;
  const rows: T[] = [];
  for (let page = 0; page < 200; page++) {
    const res = await client.get<Paged<T>>(path, { ...query, page, size });
    rows.push(...(res.content ?? []));
    if (page + 1 >= (res.totalPages ?? 1) || rows.length >= (res.totalElements ?? rows.length)) break;
  }
  return rows;
}

function monthlySummary(vouchers: Array<Record<string, unknown>>) {
  const months = new Map<string, { count: number; totalAmount: number; openAmount: number }>();
  for (const row of vouchers) {
    const date = typeof row.voucherDate === "string" ? row.voucherDate : "";
    const month = date.slice(0, 7) || "unknown";
    const bucket = months.get(month) ?? { count: 0, totalAmount: 0, openAmount: 0 };
    bucket.count += 1;
    bucket.totalAmount += typeof row.totalAmount === "number" ? row.totalAmount : 0;
    bucket.openAmount += typeof row.openAmount === "number" ? row.openAmount : 0;
    months.set(month, bucket);
  }
  return Object.fromEntries([...months.entries()].sort(([a], [b]) => b.localeCompare(a)));
}

const paymentVoucherTypes = new Set([
  "invoice",
  "salesinvoice",
  "downpaymentinvoice",
  "creditnote",
  "salescreditnote",
  "purchaseinvoice",
  "purchasecreditnote",
]);

const salesIncomeTypes = new Set(["invoice", "salesinvoice", "downpaymentinvoice"]);
const businessExpenseTypes = new Set(["purchaseinvoice", "creditnote", "salescreditnote"]);

function buildBankCashflow(payments: Array<Record<string, unknown>>) {
  const months = new Map<string, {
    bankRevenue: number;
    bankExpenses: number;
    netBankCashflow: number;
    incomingCount: number;
    outgoingCount: number;
  }>();

  for (const row of payments) {
    const voucherType = String(row.voucherType ?? "");
    const payment = row.payment as PaymentInfo | undefined;
    for (const item of payment?.paymentItems ?? []) {
      // Only count payments explicitly linked to a financial/bank transaction.
      if (item.paymentItemType !== "partPaymentFinancialTransaction") continue;
      if (!item.postingDate || typeof item.amount !== "number") continue;
      const month = item.postingDate.slice(0, 7);
      const bucket = months.get(month) ?? {
        bankRevenue: 0,
        bankExpenses: 0,
        netBankCashflow: 0,
        incomingCount: 0,
        outgoingCount: 0,
      };

      if (salesIncomeTypes.has(voucherType) || voucherType === "purchasecreditnote") {
        bucket.bankRevenue += item.amount;
        bucket.netBankCashflow += item.amount;
        bucket.incomingCount += 1;
      } else if (businessExpenseTypes.has(voucherType)) {
        bucket.bankExpenses += item.amount;
        bucket.netBankCashflow -= item.amount;
        bucket.outgoingCount += 1;
      }
      months.set(month, bucket);
    }
  }

  return Object.fromEntries([...months.entries()].sort(([a], [b]) => b.localeCompare(a)));
}

async function githubRequest(cfg: SyncConfig, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "staycil-lexware-sync",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function upsertJson(cfg: SyncConfig, path: string, value: unknown): Promise<void> {
  let sha: string | undefined;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const lookup = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${encodedPath}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "staycil-lexware-sync",
    },
  });
  if (lookup.ok) {
    const current = (await lookup.json()) as { sha?: string };
    sha = current.sha;
  } else if (lookup.status !== 404) {
    throw new Error(`GitHub lookup ${lookup.status}: ${(await lookup.text()).slice(0, 500)}`);
  }

  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64");
  await githubRequest(cfg, `/contents/${encodedPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Sync Lexware data: ${path}`,
      content,
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

let running = false;

export async function runGithubFinanceSync(client: LexwareClient): Promise<void> {
  const cfg = loadSyncConfig();
  if (!cfg || running) return;
  running = true;
  try {
    const syncedAt = new Date().toISOString();
    const profile = await client.get<Record<string, unknown>>("/v1/profile");
    const vouchers = await allPages<Record<string, unknown>>(client, "/v1/voucherlist", {
      voucherType: "any",
      voucherStatus: "any",
    });
    const contacts = await allPages<Record<string, unknown>>(client, "/v1/contacts");
    const invoices = vouchers.filter((v) => v.voucherType === "invoice" || v.voucherType === "salesinvoice");

    // Payment details are available only per voucher. Keep this sync focused on the current
    // calendar year so it remains fast enough for a recurring background sync.
    const currentYear = new Date().getUTCFullYear();
    const yearPrefix = `${currentYear}-`;
    const paymentCandidates = vouchers.filter((v) => {
      const type = String(v.voucherType ?? "");
      const status = String(v.voucherStatus ?? "");
      const date = String(v.voucherDate ?? "");
      return paymentVoucherTypes.has(type) && status !== "draft" && date.startsWith(yearPrefix) && typeof v.id === "string";
    });

    const payments: Array<Record<string, unknown>> = [];
    let paymentErrors = 0;
    for (const voucher of paymentCandidates) {
      try {
        const payment = await client.get<PaymentInfo>(`/v1/payments/${String(voucher.id)}`);
        payments.push({
          voucherId: voucher.id,
          voucherNumber: voucher.voucherNumber,
          voucherDate: voucher.voucherDate,
          voucherType: voucher.voucherType,
          voucherStatus: voucher.voucherStatus,
          totalAmount: voucher.totalAmount,
          payment,
        });
      } catch {
        // Some voucher states/types legitimately do not expose payment details (e.g. drafts
        // and linked credit notes). Do not fail the entire finance sync for those records.
        paymentErrors += 1;
      }
    }

    await upsertJson(cfg, "lexware/profile.json", { syncedAt, data: profile });
    await upsertJson(cfg, "lexware/vouchers.json", { syncedAt, count: vouchers.length, data: vouchers });
    await upsertJson(cfg, "lexware/invoices.json", { syncedAt, count: invoices.length, data: invoices });
    await upsertJson(cfg, "lexware/payments.json", {
      syncedAt,
      year: currentYear,
      count: payments.length,
      skippedOrUnavailable: paymentErrors,
      data: payments,
    });
    await upsertJson(cfg, "lexware/contacts.json", { syncedAt, count: contacts.length, data: contacts });
    await upsertJson(cfg, "reports/monthly-summary.json", {
      syncedAt,
      basis: {
        invoiceMonths: "invoice and salesinvoice only; grouped by voucherDate; totalAmount is gross invoiced revenue",
        allVoucherMonths: "all voucher types; not a revenue measure",
      },
      invoiceMonths: monthlySummary(invoices),
      allVoucherMonths: monthlySummary(vouchers),
    });
    await upsertJson(cfg, "reports/cashflow-monthly.json", {
      syncedAt,
      year: currentYear,
      basis: "Only Lexware paymentItems with paymentItemType=partPaymentFinancialTransaction are counted. These are payments linked to a financial/bank transaction. Manual payments, cash box entries, credit-note offsets, discounts and other non-bank payment items are excluded. This is not a raw bank-account feed and can omit unassigned bank transactions.",
      months: buildBankCashflow(payments),
    });
    await upsertJson(cfg, "reports/sync-status.json", {
      syncedAt,
      ok: true,
      voucherCount: vouchers.length,
      invoiceCount: invoices.length,
      paymentCandidateCount: paymentCandidates.length,
      paymentCount: payments.length,
      paymentErrors,
      contactCount: contacts.length,
    });
    console.error(`[lexware-mcp] GitHub finance sync OK — ${vouchers.length} vouchers, ${invoices.length} invoices, ${payments.length} payments (${paymentErrors} unavailable), ${contacts.length} contacts`);
  } catch (err) {
    console.error(`[lexware-mcp] GitHub finance sync FAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

export function startGithubFinanceSync(client: LexwareClient): void {
  const cfg = loadSyncConfig();
  if (!cfg) {
    console.error("[lexware-mcp] GitHub finance sync disabled (set GITHUB_SYNC_TOKEN + GITHUB_SYNC_REPO to enable)");
    return;
  }
  void runGithubFinanceSync(client);
  setInterval(() => void runGithubFinanceSync(client), cfg.intervalMinutes * 60_000).unref();
  console.error(`[lexware-mcp] GitHub finance sync enabled — every ${cfg.intervalMinutes} min -> ${cfg.repo}`);
}

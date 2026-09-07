import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { Config } from "./config.js";
import type { LexwareClient } from "./lexware/client.js";

const invoiceDraftSchema = z.object({
  voucherDate: z.string().min(1),
  address: z.record(z.string(), z.unknown()),
  lineItems: z.array(z.unknown()).min(1).max(300),
  totalPrice: z.record(z.string(), z.unknown()),
  taxConditions: z.record(z.string(), z.unknown()),
  shippingConditions: z.record(z.string(), z.unknown()),
}).passthrough();

export function validateInvoiceDraft(body: unknown) {
  return invoiceDraftSchema.safeParse(body);
}

export function isOpsAuthorized(request: Pick<Request, "headers">, expected: string | undefined): boolean {
  const received = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function protect(config: Config, request: Request, response: Response): boolean {
  if (!isOpsAuthorized(request, config.opsApiSecret)) {
    response.set("WWW-Authenticate", 'Bearer error="invalid_token"').status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function query(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === "string" && value ? value : undefined;
}

function safeError(response: Response, status: number, message: string) {
  response.status(status).json({ error: message });
}

export function registerOpsRoutes(app: Express, client: LexwareClient, config: Config): void {
  app.get("/ops/invoices", async (request, response) => {
    if (!protect(config, request, response)) return;
    try {
      const data = await client.get<Record<string, unknown>>("/v1/voucherlist", {
        voucherType: query(request, "voucherType") ?? "invoice",
        voucherStatus: query(request, "voucherStatus") ?? "any",
        voucherDateFrom: query(request, "from"),
        voucherDateTo: query(request, "to"),
        page: query(request, "page") ? Number(query(request, "page")) : undefined,
        size: query(request, "size") ? Number(query(request, "size")) : undefined,
      });
      response.set("Cache-Control", "no-store").json(data);
    } catch { safeError(response, 502, "Lexware-Rechnungen konnten nicht geladen werden."); }
  });

  app.get("/ops/invoices/:id", async (request, response) => {
    if (!protect(config, request, response)) return;
    try { response.set("Cache-Control", "no-store").json(await client.get(`/v1/invoices/${encodeURIComponent(request.params.id)}`)); }
    catch { safeError(response, 502, "Rechnungsdetails konnten nicht geladen werden."); }
  });

  app.get("/ops/invoices/:id/pdf", async (request, response) => {
    if (!protect(config, request, response)) return;
    try {
      const file = await client.getBinary(`/v1/invoices/${encodeURIComponent(request.params.id)}` + "/file");
      response.set("Cache-Control", "no-store").type(file.contentType).send(file.data);
    } catch { safeError(response, 502, "Rechnungs-PDF konnte nicht geladen werden."); }
  });

  app.get("/ops/contacts", async (request, response) => {
    if (!protect(config, request, response)) return;
    try { response.set("Cache-Control", "no-store").json(await client.get("/v1/contacts", { name: query(request, "name"), email: query(request, "email"), page: 0, size: 100 })); }
    catch { safeError(response, 502, "Lexware-Kontakte konnten nicht geladen werden."); }
  });

  app.get("/ops/articles", async (request, response) => {
    if (!protect(config, request, response)) return;
    try { response.set("Cache-Control", "no-store").json(await client.get("/v1/articles", { page: 0, size: 100 })); }
    catch { safeError(response, 502, "Lexware-Artikel konnten nicht geladen werden."); }
  });

  app.post("/ops/invoice-drafts", async (request, response) => {
    if (!protect(config, request, response)) return;
    if (!config.capabilities.drafts) return safeError(response, 503, "Lexware-Entwürfe sind nicht aktiviert.");
    const parsed = validateInvoiceDraft(request.body);
    if (!parsed.success) return safeError(response, 400, "Rechnungsentwurf enthält ungültige oder fehlende Felder.");
    try { response.status(201).set("Cache-Control", "no-store").json({ ...(await client.post<Record<string, unknown>>("/v1/invoices", parsed.data)), finalized: false }); }
    catch { safeError(response, 502, "Rechnungsentwurf konnte nicht erstellt werden."); }
  });

  app.post("/ops/invoices/finalize", async (request, response) => {
    if (!protect(config, request, response)) return;
    if (!config.capabilities.finalize) return safeError(response, 503, "Rechnungsfinalisierung ist nicht aktiviert.");
    if (request.body?.confirmFinalize !== true) return safeError(response, 400, "Finalisierung benötigt confirmFinalize=true.");
    const { confirmFinalize: _confirmFinalize, ...invoiceBody } = request.body as Record<string, unknown>;
    const parsed = validateInvoiceDraft(invoiceBody);
    if (!parsed.success) return safeError(response, 400, "Rechnung enthält ungültige oder fehlende Felder.");
    try { response.status(201).set("Cache-Control", "no-store").json({ ...(await client.post<Record<string, unknown>>("/v1/invoices", parsed.data, { finalize: true })), finalized: true }); }
    catch { safeError(response, 502, "Rechnung konnte nicht finalisiert werden."); }
  });
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoicePreviewFromSmoobu, prepareBnBillsInvoiceReview } from "../src/bnbills-invoice-preview.js";
import { smoobuGet, type SmoobuConfig } from "../src/smoobu-sync.js";
vi.mock("../src/smoobu-sync.js", () => ({ smoobuGet: vi.fn() }));

const cfg: SmoobuConfig = {
  apiKey: "test", repo: "unit/test", token: "test", branch: "main", intervalMinutes: 30,
};
const booking = {
  id: 161136356,
  arrival: "2026-10-26",
  departure: "2026-10-27",
  apartment: { id: 3122336, name: "WS 1 | 130" },
  firstname: "Andreja", lastname: "Pšajd", email: "andreja@novos.si",
  adults: 4, children: 0, price: 70,
  notice: [
    "Direktverlängerung ohne Reinigung",
    "Rechnung an: NOVOS NEPREMIČNINE D.O.O.",
    "Steuernummer: 84052066",
    "Rechnungsanschrift: Mezgovci ob Pesnici 46, 2252 Dornava, SI",
  ].join("\n"),
};

beforeEach(() => vi.resetAllMocks());

describe("bnbills invoice review", () => {
  it("maps company, tax number as reference and split street/house number", () => {
    const p = invoicePreviewFromSmoobu(booking, "https://app.bnbills.de/booking/example");
    expect(p.fields).toMatchObject({
      company: "NOVOS NEPREMIČNINE D.O.O.",
      reference: "Steuernummer: 84052066",
      firstName: "Andreja", lastName: "Pšajd",
      email: "andreja@novos.si",
      street: "Mezgovci ob Pesnici", houseNumber: "46",
      postalCode: "2252", city: "Dornava", countryCode: "SI",
    });
    expect(p.price).toBe(70);
    expect(p.readyForReview).toBe(true);
    expect(p.invoiceRequested).toBe(false);
    expect(p.invoiceCreatedInLexware).toBe(false);
    expect(p.invoiceSent).toBe(false);
  });

  it("does not invent a URL or a company, and requires missing fields", () => {
    const p = invoicePreviewFromSmoobu({ id: 123, firstname: "A", lastname: "B", email: "a@b.de" }, null);
    expect(p.fields.company).toBe("");
    expect(p.linkReady).toBe(false);
    expect(p.bnbillsUrl).toBe(null);
    expect(p.readyForReview).toBe(false);
    expect(p.missingFields).toContain("company");
  });

  it("permits caller-supplied verified overrides and checks email", () => {
    const p = invoicePreviewFromSmoobu(booking, "http://unsafe", { email: "not-an-email", company: "Alternative GmbH" });
    expect(p.fields.company).toBe("Alternative GmbH");
    expect(p.missingFields).toContain("email");
    expect(p.bnbillsUrl).toBe(null);
    expect(p.invoiceSent).toBe(false);
  });

  it("never treats an ambiguous address as a confidently parsed address", () => {
    const p = invoicePreviewFromSmoobu({
      ...booking,
      notice: "Rechnungsanschrift: Example Road 9, UnknownAddress",
    }, null);
    expect(p.fields.houseNumber).toBe("");
    expect(p.missingFields).toContain("houseNumber");
  });

  it("retrieves the URL using the exact reservation placeholder, ignoring unrelated links", async () => {
    vi.mocked(smoobuGet).mockResolvedValueOnce(booking).mockResolvedValueOnce({
      customPlaceholders: [
        { foreignId: 444, key: "bnbillsCheckinUrl", defaultValue: "https://example.invalid/other" },
        { foreignId: "161136356", key: "bnbillsCheckinUrl", defaultValue: "https://app.bnbills.de/booking/ours" },
      ],
    });
    const p = await prepareBnBillsInvoiceReview(cfg, 161136356);
    expect(p.linkReady).toBe(true);
    expect(p.bnbillsUrl).toBe("https://app.bnbills.de/booking/ours");
    expect(smoobuGet).toHaveBeenCalledTimes(2);
    expect(smoobuGet).toHaveBeenCalledWith(cfg, "/api/custom-placeholders");
  });

  it("does not initiate invoice submission through a POST call", async () => {
    vi.mocked(smoobuGet).mockResolvedValueOnce(booking).mockResolvedValueOnce({ customPlaceholders: [] });
    const p = await prepareBnBillsInvoiceReview(cfg, 161136356);
    expect(p.linkReady).toBe(false);
    expect(p.invoiceRequested).toBe(false);
  });
});

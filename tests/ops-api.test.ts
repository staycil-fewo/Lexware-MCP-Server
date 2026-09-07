import { describe, expect, it } from "vitest";
import { isOpsAuthorized, validateInvoiceDraft } from "../src/ops-api.js";

describe("Lexware Ops machine auth", () => {
  const request = (authorization?: string) => ({ headers: { authorization } });

  it("rejects missing and wrong secrets", () => {
    expect(isOpsAuthorized(request(), "secret" as string)).toBe(false);
    expect(isOpsAuthorized(request("Bearer wrong"), "secret")).toBe(false);
  });

  it("accepts the exact bearer secret", () => {
    expect(isOpsAuthorized(request("Bearer secret"), "secret")).toBe(true);
  });

  it("requires the invoice fields needed for a draft", () => {
    expect(validateInvoiceDraft({}).success).toBe(false);
    expect(validateInvoiceDraft({ voucherDate: "2026-09-07", address: {}, lineItems: [{}], totalPrice: { currency: "EUR" }, taxConditions: { taxType: "gross" }, shippingConditions: { shippingType: "service" } }).success).toBe(true);
  });
});

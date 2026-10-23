import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDirectBooking, createDirectBooking, prepareDirectBooking } from "../src/smoobu-booking-write.js";
import { smoobuGet, smoobuPost, type SmoobuConfig } from "../src/smoobu-sync.js";

vi.mock("../src/smoobu-sync.js", () => ({
  smoobuGet: vi.fn(),
  smoobuPost: vi.fn(),
}));

const cfg: SmoobuConfig = {
  apiKey: "test", repo: "test/test", token: "test", branch: "main", intervalMinutes: 30,
};
const base = {
  id: "unit-test-20261023",
  action: "create_direct_booking" as const,
  apartmentId: 3122336,
  arrivalDate: "2026-10-26",
  departureDate: "2026-10-27",
  sourceReservationId: 160852686,
  firstName: "Andreja", lastName: "Pšajd",
  adults: 4, children: 0,
  price: 99.99, language: "de", email: "andreja@novos.si",
  billingCompany: "NOVOS NEPREMIČNINE D.O.O.",
  billingTaxNumber: "84052066",
  billingAddress: {
    street: "Mezgovci ob Pesnici 46", postalCode: "2252",
    location: "Dornava", country: "SI",
  },
};

const source = {
  id: 160852686, type: "modification of booking",
  apartment: { id: 3122336 }, arrival: "2026-10-21", departure: "2026-10-26",
};

beforeEach(() => vi.resetAllMocks());

describe("Smoobu direct booking write", () => {
  it("requires an explicitly agreed amount and valid dates", () => {
    expect(() => prepareDirectBooking({ ...base, price: undefined })).toThrow(/price/);
    expect(() => prepareDirectBooking({ ...base, price: 0 })).toThrow(/price/);
    expect(() => prepareDirectBooking({ ...base, price: 99.999 })).toThrow(/price/);
    expect(() => prepareDirectBooking({ ...base, arrivalDate: "2026-02-30" })).toThrow(/calendar date/);
    expect(() => prepareDirectBooking({ ...base, departureDate: "2026-10-26" })).toThrow(/after arrivalDate/);
  });

  it("uses channel 13, keeps the payment open and never adds cleaning", () => {
    const { payload, marker } = prepareDirectBooking(base);
    expect(payload.channelId).toBe(13);
    expect(payload.adults).toBe(4);
    expect(payload.priceStatus).toBe(0);
    expect(payload.language).toBe("de");
    expect(payload.priceElements).toHaveLength(1);
    expect(payload.priceElements[0].type).toBe("basePrice");
    expect(payload.priceElements.some((item) => item.type === "cleaningFee")).toBe(false);
    expect(payload.notice).toContain("NOVOS NEPREMIČNINE D.O.O.");
    expect(payload.notice).toContain("84052066");
    expect(payload.notice).toContain(marker);
    expect(payload.address?.street).toBe("Mezgovci ob Pesnici 46");
  });

  it("defaults to a non-writing preview and checks the previous checkout", async () => {
    vi.mocked(smoobuGet).mockResolvedValueOnce(source).mockResolvedValueOnce({ bookings: [source], page_count: 1 });
    const preview = await createDirectBooking(cfg, base);
    expect(preview).toMatchObject({ created: false, dryRun: true, available: true });
    expect(smoobuPost).not.toHaveBeenCalled();
  });

  it("refuses a live write without explicit confirmation", async () => {
    await expect(createDirectBooking(cfg, { ...base, dryRun: false })).rejects.toThrow(/confirmed=true/);
    expect(smoobuGet).not.toHaveBeenCalled();
    expect(smoobuPost).not.toHaveBeenCalled();
  });

  it("refuses an extension if the source apartment is different", async () => {
    vi.mocked(smoobuGet).mockResolvedValueOnce({ ...source, apartment: { id: 2733553 } });
    await expect(checkDirectBooking(cfg, base)).rejects.toThrow(/another apartment/);
    expect(smoobuPost).not.toHaveBeenCalled();
  });

  it("blocks conflicting stays, including blocked dates", async () => {
    const overlap = { id: 9001, type: "reservation", apartment: { id: 3122336 },
      arrival: "2026-10-26", departure: "2026-10-28" };
    vi.mocked(smoobuGet).mockResolvedValueOnce(source).mockResolvedValueOnce({ bookings: [overlap], page_count: 1 });
    await expect(createDirectBooking(cfg, { ...base, dryRun: false, confirmed: true })).rejects.toThrow(/overlapping/);
    expect(smoobuPost).not.toHaveBeenCalled();
  });

  it("does not recreate a booking with an existing command marker", async () => {
    const old = { id: 42, type: "reservation", apartment: { id: 3122336 },
      arrival: "2026-10-26", departure: "2026-10-27",
      notice: "StayCil-Command-ID: unit-test-20261023" };
    vi.mocked(smoobuGet).mockResolvedValueOnce(source).mockResolvedValueOnce({ bookings: [old], page_count: 1 });
    await expect(createDirectBooking(cfg, { ...base, dryRun: false, confirmed: true }))
      .resolves.toMatchObject({ created: false, alreadyExists: true, reservationId: 42 });
    expect(smoobuPost).not.toHaveBeenCalled();
  });

  it("posts exactly once after all live guards pass and verifies the reservation", async () => {
    vi.mocked(smoobuGet).mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ bookings: [], page_count: 1 })
      .mockResolvedValueOnce({ id: 777, apartment: { id: 3122336 } });
    vi.mocked(smoobuPost).mockResolvedValueOnce({ id: 777 });
    const result = await createDirectBooking(cfg, { ...base, dryRun: false, confirmed: true });
    expect(result).toMatchObject({ created: true, reservationId: 777, readbackVerified: true });
    expect(smoobuPost).toHaveBeenCalledTimes(1);
    expect(smoobuPost).toHaveBeenCalledWith(cfg, "/api/reservations",
      expect.objectContaining({ apartmentId: 3122336, channelId: 13, price: 99.99 }));
  });
});

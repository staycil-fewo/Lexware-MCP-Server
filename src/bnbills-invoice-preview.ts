import { smoobuGet, type SmoobuConfig } from "./smoobu-sync.js";

export interface InvoiceFields {
  company: string;
  reference: string;
  firstName: string;
  lastName: string;
  email: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  countryCode: string;
}

export type InvoiceFieldOverrides = Partial<InvoiceFields>;

interface SmoobuReservation {
  id?: number;
  arrival?: string;
  departure?: string;
  apartment?: { id?: number; name?: string };
  channel?: { id?: number; name?: string };
  firstname?: string;
  lastname?: string;
  email?: string;
  "guest-name"?: string;
  notice?: string;
  price?: number;
  adults?: number;
  children?: number;
  "city-tax"?: number | null;
}

interface CustomPlaceholder {
  foreignId?: number | string;
  key?: string;
  defaultValue?: string;
}
interface CustomPlaceholdersResponse {
  customPlaceholders?: CustomPlaceholder[];
}

const FIELDS = [
  "company", "reference", "firstName", "lastName", "email",
  "street", "houseNumber", "postalCode", "city", "countryCode",
] as const;

function noteValue(notice: string, key: string): string {
  const line = notice.split(/\r?\n/).find((row) => row.startsWith(key));
  return line ? line.slice(key.length).trim() : "";
}

function parseInvoiceAddress(value: string): Pick<InvoiceFields, "street" | "houseNumber" | "postalCode" | "city" | "countryCode"> {
  const empty = { street: "", houseNumber: "", postalCode: "", city: "", countryCode: "" };
  // Source from StayCil booking notes: "Street and number, ZIP city, ISO country".
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 3) return empty;
  const addr = /^(.*?)\s+(\d+[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?)$/.exec(parts[0] || "");
  const town = /^(\S+)\s+(.+)$/.exec(parts[1] || "");
  if (!addr || !town || !/^[A-Z]{2}$/i.test(parts[2] || "")) return empty;
  return {
    street: addr[1].trim(),
    houseNumber: addr[2].replace(/\s+/g, ""),
    postalCode: town[1],
    city: town[2].trim(),
    countryCode: parts[2].toUpperCase(),
  };
}

export function invoicePreviewFromSmoobu(
  reservation: SmoobuReservation,
  bnbillsUrl: string | null,
  overrides: InvoiceFieldOverrides = {},
) {
  const note = String(reservation.notice ?? "");
  const company = noteValue(note, "Rechnung an: ");
  const taxNumber = noteValue(note, "Steuernummer: ");
  const address = parseInvoiceAddress(noteValue(note, "Rechnungsanschrift: "));
  const fields: InvoiceFields = {
    company,
    reference: taxNumber ? `Steuernummer: ${taxNumber}` : "",
    firstName: String(reservation.firstname || "").trim(),
    lastName: String(reservation.lastname || "").trim(),
    email: String(reservation.email || "").trim(),
    ...address,
  };
  for (const key of FIELDS) {
    if (overrides[key] !== undefined) {
      if (typeof overrides[key] !== "string") throw new Error(`Invalid invoice field: ${key}`);
      fields[key] = overrides[key].trim();
    }
  }

  const missingFields = FIELDS.filter((key) => key !== "reference" && !fields[key]);
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) missingFields.push("email");
  const guestFormUrl = /^https:\/\/[^\s]+$/i.test(bnbillsUrl || "") ? bnbillsUrl : null;
  return {
    reservationId: reservation.id,
    apartment: reservation.apartment?.name ?? null,
    arrival: reservation.arrival ?? null,
    departure: reservation.departure ?? null,
    guestCount: { adults: reservation.adults ?? null, children: reservation.children ?? null },
    price: typeof reservation.price === "number" ? reservation.price : null,
    cityTax: reservation["city-tax"] ?? null,
    currency: "EUR",
    fields,
    missingFields,
    bnbillsUrl: guestFormUrl,
    linkReady: Boolean(guestFormUrl),
    readyForReview: missingFields.length === 0 && Boolean(guestFormUrl),
    // Deliberately not an invoice nor a submission: do not trigger bnbills without a documented API.
    invoiceRequested: false,
    invoiceCreatedInLexware: false,
    invoiceSent: false,
    reviewNotes: [
      "Die Angaben sind eine Vorschau und noch nicht in das bnbills-Formular geschrieben.",
      "Das Referenzfeld enthaelt eine Steuernummer; es ist keine verifizierte USt-IdNr.",
      "Vor Rechnungsanforderung Gesamtpreis, Kurtaxe/Beherbergungssteuer und Empfaenger pruefen.",
      "Vor Versand kontrollieren, ob bnbills/Lexware bereits eine Rechnung erzeugt hat (Duplikatschutz).",
    ],
  };
}

export async function prepareBnBillsInvoiceReview(
  cfg: SmoobuConfig,
  reservationId: number,
  overrides: InvoiceFieldOverrides = {},
) {
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) {
    throw new Error("reservationId must be a positive integer");
  }
  const [booking, placeholderResponse] = await Promise.all([
    smoobuGet<SmoobuReservation>(cfg, `/api/reservations/${reservationId}`),
    smoobuGet<CustomPlaceholdersResponse>(cfg, "/api/custom-placeholders"),
  ]);
  if (booking.id !== reservationId) throw new Error("Smoobu reservation mismatch");
  const found = (placeholderResponse.customPlaceholders ?? []).find(
    (p) => String(p.foreignId) === String(reservationId) && p.key === "bnbillsCheckinUrl",
  );
  return invoicePreviewFromSmoobu(booking, found?.defaultValue ?? null, overrides);
}

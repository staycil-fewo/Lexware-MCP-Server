import { smoobuGet, smoobuPost, type SmoobuConfig } from "./smoobu-sync.js";

/**
 * A separate (not an Airbnb modification) direct reservation.
 * Prices are the explicitly agreed gross amount, including any applicable fees
 * already agreed with the guest. No cleaning fee is ever injected here.
 */
export interface CreateDirectBookingCommand {
  id?: string;
  action?: string; // The processor also carries other action variants.
  apartmentId?: number | string;
  arrivalDate?: string;
  departureDate?: string;
  sourceReservationId?: number | string;
  firstName?: string;
  lastName?: string;
  adults?: number;
  children?: number;
  price?: number;
  email?: string;
  phone?: string;
  language?: string;
  billingCompany?: string;
  billingTaxNumber?: string;
  billingAddress?: {
    street?: string;
    postalCode?: string;
    location?: string;
    country?: string;
  };
  notice?: string;
  confirmed?: boolean;
  dryRun?: boolean;
}

interface SmoobuBooking {
  id?: number;
  type?: string;
  arrival?: string;
  departure?: string;
  apartment?: { id?: number; name?: string };
  "guest-name"?: string;
  notice?: string;
}

interface BookingPage {
  page_count?: number;
  bookings?: SmoobuBooking[];
}

const DIRECT_CHANNEL_ID = 13; // Smoobu's documented "Direct booking" channel.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function validDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a valid calendar date`);
  }
  return value;
}

function requiredText(value: unknown, field: string, max = 200): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > max) throw new Error(`${field} must contain 1-${max} characters`);
  return clean;
}

function optionalText(value: unknown, max = 200): string | undefined {
  const clean = typeof value === "string" ? value.trim() : "";
  return clean ? clean.slice(0, max) : undefined;
}

export function prepareDirectBooking(command: CreateDirectBookingCommand) {
  const apartmentId = positiveInteger(command.apartmentId, "apartmentId");
  const arrivalDate = validDate(command.arrivalDate, "arrivalDate");
  const departureDate = validDate(command.departureDate, "departureDate");
  if (departureDate <= arrivalDate) throw new Error("departureDate must be after arrivalDate");

  const price = command.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 100_000 ||
      Math.round(price * 100) !== price * 100 && Math.abs(Math.round(price * 100) - price * 100) > 1e-7) {
    throw new Error("price must be an explicitly agreed positive gross EUR amount with at most 2 decimals");
  }
  const adults = positiveInteger(command.adults, "adults");
  if (adults > 50) throw new Error("adults exceeds the supported maximum");
  const children = command.children === undefined ? 0 : Number(command.children);
  if (!Number.isSafeInteger(children) || children < 0 || children > 50) throw new Error("children must be 0-50");
  const firstName = requiredText(command.firstName, "firstName");
  const lastName = requiredText(command.lastName, "lastName");
  const email = optionalText(command.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  const language = command.language ?? "de";
  if (!/^[a-z]{2}$/.test(language)) throw new Error("language must be a 2-letter locale, e.g. de");
  const sourceReservationId = command.sourceReservationId === undefined
    ? undefined : positiveInteger(command.sourceReservationId, "sourceReservationId");
  const billingCompany = optionalText(command.billingCompany);
  const billingTaxNumber = optionalText(command.billingTaxNumber, 80);
  const billingAddress = command.billingAddress;
  if (billingAddress && (
    !billingAddress.street || !billingAddress.postalCode ||
    !billingAddress.location || !billingAddress.country
  )) throw new Error("billingAddress requires street, postalCode, location and country");

  const identifier = requiredText(command.id, "id", 100);
  if (!/^[a-zA-Z0-9._-]+$/.test(identifier)) throw new Error("id contains invalid characters");
  const marker = `StayCil-Command-ID: ${identifier}`;
  const notes = [
    optionalText(command.notice, 1000),
    sourceReservationId ? `Verlängerung zu Airbnb/Smoobu-Reservierung ${sourceReservationId}` : undefined,
    billingCompany ? `Rechnung an: ${billingCompany}` : undefined,
    billingTaxNumber ? `Steuernummer: ${billingTaxNumber}` : undefined,
    billingAddress ? `Rechnungsanschrift: ${billingAddress.street}, ${billingAddress.postalCode} ${billingAddress.location}, ${billingAddress.country}` : undefined,
    marker,
  ].filter(Boolean).join("\n");

  return {
    sourceReservationId,
    marker,
    payload: {
      apartmentId, arrivalDate, departureDate,
      channelId: DIRECT_CHANNEL_ID,
      firstName, lastName, adults, children,
      price: Math.round(price * 100) / 100,
      priceStatus: 0, // A booking isn't proof of payment.
      language,
      ...(email ? { email } : {}),
      ...(optionalText(command.phone, 40) ? { phone: optionalText(command.phone, 40) } : {}),
      ...(billingAddress ? {
        address: {
          street: requiredText(billingAddress.street, "billingAddress.street"),
          postalCode: requiredText(billingAddress.postalCode, "billingAddress.postalCode", 40),
          location: requiredText(billingAddress.location, "billingAddress.location"),
        },
        country: requiredText(billingAddress.country, "billingAddress.country", 80),
      } : {}),
      notice: notes,
      priceElements: [{
        type: "basePrice",
        name: "Übernachtung (ohne erneute Reinigung)",
        amount: Math.round(price * 100) / 100,
        currencyCode: "EUR",
        sortOrder: 1,
      }],
    },
  };
}

export async function checkDirectBooking(
  cfg: SmoobuConfig,
  command: CreateDirectBookingCommand,
) {
  const prepared = prepareDirectBooking(command);
  const { payload, sourceReservationId, marker } = prepared;

  if (sourceReservationId !== undefined) {
    const source = await smoobuGet<SmoobuBooking>(cfg, `/api/reservations/${sourceReservationId}`);
    if (source.type === "cancellation") throw new Error("Source booking has been cancelled");
    if (source.apartment?.id !== payload.apartmentId) throw new Error("Source booking belongs to another apartment");
    if (source.departure !== payload.arrivalDate) throw new Error("Extension must start exactly on source checkout date");
  }

  const rows: SmoobuBooking[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await smoobuGet<BookingPage>(cfg, "/api/reservations", {
      from: payload.arrivalDate,
      to: payload.departureDate,
      apartmentId: payload.apartmentId,
      page,
      pageSize: 100,
      showCancellation: false,
      excludeBlocked: false,
    });
    rows.push(...(response.bookings ?? []));
    if (page >= (response.page_count ?? 1)) break;
    if (page === 100) throw new Error("Cannot verify booking conflicts: reservation result exceeds 100 pages");
  }

  const overlaps = rows.filter((row) =>
    row.type !== "cancellation" &&
    row.apartment?.id === payload.apartmentId &&
    typeof row.arrival === "string" &&
    typeof row.departure === "string" &&
    row.arrival < payload.departureDate &&
    row.departure > payload.arrivalDate
  );
  const previous = overlaps.find((row) => row.notice?.includes(marker));
  return { prepared, overlaps, previous };
}

export async function createDirectBooking(cfg: SmoobuConfig, command: CreateDirectBookingCommand) {
  // Intentional opt-in: a command that omits dryRun can NEVER create a reservation.
  const preview = command.dryRun !== false;
  if (!preview && command.confirmed !== true) {
    throw new Error("Live booking requires confirmed=true and dryRun=false");
  }
  const { prepared, overlaps, previous } = await checkDirectBooking(cfg, command);
  const { payload, sourceReservationId } = prepared;
  if (previous?.id) {
    return { created: false, alreadyExists: true, reservationId: previous.id, dryRun: preview };
  }
  if (preview) {
    return { created: false, dryRun: true, available: overlaps.length === 0,
      conflictingReservations: overlaps.map((x) => ({ id: x.id, arrival: x.arrival, departure: x.departure })),
      payload, sourceReservationId };
  }
  if (overlaps.length) {
    throw new Error(`Apartment has ${overlaps.length} overlapping reservation(s). No booking created.`);
  }
  const created = await smoobuPost<{ id?: number }>(cfg, "/api/reservations", payload);
  if (!Number.isSafeInteger(created?.id) || !created.id || created.id <= 0) {
    throw new Error("Smoobu create response lacks reservation ID; status is uncertain. Do not retry automatically.");
  }
  // A successful POST is the booking's source of truth; readback failure must not retry it.
  let verified = false;
  try {
    const readback = await smoobuGet<SmoobuBooking>(cfg, `/api/reservations/${created.id}`);
    verified = readback.id === created.id && readback.apartment?.id === payload.apartmentId;
  } catch { /* verification can be retried with a read-only get_booking command */ }
  return { created: true, reservationId: created.id, readbackVerified: verified,
    apartmentId: payload.apartmentId, arrivalDate: payload.arrivalDate,
    departureDate: payload.departureDate, price: payload.price,
    adults: payload.adults, channelId: DIRECT_CHANNEL_ID, sourceReservationId };
}

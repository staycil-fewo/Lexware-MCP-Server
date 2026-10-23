# Smoobu: Direktbuchungen aus ChatGPT (Schreibanbindung)

Der vorhandene GitHub-Command-Processor unterstützt `create_direct_booking`. Er läuft auf Render,
liest `commands/smoobu/pending/*.json` aus `staycil-fewo/staycil-finance-data`,
ruft die Smoobu-API mit dem bereits konfigurierten HMAC-Zugang auf und legt
`commands/smoobu/results/<id>.json` mit dem Ergebnis ab.

## Sicherheit

- **Standard ist Dry-Run**: ohne `dryRun: false` wird NIE eine echte Buchung erzeugt.
- Eine echte Buchung erfordert **zusätzlich** `confirmed: true` sowie einen ausdrücklich vereinbarten, positiven Bruttopreis in EUR (max. 2 Dezimalstellen).
- Smoobu-Kanal **13** ist `Direct booking` (nicht Airbnb; der bisherige Airbnb-Aufenthalt bleibt unberührt).
- Bei Verlängerungen mit `sourceReservationId` müssen Apartment und Checkout-Datum der Originalbuchung passen.
- Unmittelbar vor dem Schreiben fragt der Prozessor bestehende Buchungen ab und verweigert eine Doppelbelegung. Smoobu prüft Konflikte auch selbst.
- Ein Kennzeichen `StayCil-Command-ID` in der Buchungsnotiz schützt gegen doppelte Verarbeitung.
- Der Prozessor markiert echte Schreibaufträge **vor** dem API-POST als `sending`; nach einem Absturz wird nicht automatisch erneut gebucht, sondern der Status als unsicher gemeldet.
- Die GitHub-Ergebnisspeicherung wiederholt kurzzeitig fehlgeschlagene Commits (`409/422`) wegen des parallel laufenden Datenabgleichs.
- Kein Reinigungszuschlag; das einzige `priceElement` ist `basePrice`.
- `priceStatus: 0` (offen) – eine Buchung bedeutet nicht, dass bezahlt wurde.
- Die Rechnungsdaten werden als Adresse und interne Notiz an Smoobu übergeben. **Ob BnBills daraus automatisch eine korrekte Firmenrechnung generiert, wird durch diese Schnittstelle nicht garantiert.**
- Wenn die automatische Kasseler Übernachtungssteuer berechnet wird, muss der vereinbarte Endpreis inkl. dieser Steuer geklärt sein; diese Schnittstelle erfindet oder addiert keine Steuer.

## Beispiel: Vorschau für eine Verlängerung (nur Beispielpreis!)

```json
{
  "id": "preview-andreja-ws130-20261026",
  "action": "create_direct_booking",
  "sourceReservationId": 160852686,
  "apartmentId": 3122336,
  "arrivalDate": "2026-10-26",
  "departureDate": "2026-10-27",
  "firstName": "Andreja",
  "lastName": "Pšajd",
  "email": "andreja@novos.si",
  "adults": 4,
  "children": 0,
  "language": "de",
  "price": 99.99,
  "billingCompany": "NOVOS NEPREMIČNINE D.O.O.",
  "billingTaxNumber": "84052066",
  "billingAddress": {
    "street": "Mezgovci ob Pesnici 46",
    "postalCode": "2252",
    "location": "Dornava",
    "country": "SI"
  },
  "notice": "Direktverlängerung um eine Nacht; keine erneute Reinigung",
  "dryRun": true
}
```

**Der Preis 99,99 EUR ist ausschließlich ein TESTWERT – kein Angebot und keine Buchung.**
Für den Live-Auftrag einen **neuen**, eindeutigen `id` verwenden, den vereinbarten
Preis einsetzen, `dryRun:false` und `confirmed:true` setzen.

**Wichtig**: Der Auftrag wird erst beim Schreiben in die `pending/`-Queue ausgelöst.
Ein GitHub-Code-Commit oder ein Dry-Run erstellt keine Smoobu-Reservierung.

## Ergebnis

Erfolgreiche Buchung: `ok: true`, `output.created: true`, `output.reservationId`.
Vorschau: `output.dryRun: true`, `available` sowie erkennbare Konflikte.
Bei unklarem Netzwerkausgang: `uncertain: true`. Nicht blind neu senden, erst read-only prüfen.

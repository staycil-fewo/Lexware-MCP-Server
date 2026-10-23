# bnbills-Rechnungsvorschau

Read-only Smoobu-Kommando in `commands/smoobu/pending/`:

```json
{"id":"preview-bnbills-161136356","action":"prepare_bnbills_invoice","reservationId":161136356}
```

Das Ergebnis enthält die Rechnungsdaten, den zugehörigen bnbillsCheckinUrl-Platzhalter (falls vorhanden), fehlende Felder und den Buchungspreis.
Firmenname, Steuernummer und Rechnungsanschrift werden bei StayCil-Direktbuchungen aus den Notizzeilen ausgelesen.
Die Anschrift wird in Straße/Hausnummer, PLZ/Ort und Land aufgeteilt.
Mit `invoiceOverrides` können bestätigte einzelne Felder überschrieben werden.

**Die Vorschau löst keine Rechnung aus.** bnbills erstellt nach Formularabsendung bereits selbst eine Lexware-Rechnung.
Eine zweite direkte Lexware-Rechnung darf daher nicht zusätzlich ausgelöst werden.
Vor einer späteren echten Absendung: Freigabe einholen, bestehende Rechnung prüfen und unterstützten bnbills-Zugang verifizieren.
Ein bnbills-Link kann noch fehlen, wenn bnbills die Smoobu-Buchung noch nicht verarbeitet hat.
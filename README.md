# Concord Backend — Week 1 Scaffold

## What's here
- `models/` — Company, Vendor, Document, Dispute schemas (matches the data model we planned)
- `services/parseDocument.js` — PDF text extraction (pdf-parse) + OCR fallback (tesseract.js) + simple regex field extraction. **This is the first thing to rework in Week 2-3** once you're testing against your real sample invoices — the regexes are a starting point, not final.
- `services/reconcile.js` — the same comparison logic proven in Concord-demo.html, ported to run on real Document records. Tested working against the demo's "partial shipment" scenario.
- `routes/documents.js` — upload + parse endpoint
- `routes/disputes.js` — runs reconciliation across a PO/DN/Invoice trio, creates a Dispute, updates vendor stats
- `routes/negotiate.js` — drafts the settlement email via the Gemini API, same prompt style as the demo

## To run it
```
npm install
cp .env.example .env   # fill in MONGO_URI (MongoDB Atlas free tier) and GEMINI_API_KEY
node server.js
```

## Week 2-3 checklist (next step)
1. Collect 10-15 real sample invoices/POs/delivery notes
2. Run them through `POST /api/documents` and see what `parseStatus` comes back as
3. For anything that comes back `needs_review`, look at `extracted.raw` (the raw parsed text) and adjust the regexes in `parseDocument.js` to match your real documents' layout
4. Once parsing is reliable, wire the frontend upload flow to these endpoints

## Not built yet (by design — see the roadmap)
- Auth (single hardcoded company is fine for MVP)
- Frontend (teammate's track — dashboard should call `GET /api/disputes`)
- Vendor risk scorecard computation (stats are tracked on Vendor now, scoring logic comes in Dec-Jan phase)
- Negotiation loop / vendor replies (thread schema supports it, the reply-handling logic doesn't exist yet)

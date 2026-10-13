# Concord API

Concord checks every supplier invoice against the purchase order and the delivery challan before it is paid, settles the differences with the vendor, and tells finance what is safe to pay. Built for Indian SMEs: GSTIN validation, MSME §43B(h) payment deadlines, Indian bank statement formats.

Node 20+, Express 5, MongoDB (Mongoose 9). The AI model (Google Gemini) is optional: every AI step has a deterministic fallback.

## What it does

| Area | What happens |
| --- | --- |
| Reading documents | Layout-aware PDF text extraction (pdfjs). Rules first, Gemini only when rules are unsure. Scanned PDFs and phone photos (JPG/PNG/WebP) go to Gemini vision. Detects PO / challan / invoice automatically, pulls line items, GSTINs, dates, totals, payee bank details, with a confidence score. |
| Zero-touch matching | Documents can arrive in any order. Each joins its purchase by PO number; the purchase is re-checked every time a new document lands. |
| 13 checks | PO present, item on PO, qty over PO, short delivery, price vs PO, GST rate, line maths, total maths, total over PO, GSTIN check digit, GSTIN vs vendor, duplicate invoice, challan readable. Every flag carries expected / actual / source document / formula, GST grossed up. |
| Disputes | Auto-raised with a reference (DSP-0001), priority and 7-day reply date. AI agent drafts in three tones; manager approval (or auto-approve under a threshold); vendor reply assessed (resolved / partial / pushback) with a follow-up drafted. Combined email for several disputes with one vendor. Debit-note PDF. |
| Vendor portal | Public link per dispute (48-hex token): vendor sees the same line-by-line comparison and accepts or contests, no login. |
| Vendors | Auto-created from GSTIN/name, risk score (dispute rate, money, recency, unresolved), price history per item. |
| Fraud guard | Remembers every payee account per vendor. An invoice asking for payment to a new account is blocked in the pay run until a manager verifies it by phone (trust / reject). |
| GSTR-2B | Upload the portal JSON (or CSV): matched, value differs, not filed by supplier (ITC at risk), not in books. Vendors to chase with a ready reminder. Sample 2B generator for demos. |
| Payments | Pay run (pay / pay part / hold / blocked / not verified), bank upload CSV, 8-week cash-out forecast, MSME §43B(h) deadlines with tax-cost estimate, bank statement reconciliation (paid twice, overpaid, underpaid). |
| Autopilot | Hourly (and on overview load): vendors silent past the reply date get a firmer follow-up drafted into the approval queue. Toggle in settings. |
| Exports | Tally Prime XML (debit-note vouchers, GST split), one-page savings report PDF, audit-trail CSV, debit-note PDF per dispute. |
| Intake | API keys (hashed, shown once) for `POST /api/v1/documents`; `POST /api/inbound/email?key=` webhook for SendGrid / Mailgun / Postmark inbound email. |
| Insights | Overview KPIs, weekly flagged vs recovered, issue breakdown, activity feed, "Ask Concord" Q&A over the company's own data, audit-trail CSV. |
| Team | Admin / manager / member roles; every query is scoped to the company. |
| Demo | `POST /api/auth/demo` clones a fully populated sample company in ~200 ms. |

## Run locally

```bash
cp .env.example .env     # fill MONGO_URI and JWT_SECRET; GEMINI_API_KEY optional
npm install
npm run dev              # http://localhost:5000/api/health
```

## Deploy on Render

`render.yaml` is included. Set `MONGO_URI` (Atlas) and `GEMINI_API_KEY` (needed for photos, scanned bills, AI drafting). `JWT_SECRET` is generated automatically. Never commit `.env`.

`CORS_ORIGINS` is optional. Leave it unset to allow any site (safe here: auth is a bearer token, not a cookie), or restrict it with wildcards, e.g. `https://concord-frontend-five.vercel.app,https://concord-frontend-*.vercel.app` so Vercel preview URLs also work.

## API

All routes except auth and the vendor portal need `Authorization: Bearer <token>`.

```
POST /api/auth/register | /login | /demo     GET /api/auth/me | /team     POST /api/auth/invite    PATCH /api/auth/team/:id
POST /api/documents (multipart files[], optional type)    POST /api/documents/sample-pack {kind}
GET  /api/documents    GET|PATCH|DELETE /api/documents/:id    GET /api/documents/sample-pack/:kind/:index?seed=
GET  /api/matches      GET /api/matches/:id    POST /api/matches/:id/recheck | /release
GET  /api/disputes     GET|PATCH /api/disputes/:id
POST /api/disputes/:id/draft | /approve | /mark-sent | /reply | /resolve | /dismiss | /reopen | /note
GET  /api/disputes/:id/credit-note        POST /api/disputes/batch-draft
GET  /api/vendors      GET|PATCH /api/vendors/:id    POST /api/vendors
POST /api/payments/statement    GET /api/payments    GET /api/payments/payrun    GET /api/payments/payrun/bank-file
GET  /api/payments/forecast?weeks=8
POST /api/vendors/:id/bank-accounts/decide {account, decision: trust|reject}
POST /api/gst/2b (file or {text})    GET /api/gst/2b    GET /api/gst/2b/sample
GET  /api/reports/tally-debit-notes    GET /api/reports/savings
GET  /api/overview     GET /api/activity    POST /api/ask    GET|PUT /api/settings
POST /api/settings/api-keys {name}    DELETE /api/settings/api-keys/:prefix
POST /api/v1/documents   (X-API-Key)    POST /api/inbound/email?key=…
GET  /api/audit-trail/export
GET  /api/public/disputes/:token    POST /api/public/disputes/:token/respond
```

## Known limits

Photos and scanned PDFs need `GEMINI_API_KEY`; without it they're marked unreadable (digital PDFs still work). Emails to vendors are sent from the user's own mailbox (mailto / copy / WhatsApp) rather than by the server. Tally ledger names default to "Purchase Returns" and "Input GST" (override with `?purchaseLedger=&taxLedger=`).

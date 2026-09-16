# Concord Backend

## Auth
Real accounts now exist. POST /api/auth/register creates a company + admin user. POST /api/auth/login returns a JWT. Every other route requires `Authorization: Bearer <token>` and reads companyId/role from it — not from the request body.

Admins can add teammates via POST /api/auth/invite (roles: admin, manager, member).

## Run it
```
npm install
cp .env.example .env   # fill in MONGO_URI, GEMINI_API_KEY, JWT_SECRET
node server.js
```
Then register an account via the frontend, or run `node seed.js` for a quick demo login.

## Structure
- `models/` — Company, User, Vendor, Document, Dispute
- `middleware/auth.js` — verifies JWT, attaches req.userId/companyId/role
- `routes/auth.js` — register, login, invite
- `routes/documents.js`, `routes/disputes.js`, `routes/negotiate.js`, `routes/vendors.js` — all protected, scoped to the authenticated company
- `routes/public.js` — intentionally unauthenticated, vendor-facing response link
- `services/parseDocument.js` — regex + LLM-fallback extraction
- `services/reconcile.js` — line-item comparison engine
- `services/creditNote.js` — PDF credit note generation

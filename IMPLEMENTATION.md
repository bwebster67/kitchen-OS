# Implementation checklist

- [x] Foundation. Responsive navigation, Supabase Auth and kitchen initialization, migrations with RLS, and PWA assets.
- [x] Groceries and inventory. Rapid entry, ZXing scanning and review, product lookup proxy, batch tracking, dates, and reversible inventory changes.
- [x] Meals. Recipe editing and duplication, one-time meals, serving adjustments, batch selection, atomic cooking, leftovers, and history.
- [x] Planning. Shopping lists, missing-ingredient imports, feedback, preferences, low-stock suggestions, and recommendations.
- [x] Local reliability. Production build, 24 Vitest checks, nine desktop and mobile browser checks, Edge Function type check, and setup documentation.
- [x] Hosted deployment. The Supabase migrations, Auth settings, and product lookup function are live, and Cloudflare Pages serves the app over HTTPS. Verified owner sign-in, kitchen initialization, rejection of unauthenticated database reads, and a live Open Food Facts lookup. A rollback-only production test verified adding 2 lb, cooking with 0.5 lb, and undoing the deduction.
- [ ] Physical iPhone acceptance. Install from Safari, scan a real grocery barcode from the Home Screen app, and confirm the same inventory is visible on Windows.

The local database and browser suites use the production migrations with PostgreSQL in PGlite. Browser tests provide test Auth and product lookup responses. Where canvas video capture is available, they feed UPC-A, UPC-E, EAN-13, and EAN-8 through the real scanner, including an EAN-13 barcode rotated in a portrait frame. Follow the README to provision and test a live deployment.

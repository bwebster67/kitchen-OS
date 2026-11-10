# Implementation checklist

- [x] Foundation. Responsive navigation, Supabase Auth and kitchen initialization, migrations with RLS, and PWA assets.
- [x] Groceries and inventory. Rapid entry, ZXing scanning and review, product lookup proxy, batch tracking, dates, and reversible inventory changes.
- [x] Meals. Recipe editing and duplication, one-time meals, serving adjustments, batch selection, atomic cooking, leftovers, and history.
- [x] Planning. Shopping lists, missing-ingredient imports, feedback, preferences, low-stock suggestions, and recommendations.
- [x] Local reliability. Production build, 24 Vitest checks, nine desktop and mobile browser checks, Edge Function type check, and setup documentation.
- [ ] Hosted acceptance. Apply the migrations, configure Auth and the product lookup function, and deploy to HTTPS. Test a live product lookup, kitchen sync between Windows and iPhone, and Home Screen installation and camera scanning on a physical iPhone.

The local database and browser suites use the production migrations with PostgreSQL in PGlite. Browser tests provide test Auth and product lookup responses. Where canvas video capture is available, they feed UPC-A, UPC-E, EAN-13, and EAN-8 through the real scanner. Follow the README to provision and test a live deployment.

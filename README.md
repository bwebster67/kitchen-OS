# Kitchen OS

Kitchen OS is a mobile-first pantry, recipe, and shopping app for one household. Track separate grocery batches, review a scan before stocking it, check recipe availability, and record cooking and leftovers. The same account opens the same kitchen on Windows and iPhone.

## Set up Supabase

1. Create a **Free** project in the [Supabase dashboard](https://supabase.com/dashboard). Save the database password in your password manager. Open the project's **Connect** dialog or **Settings → API Keys** and copy the **Project URL** and **Publishable key**.
2. In the project directory, run the commands below from PowerShell with Node.js 24 LTS. Find the project reference in **Project Settings → General** or in the project dashboard URL. Supabase may ask for the database password during linking.

   ```powershell
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```

   If you prefer the SQL Editor, run the three migration files in `supabase/migrations` in filename order in a fresh project. Use either the SQL Editor or CLI migrations to initialize a project. The CLI maintains migration history for subsequent updates.

3. In **Authentication → Users**, choose **Add user → Create new user**. Enter the email and password you want to use, and select the option to confirm the email automatically. In **Authentication → Sign In / Providers**, leave Email enabled and turn off new user signups for personal use. The first successful sign-in creates your kitchen, the five built-in locations, and a Groceries list.
4. For external barcode lookup, complete the [Open Food Facts API usage form linked in its API guide](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/) and use an email that can receive messages about your integration. In **Edge Functions → Secrets**, create `OFF_CONTACT_EMAIL` with that email address. Deploy the proxy from the project directory.

   ```powershell
   npx supabase functions deploy product-lookup
   ```

   The proxy uses Supabase-provided server credentials and checks the caller's access token and kitchen membership. If deploying from the dashboard editor, turn off **Verify JWT with legacy secret** for this function so accounts using current signing keys can reach the handler. For upstream integration testing, set `OFF_USE_STAGING=true` in a separate development project before making test requests. Manual entry and the personal product catalog work even if the external proxy has yet to be configured.

References for [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [Edge Function deployment](https://supabase.com/docs/guides/functions/deploy), and [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets).

## Run on Windows

Install [Node.js 24 LTS](https://nodejs.org/en/download). Reopen PowerShell and check `node --version` before installing dependencies.

```powershell
npm ci
Copy-Item .env.example .env.local
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local` with the values from step 1. Only put the publishable key in the Vite environment.

```powershell
npm run dev
```

Open the localhost URL Vite prints and sign in with the user you created. For a local production build and preview, run `npm run build` followed by `npm run preview`. The service worker is enabled in the production bundle. Browsers treat localhost as a secure context, so a locally attached camera can be used with permission. Use the HTTPS deployment for phone camera testing.

## Deploy to Cloudflare Pages

1. Commit the project files, then push them to your GitHub repository. Keep `.env.local` outside Git.
2. In **Cloudflare → Workers & Pages**, create a **Pages** project and connect the GitHub repository. Set production branch to `main`, build command to `npm run build`, and build output directory to `dist`.
3. Set `NODE_VERSION` to `24` and add the two `VITE_SUPABASE_*` values as build environment variables. Rebuild after changing these values.
4. Deploy. In **Supabase → Authentication → URL Configuration**, set **Site URL** to the resulting `https://…pages.dev` address. Add allowed redirect URLs for your deployed and local URLs when needed for Auth email flows. Use the same deployment address on both devices. Cloudflare Pages serves client routes using its SPA fallback.

See [Cloudflare Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/) and [SPA routing](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering).

## Install on iPhone

1. Open the deployed HTTPS address in **Safari** and sign in.
2. Tap **Share → Add to Home Screen**. Enable **Open as Web App** if Safari shows that option, then tap **Add**.
3. Open **Kitchen OS** from the Home Screen. Sign in again if prompted. Go to **Add → Scan barcode → Open camera** and allow camera access.

The service worker caches the application shell. Loading and saving kitchen data requires a connection. For a physical-device smoke test, scan and confirm a packaged item on the iPhone, check the batch on Windows, then cook part of a batch and confirm the updated quantity and leftovers on both devices. Cloud reads refresh after edits, on focus or reconnect, and periodically while the app is active.

See [Apple’s Safari Home Screen instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios).

## Build and tests

```powershell
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

Vitest tests quantity math, recipe scaling and availability, deterministic recommendations, barcode lookup behavior, and the actual migrations and database functions using PostgreSQL in PGlite. Playwright runs the production PWA at desktop and iPhone viewport sizes. It stubs the network-facing Auth and Open Food Facts services, exercises the migrated PostgreSQL operations, and feeds a simulated barcode video through the real scanner. It also checks the manifest, icons and offline shell. These checks can run without a Supabase account. Hosted Auth, a live product lookup, cross-device synchronization, and Home Screen camera behavior can be confirmed after deployment.

If Chrome is installed and you want to use it for browser checks, set `$env:KITCHEN_TEST_CHANNEL = 'chrome'` before running Playwright.
To add the iPhone-sized WebKit project, run `npx playwright install webkit` and set `$env:KITCHEN_TEST_WEBKIT = '1'`.

## How it works

- `src/App.tsx` and the page components handle navigation, forms and review. `src/data.ts` connects to Supabase Auth and the Data API. TanStack Query holds the current kitchen in memory.
- `src/domain.ts` provides quantity conversion, recipe availability, batch allocation, and recommendations independently of React. PostgreSQL uses fixed-scale numeric columns. Weight and volume remain separate. Converting package contents deducts whole packages and displays that explicitly in the review. Unused contents can be added back as a measured batch.
- Inventory mutations go through a membership-checked RPC. A request UUID protects retries, revisions reject stale writes, and the kitchen lock serializes changes. Cooking, leftovers and the before/after audit commit together. Undo can reverse a transaction while the affected batches still match its saved result. Later changes can be corrected with a new adjustment.
- A product barcode is text. The scanner normalizes equivalent UPC/EAN identifiers, checks the user's catalog, and then tries the Edge Function. The proxy reserves at most 12 upstream product requests per rolling minute for the deployment and caches hits and misses separately from personal kitchen records. Product data from [Open Food Facts](https://world.openfoodfacts.org/) is available under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Review displays attribution. Respect attribution and share-alike if redistributing cached data.
- Ingredients with no entered date show an unknown date. Printed dates and estimates remain separate. Recommendations require reviewed allergen labels and explicit dietary suitability when those preferences are set. You can label an ingredient `reviewed, contains:milk` and a recipe `reviewed, suitable:gluten-free` after checking the ingredients and labels. An ingredient's `unsuitable:gluten-free` label overrides a recipe's suitability label.
- Exact quantities use US customary volume units, and prices are numeric amounts in your own currency. The app starts with an empty kitchen. See [Future integrations](FUTURE_INTEGRATIONS.md) for the planned structured-command flow.

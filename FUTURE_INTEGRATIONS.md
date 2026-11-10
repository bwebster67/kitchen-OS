# Future Apple Shortcuts and ChatGPT integration

The first release supplies the inventory operations, the `pending_commands` table and a reusable `CommandReview` component. The table is readable by kitchen members through RLS. External command ingestion and approval handlers are future work.

## Versioned command envelope

A Shortcut can use Apple’s **Use Model** action with ChatGPT to turn dictation into structured input and send it to a future authenticated endpoint. Each Shortcut request should create a UUID once and reuse it when retrying.

```json
{
  "version": 1,
  "type": "consume_ingredients",
  "idempotency_key": "9ea1ae09-2954-49fd-a31f-667502be6172",
  "payload": {
    "ingredients": [
      { "name": "ground beef", "quantity": 0.5, "unit": "lb" },
      { "name": "onion", "quantity": 1, "unit": "count" }
    ]
  }
}
```

## Ingestion and review

1. Authenticate a revocable credential and derive its user, kitchen and allowed command types on the server. Store credential hashes server-side, scope each credential to a kitchen, and apply expiry and rate limits.
2. Validate the envelope version, command type and input limits. Resolve ingredient names against that kitchen’s normalized catalog. Ask for a correction when the name, quantity, unit, batch or approximate level is ambiguous.
3. Use the same decimal conversion and batch allocation code as the UI to preview deductions. Store the submitted payload, resolved changes, issues and the request UUID in `pending_commands`. Return the existing pending ID for an identical retry and reject key reuse with different content.
4. Render the pending command with `CommandReview`. Supply an editable operation preview, require the member to address unresolved issues, and show the affected batches before confirmation.
5. On approval, authorize the member again and recheck batch revisions. Call the same database operation primitives used by the web app. Apply changes, write the inventory audit, and mark the pending command applied within one database transaction. Rejection records the review outcome without changing inventory.

Existing operations cover additions, adjustments, moves, discards, consumption, cooking with leftovers, and shopping-list writes. The `consume_ingredients` and `cook` operations use the same atomic batch deduction path. For a cooking command, include the reviewed deductions and optional leftover portions. Extend the versioned schema for future receipt imports by staging extracted grocery rows for review before applying them.

The web app uses a Supabase publishable key and the signed-in user’s session. Future credentials belong in Shortcut-controlled secure storage and server-side validation. Service-role keys remain server-only.

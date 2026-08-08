- [2026-07-02] Money is stored as integer minor units everywhere; the float rounding bug in the 2026-06 invoices came from a single `parseFloat` in the tax path and is why `currency.ts` refuses floats at the boundary.
  <!-- src:sess_3e91ab conf:high -->
- [2026-07-28] Tenant scoping is enforced in middleware, not in the query layer: a route that forgets `withTenant` returns another tenant's rows and no test catches it.
  <!-- src:sess_b0c4d2 conf:high -->

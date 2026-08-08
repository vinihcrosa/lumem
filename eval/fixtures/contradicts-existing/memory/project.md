- [2026-06-02] Auth is undecided: JWT and session cookies are both on the table.
  <!-- src:sess_5b3a71 conf:low -->
- [2026-07-19] Session tokens are stored in Redis under the key prefix sess:; the TTL is refreshed on every authenticated request, so an idle user is logged out after 30 minutes.
  <!-- src:sess_77d40e conf:medium -->

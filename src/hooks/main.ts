// lumem hook entrypoint — fail-open stub (real handlers arrive in M3).
// Contract: node lumem-hook.mjs <harnessId> <event>; payload on stdin; ALWAYS exit 0.
process.exit(0)

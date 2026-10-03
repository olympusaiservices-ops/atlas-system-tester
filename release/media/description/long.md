# Atlas System Tester

Atlas System Tester is an in-cluster diagnostic app that exercises **every app-facing
API endpoint** of the Atlas Core platform — Identity (ACCM), Email, App Store,
Network, and the Portal API — and reports the outcome of each call in a live
web UI.

## What it does

- **Full endpoint coverage.** 200+ test cases spanning all five core services,
  organised into suites you can browse and pick from.
- **Live results.** Run a selection (or everything) and watch each call's
  status, latency, request and response stream in as it happens.
- **Safe by default.** Read-only and isolated-write tests (which create a
  throwaway resource and clean it up) run by default. Destructive and
  system-altering tests are opt-in per run.
- **Auto-provisioning auth.** Sign in once with an admin account; Atlas System Tester
  obtains a user token, registers itself as an app, and mints a scoped M2M
  token so it can reach the email/app-store/network APIs.
- **Saveable test plans.** Save any combination of tests and options as a named
  plan (a JSON file you can also download and re-import) to repeat the same
  run later.
- **Run history.** Every run is stored and can be reopened for review.

## How to use

1. Open Atlas System Tester from the Portal app launcher.
2. Connect with an admin email + password.
3. Choose which suites/tests and safety levels to include.
4. Run, watch the results, and optionally save the selection as a plan.

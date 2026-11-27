# Registering the DiffProve GitHub App

DiffProve is a GitHub App. GitHub posts pull-request and installation events to
`POST /webhooks/github`. The server verifies the `X-Hub-Signature-256` HMAC and durably enqueues
PR verification jobs in BullMQ. After claiming a job, the worker creates or recovers the check
on the PR head, runs the comparison when available, and completes that exact check. This guide
covers both a local signed `ping` and live PR smoke tests.

---

## Before you start

### Prerequisites

- A checkout of this repository.
- **Node.js 20 or newer** (`node -v`). The repo declares `"engines": { "node": ">=20" }`, and
  `npm install` installs everything else.
- A GitHub account that can create GitHub Apps (your personal account, or an organization
  where you are an owner).
- A **public HTTPS URL** that forwards to your machine. GitHub will not call
  `http://localhost`. Use ngrok or cloudflared (Step 1.3).
- **Redis** for the live PR test (Docker Compose or a managed instance). The local signed `ping`
  does not use Redis, but PR enqueue fails without it.
- **E2B API key** for executing tests. Optional: **PostgreSQL** for dashboard run history.
- Optional: `openssl` (preinstalled on macOS/Linux and in Git Bash) for the bash smoke test.

### What you will end up with

| Artifact | Value |
| --- | --- |
| GitHub App | App ID, a webhook secret, and a downloaded `.pem` private key |
| `.env` | `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `REDIS_URL` |
| Local server | `POST /webhooks/github` on `PORT` (default `3000`) |
| Check run on a PR | `DiffProve: Differential Verification`, created or recovered by the worker and completed with a conclusion |
| Queue | A durable BullMQ verification job for each supported PR revision |

---

## Step 1 — Create the GitHub App

### 1.1 Open the registration form

1. Sign in to GitHub, click your avatar, then **Settings**.
2. In the left sidebar: **Developer settings** → **GitHub Apps**.
3. Click **New GitHub App**.

For an organization-owned app, use the organization's **Settings → Developer settings →
GitHub Apps → New GitHub App** instead. Keep the registration page open until Step 1.5: the App
ID and the private-key button only exist after the app is created.

### 1.2 Fill in every field

| Field on the form | What to enter for DiffProve (dev) |
| --- | --- |
| **GitHub App name** | `DiffProve (dev)`. Names are unique across all of GitHub; if it is taken, add your handle or org, e.g. `DiffProve (dev, acme)`. This is the name on the installation page, not the check-run name — the check run is fixed in code as `DiffProve: Differential Verification`. |
| **Description** | Optional, one line: `Differential PR verification for AI-authored and human tests.` |
| **Homepage URL** | Required. Your repository URL, e.g. `https://github.com/<you>/diffprove`, or the tunnel root. |
| **Identifying and authorizing users** (Callback URL, "Request user authorization during installation") | Leave the toggle off. For webhook-only setup, leave the callback URL blank; for dashboard login, use `<dashboard-origin>/api/auth/callback` and configure OAuth in Step 2. |
| **Post installation** (Setup URL, "Redirect on update") | Leave blank. |
| **Webhook → Active** | Checked. |
| **Webhook URL** | `https://<your-public-host>/webhooks/github`. The path is fixed in the server; do not use `/` or `/webhook`. See 1.3 for getting a public host locally. |
| **Webhook secret** | A strong random value you generate now. It becomes `GITHUB_WEBHOOK_SECRET`. GitHub stores it and only shows dots afterwards, so record it before saving. Commands: `openssl rand -hex 32` (bash/macOS/Linux/Git Bash), or PowerShell below. |
| **Webhook → Content type** | `application/json` (not `application/x-www-form-urlencoded`). The server verifies the HMAC over the raw JSON body and parses that body as JSON, so form encoding breaks both. |
| **SSL verification** | **Enable** (the default). Your tunnel serves HTTPS. |
| **Repository permissions → Checks** | **Read and write**. Required for the worker to find, create and update check runs. |
| **Repository permissions → Contents** | **Read-only**. Required to fetch the pinned comparison and source archives. |
| **Repository permissions → Pull requests** | **Read-only**. Gives the app read access to PR data for the `pull_request` payload; the **Pull request** event subscription below is what makes GitHub deliver the webhook. |
| **Repository permissions → Metadata** | **Read-only**, implicit and always granted. It cannot be deselected. |
| **Organization permissions** | Leave all at **No access**. |
| **Account permissions** | Leave all at **No access**. |
| **Subscribe to events** | Check **Pull request** and **Installation**. `Installation repositories` is a separate event and is not needed for this walkthrough. |
| **Where can this GitHub App be installed?** | **Only on this account** for development. The manifest sets `public: false` to match. |

Click **Create GitHub App**.

PowerShell equivalent of the secret-generation command (works in Windows PowerShell 5.1 and
PowerShell 7):

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
```

Copy the output straight into the Webhook secret field and into `.env` later. If you lose it,
set a new secret on the app page and update `.env`; old deliveries will not verify with the new
value.

### 1.3 Point the webhook at your laptop

GitHub needs a public HTTPS URL. Start a tunnel that forwards to the server's port (default
`3000`), then put the printed HTTPS host in front of `/webhooks/github`.

**ngrok:**

```bash
ngrok http 3000
```

Copy the `https://<random>.ngrok-free.app` forwarding URL and set the App's Webhook URL to
`https://<random>.ngrok-free.app/webhooks/github`.

With a static domain (requires a reserved/static domain on your ngrok plan; keeps the URL stable
across restarts):

```bash
ngrok http --domain=<your-static-domain>.ngrok-free.app 3000
```

**cloudflared (free quick tunnel):**

```bash
cloudflared tunnel --url http://localhost:3000
```

cloudflared prints a `https://<random>.trycloudflare.com` URL; the Webhook URL is
`https://<random>.trycloudflare.com/webhooks/github`.

Notes:

- The tunnel target must match the server's `PORT` (default `3000`). If you changed `PORT`, use
  `ngrok http "$PORT"` / `cloudflared tunnel --url http://localhost:"$PORT"`.
- Keep the tunnel running in its own terminal while you work. Quick-tunnel hostnames change on
  every restart, so update the App's Webhook URL (App settings → Webhook URL → Save) when they do.
  Saving sends a fresh `ping`.
- The path must be exactly `/webhooks/github`. Requests to `/` are 404s.
- ngrok runs a local inspector at `http://127.0.0.1:4040` that shows the exact request body and
  headers GitHub sent — the fastest way to debug a 401.
- If the tunnel is down when GitHub delivers, the delivery is marked failed. Fix the tunnel, then
  redeliver from **Advanced → Recent Deliveries** (Step 5 / Troubleshooting).

### 1.4 Copy the App ID

The app settings page header shows **App ID: 123456**. That numeric value is `GITHUB_APP_ID`
(also the `iss` of the App JWT used to mint installation tokens). The **Client ID** next to it is
used only when configuring dashboard OAuth.

### 1.5 Generate and download the private key

At the bottom of the same app settings page, find **Private keys** → **Generate a private key**.
The browser downloads `diffprove-dev.<date>.private-key.pem` (the exact name depends on the app
slug and date). GitHub keeps only the public half, so **this is the only download** — if you lose
the file, generate another key.

- Move it outside the repository, e.g. `~/.config/diffprove/diffprove.pem`. Never commit it and
  never paste it into an issue, chat, or log.
- Multiple keys can exist at once: rotate by generating a new key, updating `.env`, then deleting
  the old key from the app page.
- The key signs App JWTs, which are exchanged for short-lived installation tokens used to post
  check runs.

### 1.6 Alternative: register from the manifest (optional)

`.github/app-manifest.json` is a GitHub App manifest for the "create from manifest" flow. Treat
it as a **reference template**; manual registration per 1.1–1.5 is the primary path and produces
the same app. The manifest is not read by any script in this repo.

The flow, for reference:

1. POST a form-encoded `manifest` field containing the JSON to
   `https://github.com/settings/apps/new` (or
   `https://github.com/organizations/<org>/settings/apps/new`).
2. GitHub renders a pre-filled registration page; confirming it redirects to your `redirect_url`
   with a temporary `code`.
3. POST that `code` to `https://api.github.com/app-manifests/<code>/conversions`
   (unauthenticated) to receive the app's `id`, `pem`, `webhook_secret`, and remaining config.
   That response is the only time GitHub returns the private key programmatically.

If you use this flow, add a `redirect_url` to the manifest first: the reference file omits it,
and GitHub needs somewhere to send the temporary `code` that the conversion step exchanges.

Before submitting the manifest, replace the placeholders:

- `hook_attributes.url` → `https://<your-public-host>/webhooks/github`. The
  `REPLACE-WITH-YOUR-PUBLIC-HOST` placeholder is syntactically valid but unreachable, so the
  initial `ping` would fail.
- `url` → your repository or homepage URL.
- `name` → change it if `DiffProve` is already taken (names are global).

Its keys map one-to-one to the form fields: `name`, `description`, `url`,
`hook_attributes.url`, `hook_attributes.active`, `public`, `default_events`,
`default_permissions`.

---

## Step 2 — Fill `.env`

Start from the committed template:

```bash
cp .env.example .env
```

```powershell
Copy-Item .env.example .env
```

Set these values for webhook intake:

```dotenv
PORT=3000
LOG_LEVEL=info
REDIS_URL=redis://127.0.0.1:6379
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=replace-with-the-secret-you-entered-on-github
GITHUB_PRIVATE_KEY=replace-with-the-base64-or-pem-value
```

| Variable | Value | Notes |
| --- | --- | --- |
| `GITHUB_APP_ID` | The numeric **App ID** from the app settings page | Not secret. |
| `GITHUB_PRIVATE_KEY` | The `.pem` contents, preferably base64-encoded | Base64 is recommended: one line, no quoting or line-ending issues. Raw PEM is also accepted (see below). |
| `GITHUB_WEBHOOK_SECRET` | The exact secret chosen in 1.2 | Must match byte for byte; this is what makes signatures verify. |
| `REDIS_URL` | `redis://127.0.0.1:6379` (default) | Fine with `docker compose up -d redis`, or any Redis 6+. |
| `PORT` | `3000` (default) | Must match the tunnel target. |
| `LOG_LEVEL` | `info` (default) | Raise to `debug` if you are chasing a routing problem. |

Set `E2B_API_KEY` for the weak/valid test smoke runs. To see run history and edit per-repo
settings, start PostgreSQL (`docker compose up -d postgres`) and set `DATABASE_URL`. When
enabling dashboard sign-in, also set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`SESSION_SECRET`, and `PUBLIC_URL` to match the dashboard origin used for the OAuth callback.
See [`.env.example`](../.env.example) for the full configuration.

### `GITHUB_PRIVATE_KEY`

Base64-encode the downloaded key and paste the single-line output after `GITHUB_PRIVATE_KEY=`.

**bash** (GNU coreutils, including Git Bash on Windows):

```bash
base64 -w0 diffprove.pem
```

**PowerShell:**

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('diffprove.pem'))
```

macOS ships BSD `base64`, which has no `-w` flag: use `base64 < diffprove.pem | tr -d '\n'`.

Sanity check that the value decodes to a PEM (bash):

```bash
echo "$GITHUB_PRIVATE_KEY" | base64 -d | head -n 1
# -----BEGIN RSA PRIVATE KEY-----   (PKCS#1) or -----BEGIN PRIVATE KEY-----   (PKCS#8)
```

On macOS use `base64 -D`. In PowerShell, set `$key` to the decoded value and check the first line:

```powershell
$key = 'paste-the-base64-GITHUB_PRIVATE_KEY-value-here'
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($key)).Split([char]10)[0]
```

Raw PEM is also accepted: either a quoted multi-line value, or a single line with `\n` escapes
(the loader normalizes newlines back). Base64 avoids both footguns, especially when the same
`.env` is used from Windows and from a container.

Base64 is **encoding, not encryption** — protect `.env` exactly as you protect the `.pem`.

### `GITHUB_WEBHOOK_SECRET`

Paste the value from 1.2 with no surrounding quotes, no trailing spaces, and no trailing newline.
Changing it later means updating both the app page and `.env`, then restarting the server.

### `REDIS_URL`

The default works with the repository's Compose service:

```bash
docker compose up -d redis
docker compose exec redis redis-cli ping   # -> PONG
```

Any Redis 6+ works. For a managed instance, use its URL (TLS URLs are `rediss://…`) with the
credentials it requires.

### Finish

- `.env` is gitignored (`.gitignore` lists `.env` and `.env.local`); keep it that way.
- Environment variables are read when the process starts. Restart `npm run dev` after any `.env`
  edit — the file watcher only watches source files.
- Never echo these values into logs, CI output, or the sandbox (guardrail #2 in
  `docs/architecture.md`, "Key Engineering Guardrails").

---

## Step 3 — Run the server

```bash
npm install
npm run dev
```

`npm run dev` runs `tsx watch src/server.ts`, which loads `.env` at startup. On success the log
line is `DiffProve GitHub App listening on port 3000` (your `PORT`). Confirm the HTTP side:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/healthz
# 200
```

```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:3000/healthz).StatusCode
# 200
```

Leave the server running. Start Redis before Step 5: without it, enqueue attempts fail (`500`
from webhook handling). The health endpoint does not verify Redis, GitHub or E2B:

```bash
docker compose up -d redis
```

To check the dashboard too, copy `apps/web/.env.example` to `apps/web/.env.local` and run
`npm run dev:web` in a separate terminal. Use the origin printed by Next.js for `PUBLIC_URL`
and the OAuth callback if you enabled sign-in.

---

## Step 4 — Local smoke test: send a signed `ping`

GitHub sends a `ping` event when an app with an active webhook is created. Reproducing it
locally exercises raw-body HMAC verification, JSON parsing and event routing without touching
the queue. A correctly signed request returns **HTTP 200** with a body containing `pong`.

Rules for both snippets:

- Use the same secret the server is running with (`GITHUB_WEBHOOK_SECRET`).
- Send the exact JSON bytes `{"zen":"Keep it logically awesome.","hook_id":1}` with **no trailing
  newline**.

### bash

```bash
# 1. The secret currently loaded by the server.
SECRET='paste-GITHUB_WEBHOOK_SECRET-here'

# 2. Exact body bytes. No trailing newline.
BODY='{"zen":"Keep it logically awesome.","hook_id":1}'

# 3. HMAC-SHA256 over those exact bytes, lowercase hex.
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

# 4. POST it, signed.
curl -i -X POST 'http://localhost:3000/webhooks/github' \
  -H 'X-GitHub-Event: ping' \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${SIG}" \
  --data-binary "$BODY"
```

`openssl ... -r` prints `<hex> *stdin`, so `cut -d' ' -f1` extracts the digest on both OpenSSL
1.1 and 3.x.

### PowerShell

```powershell
# 1. The secret currently loaded by the server.
$secret = 'paste-GITHUB_WEBHOOK_SECRET-here'

# 2. Exact body bytes. No trailing newline.
$body = '{"zen":"Keep it logically awesome.","hook_id":1}'
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

# 3. HMAC-SHA256 over those exact bytes, lowercase hex.
$keyBytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
$hmac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
$sig = ([System.BitConverter]::ToString($hmac.ComputeHash($bodyBytes)) -replace '-', '').ToLowerInvariant()
$hmac.Dispose()

# 4. POST it, signed. Body is passed as bytes so nothing is re-encoded.
$headers = @{
  'X-GitHub-Event'      = 'ping'
  'X-Hub-Signature-256' = "sha256=$sig"
}
$response = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/webhooks/github' `
  -ContentType 'application/json' -Headers $headers -Body $bodyBytes
$response | ConvertTo-Json -Compress
```

Windows PowerShell 5.1 quirk: construct the type directly as shown. Its inherited
`[System.Security.Cryptography.HMACSHA256]::Create()` factory can return an `HMACSHA1` instance,
which yields a 40-character digest and a guaranteed `401`. `[HMACSHA256]::new($keyBytes)` always
builds the SHA-256 implementation.

### The exact-bytes rule

The signature covers **the bytes on the wire**, not a shell variable or a parsed object. Both
snippets sign `$BODY` / `$body` and send that same string, which is why they agree. Common ways
to break it:

- `echo "$BODY" | openssl ...` signs a body with a trailing `\n` that you then do not send
  (or vice versa) → valid-looking signature, `401` from the server.
- `printf '%s'` (bash) adds nothing; `echo` adds a newline. Use `printf '%s'`.
- `curl -d`/`--data` performs form-style processing (for `@file` input it strips newlines); use
  `--data-binary` so the body is byte-for-byte what you signed.
- PowerShell: pass `[Text.Encoding]::UTF8.GetBytes($body)`, not a string that a later encoding
  step might change, and do not let an editor or `Set-Content` append a newline. If the body
  lives in a file, read bytes with `[IO.File]::ReadAllBytes('ping.json')` instead of re-joining
  lines from `Get-Content`, which can drop or add the final newline.
- If you keep the body in a file, sign that file and post that file — never retype it:

```bash
printf '%s' "$BODY" > /tmp/ping.json
SIG=$(openssl dgst -sha256 -hmac "$SECRET" -r /tmp/ping.json | cut -d' ' -f1)
curl -i -X POST 'http://localhost:3000/webhooks/github' \
  -H 'X-GitHub-Event: ping' \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${SIG}" \
  --data-binary @/tmp/ping.json
```

### Expected result

```
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8

{"message":"pong"}
```

PowerShell prints `{"message":"pong"}` from the `ConvertTo-Json` line. The server log records the
ping delivery. No check run is posted and no job is queued: `ping` carries no repository or
installation context.

If you get `401`, the signature and the bytes/secret disagree — see Troubleshooting.

---

## Step 5 — End-to-end on a test repository

### 5.1 Install the app on a test repository

1. On the app's settings page, choose **Install App** in the left sidebar.
2. Pick the account, then **Only select repositories** and select a test repository (ideally one
   with a supported test runner and lockfile on its base branch).
3. Click **Install**.

This sends an `installation` webhook with action `created`; the server acknowledges it with
`200`, logs it, and records it when PostgreSQL is configured. Installation events do not create
check runs or queue jobs.

Without an installation, the App cannot mint an installation token for the repository.

### 5.2 Open or update a pull request

Make sure the tunnel is still running and still points at the server's port. Then either open a
PR from a branch, or push a new commit to an existing PR (a `synchronize` delivery), or reopen a
closed PR. GitHub sends `pull_request` for each of these; only `opened`, `synchronize`, and
`reopened` are acted on.

For live verification, follow [the Render smoke fixtures](deploy-render.md#4-smoke-test) to
open two PRs: a weak test that passes on both sides, and a valid regression test that fails by
assertion on the merge base plus the test patch and passes on the exact head. Keep dependencies
unchanged and available offline from the image, local files or a trusted base cache. The head
starts offline, so a cold cache or missing dependency can prevent the tests from running.
Public sandbox ports are disabled. For an optional third PR, add both types of case in the
same changed test file to smoke-test the mixed verdict.

If E2B reports `snapshot_filesystem_only_disabled`, enable filesystem-only snapshots and use
a compatible template and envd, or provide dependencies through a trusted prewarmed template
or vendored artifacts. The runner does not fall back to memory snapshots.

### 5.3 What you should see

1. GitHub's delivery details show **HTTP 202** once the job is enqueued. The PR's **Checks**
   tab shows **`DiffProve: Differential Verification`** on the exact delivered head SHA after
   the worker claims the job. Check creation need not be visible when the webhook returns.
2. A weak PR completes with `failure` (**Weak test**, pass/pass). A valid PR completes with
   `success` (**Verified fix**, fail/pass). With PostgreSQL configured, both comparisons should
   appear in the dashboard; supported native runners also report cases from the targeted changed
   test files, not an inventory of every edited case.
3. A PR without test changes, a disabled repository, or an unavailable runner completes with a
   neutral check rather than staying queued. After verification retries are exhausted, a separate
   durable BullMQ job retries neutral check delivery with a bounded number of attempts without
   rerunning the tests.
4. To verify recovery, manually redeliver the original event. The job identity is stable, and
   the worker uses a stable GitHub `external_id` and the persisted check ID to recover the same
   check when possible. Confirm this in the live environment; a local `ping` does not test it.

To see queued jobs in Redis (BullMQ prefixes its keys with `bull:` by default):

```bash
docker compose exec redis redis-cli --scan --pattern 'bull:*' | head
```

### 5.4 Event and response reference

| Incoming request | Server response | Side effects |
| --- | --- | --- |
| `ping` | `200` `{"message":"pong"}` | None (logged). |
| `pull_request` action `opened`, `synchronize`, `reopened` | `202` | Durable BullMQ job; the worker owns the check lifecycle. |
| Any other `pull_request` action (`edited`, `closed`, `labeled`, …) | `200` | Ignored (logged). |
| `pull_request` without installation context | `200` | Ignored with a warning; no job or check run. |
| Malformed payload for a subscribed event | `400` | Rejected; nothing enqueued. |
| `installation` (`created`, `deleted`, `new_permissions_accepted`, `suspend`, `unsuspend`) | `200` | Acknowledged and logged; applicable actions update PostgreSQL when configured. No job. |
| Missing or wrong `X-Hub-Signature-256` | `401` | Nothing enqueued. |
| Signature valid but enqueue fails | `500` | Fix the queue connection, then manually redeliver from GitHub. |

---

## Troubleshooting

### 401 from the local server

`401` means the signature did not match: either the body bytes changed in transit or
`GITHUB_WEBHOOK_SECRET` is not the value the app is signing with.

- Compare the secret character by character. Quotes, a trailing space, or a newline copied along
  with the value all break it.
- Restart the server after editing `.env` (environment variables are read once at startup).
- Confirm the app's **Webhook content type** is `application/json`. Form-encoded deliveries
  (`application/x-www-form-urlencoded`) are not the JSON body the server verifies and parses.
- Check for a proxy or tunnel that rewrites the body. ngrok's inspector (`http://127.0.0.1:4040`)
  shows the exact bytes and signature GitHub sent; compare them with what the server logged.
- Local curl: confirm you used `printf '%s'` and `--data-binary` (see "The exact-bytes rule"), and
  that the `X-Hub-Signature-256` header is present as `sha256=<hex>`.
- Make sure only one server is listening on the port, and that it is not an older process still
  holding the previous secret (`netstat -ano | findstr :3000` on Windows, `lsof -i :3000` on
  macOS/Linux).

To fix a genuine secret mismatch: update **Webhook secret** on the app settings page → **Save**,
update `.env`, restart the server, then redeliver the failed delivery.

### No check run appears

First check whether the webhook reached the server. Open the app settings page →
**Advanced → Recent Deliveries**: each row shows the event, action, HTTP status, and the response
body GitHub received. GitHub does not automatically retry failed webhook deliveries. Fix the
cause, open the failed delivery and click **Redeliver**. If the response was `202`, inspect
the worker and its GitHub API errors; webhook acknowledgement does not confirm check delivery.

GitHub and Redis cannot update atomically. If a verification job stalls, terminal reporting
depends on the fallback being able to enqueue finalization. If the handoff fails or the
finalization job exhausts its own retries, inspect both the Redis jobs and the check on the
exact PR head before intervening. Stable identifiers limit duplicate work but do not promise
exactly-once check delivery.

Other common causes:

- The app is not installed on that repository, or is installed on a different one.
- **Pull request** is not in the app's **Subscribe to events** list.
- The webhook is inactive, or its URL is wrong. It must be
  `https://<host>/webhooks/github`, matching the server's route.
- The tunnel is offline, or its hostname changed (free ngrok and trycloudflare URLs rotate on
  restart). Update the app's Webhook URL and redeliver.
- The PR action is not one of `opened` / `synchronize` / `reopened`; other actions are
  acknowledged and ignored by design.
- **Checks** permission is not **Read and write**, or the app was suspended. After changing
  permissions, the installation must accept the new permissions; GitHub sends
  `installation` → `new_permissions_accepted`.
- The delivery succeeded but you are looking at an older commit: check runs attach to the PR's
  head SHA at delivery time.

### Queue connect errors

`ECONNREFUSED 127.0.0.1:6379`, repeated `Redis is connecting`/retry logs, or `500` responses from
webhook handling mean Redis is not reachable:

- Start it: `docker compose up -d redis`, then confirm with `docker compose ps`.
- Probe it: `docker compose exec redis redis-cli ping` → `PONG`.
- Check `REDIS_URL` for a wrong host, port, or missing password; if port `6379` is already taken
  by another Redis, either use that one or remap the Compose port and update the URL.
- A managed Redis usually needs its TLS URL (`rediss://…`) and credentials.
- For a `500` enqueue failure, restore Redis, then manually redeliver the failed webhook as
  described above. Worker retries after a successful enqueue are separate from webhook delivery.

### Other symptoms

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Server exits at startup with a config error listing variables | `.env` missing or incomplete | Fill every value from Step 2 and restart. |
| `Bad credentials` / JWT or installation-token errors | `GITHUB_APP_ID` and `.pem` are from different apps, or `GITHUB_PRIVATE_KEY` did not decode | Re-paste the base64 output, verify it decodes to a PEM, and confirm the App ID on the app page. |
| `403 Resource not accessible by integration` when posting a check run | **Checks** permission is not read/write, or the app is not installed on the repo | Fix the permission, accept it on the installation, re-run. |
| `404` from the tunnel / an HTML page instead of JSON | Wrong path (`/webhook` vs `/webhooks/github`), wrong port, or the tunnel points somewhere else | Fix the Webhook URL and redeliver. |
| `502` / `ERR_NGROK_3200` | The tunnel is down or the local server is not running | Restart the server, then the tunnel; update the URL if the hostname changed. |
| Check run appears but never progresses | Worker stopped, retries are pending, or terminal delivery failed | Inspect worker logs, Redis job state and GitHub permissions/API errors. Verify the status on the exact PR head. |
| Neutral sandbox/environment result during a valid smoke PR | E2B unavailable or dependencies could not be set up offline | Check E2B credentials, the template and trusted base cache. A neutral result is not a verified fix. |

---

## Secrets and safety

- Never commit `.env` or the `.pem`. `.env` is already gitignored; keep the key outside the repo.
- Never log the webhook secret, private key, or installation tokens. Signature failures should
  log only that verification failed, not the expected or received digest.
- Base64 is encoding, not encryption. A base64 `GITHUB_PRIVATE_KEY` in `.env` is exactly as
  sensitive as the raw PEM.
- If a key leaks: generate a new private key, update `.env`, restart, then delete the old key on
  the app settings page. If the webhook secret leaks, rotate it on both sides and restart.
- GitHub App IDs and Client IDs are not secrets.

---

## Related files

- [`docs/architecture.md`](architecture.md) — system design and check lifecycle.
- [`docs/deploy-render.md`](deploy-render.md) — deployment and weak/valid live smoke fixtures.
- [`PLAN.md`](../PLAN.md) — current execution plan and shared contracts.
- [`.env.example`](../.env.example) — the environment-variable template used in Step 2.
- [`.github/app-manifest.json`](../.github/app-manifest.json) — optional manifest for Step 1.6.

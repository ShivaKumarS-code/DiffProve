# Deploying DiffProve on Render

This guide walks through deploying DiffProve to [Render](https://render.com) using the Blueprint in [`render.yaml`](../render.yaml) and the Node version pin in [`.node-version`](../.node-version) (`24`).

## 1. Prerequisites

- **GitHub account** with this repository pushed to GitHub.
- **E2B API key** from [e2b.dev/dashboard](https://e2b.dev/dashboard) (used to run differential tests inside isolated Firecracker sandboxes).
- **Render account** connected to your GitHub account.

## 2. Register the GitHub App

1. In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in the basic fields (you can use temporary placeholder URLs now and update them in Step 3 once Render assigns your service hostnames):
   - **GitHub App name**: e.g. `DiffProve` (must be globally unique on GitHub).
   - **Homepage URL**: `https://<diffprove-web>.onrender.com`
   - **Callback URL** (under *Identifying and authorizing users*):
     `https://<diffprove-web>.onrender.com/api/auth/callback`
   - **Webhook URL**:
     `https://<diffprove-api>.onrender.com/webhooks/github`
   - **Webhook secret**: generate a random secret (for example `openssl rand -hex 32`) and save it for `GITHUB_WEBHOOK_SECRET`.
3. Under **Permissions → Repository permissions**, grant:
   - **Checks**: Read and write
   - **Contents**: Read-only
   - **Pull requests**: Read-only
4. Under **Subscribe to events**, check:
   - **Pull request**
   - **Installation** (or **Installation repositories**)
5. Click **Create GitHub App**.
6. On the new App's settings page:
   - Note the **App ID** (`GITHUB_APP_ID`).
   - Note the **Client ID** (`GITHUB_CLIENT_ID`) and click **Generate a new client secret** (`GITHUB_CLIENT_SECRET`).
   - Scroll to **Private keys**, click **Generate a private key** to download the `.pem` file, then base64-encode it into a single line for `GITHUB_PRIVATE_KEY`:
     - macOS / Linux:
       ```bash
       base64 -w 0 your-app.private-key.pem
       ```
       *(On macOS, omit `-w 0` or pipe through `tr -d '\n'`.)*
     - Windows (PowerShell):
       ```powershell
       [Convert]::ToBase64String([IO.File]::ReadAllBytes("your-app.private-key.pem"))
       ```

> **Note:** Never commit `.pem` files or secrets to the repository.

## 3. Deploy the Render Blueprint

1. In the Render Dashboard, click **New + → Blueprint** and select your DiffProve GitHub repository.
2. Render will read `render.yaml` and provision:
   - `diffprove-db` (PostgreSQL, `free` plan — upgrade to `starter` or higher for production retention/uptime)
   - `diffprove-redis` (Key Value / Redis, `free` plan with `noeviction` and private-network-only `ipAllowList: []` — upgrade to `starter` for production persistence)
   - `diffprove-api` (Node web service + BullMQ worker, `starter` plan so it does not sleep after 15 minutes)
   - `diffprove-web` (Next.js dashboard, `free` plan)
3. When prompted for the `sync: false` environment variables on `diffprove-api`, enter:
   - `GITHUB_APP_ID`: your numeric GitHub App ID
   - `GITHUB_PRIVATE_KEY`: the base64-encoded `.pem` string from Step 2
   - `GITHUB_WEBHOOK_SECRET`: the webhook secret you chose in Step 2
   - `GITHUB_CLIENT_ID`: your GitHub App OAuth Client ID
   - `GITHUB_CLIENT_SECRET`: your GitHub App OAuth Client Secret
   - `E2B_API_KEY`: your E2B API key
   - `PUBLIC_URL`: leave as a temporary placeholder if Render hasn't assigned URLs yet, or fill it right after the services are created.
   *(Render automatically wires `REDIS_URL`, `DATABASE_URL`, `API_PROXY_HOSTPORT`, and generates `SESSION_SECRET`.)*
4. Once `diffprove-api` and `diffprove-web` have their `.onrender.com` URLs:
   - Set `PUBLIC_URL` on `diffprove-api` to `https://<diffprove-web>.onrender.com` (no trailing slash).
   - Update your GitHub App settings with the real URLs:
     - **Webhook URL**: `https://<diffprove-api>.onrender.com/webhooks/github`
     - **Callback URL**: `https://<diffprove-web>.onrender.com/api/auth/callback`
     - **Homepage URL**: `https://<diffprove-web>.onrender.com`

## 4. Smoke Test

1. **API health check**: Visit `https://<diffprove-api>.onrender.com/healthz` and confirm it returns HTTP `200` with `{"status":"ok"}`.
2. **Dashboard OAuth login**: Open `https://<diffprove-web>.onrender.com` and sign in with GitHub. You should be redirected back to the dashboard authenticated.
3. **Install the App**: Click **Install** (or go to your GitHub App's **Install App** tab) and install it on a test repository.
4. **Verify a PR**: Open a pull request in the test repository that adds a weak or tautological test (for example, `expect(true).toBe(true)` or `assert True`), then verify:
   - GitHub shows a **DiffProve** Check Run on the PR commit reporting that the test passed on both base and head commits.
   - The verification run and verdict appear in your DiffProve dashboard run history.

# docwalk Worker

The optional Cloudflare Worker behind docwalk's full mode (decisions 24, 36,
38). It does three things and stores nothing:

| Route                      | What it does                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`          | Lists the features this deployment offers: `oauth` when both GitHub secrets are set, `remote` when `ROOMS` is bound. |
| `POST /api/github/token`   | Exchanges a GitHub App authorization code (PKCE) for a user token, adding the client secret.                         |
| `POST /api/github/refresh` | Exchanges a refresh token for a new token pair.                                                                      |
| `GET /api/remote/:room`    | WebSocket upgrade into a remote-control room, one Durable Object per room.                                           |
| anything else              | The static app from `../dist` (unknown paths get `index.html`).                                                      |

The contract is `src/api/types.ts`; the relayed frames are `EncryptedFrame` in
`src/remote/types.ts`.

What the Worker enforces:

- Token endpoints accept only `application/json` bodies up to
  `API_LIMITS.maxBodyBytes`, only from the app origin (the `Origin` header
  must match; no CORS headers are ever sent), and only with
  `redirect_uri` equal to `<app origin>/?oauth=callback`. They return the five
  `TokenResponse` fields and nothing else from GitHub, with
  `Cache-Control: no-store`. Nothing is logged, errors included.
- Room ids must be 22 to 64 base64url characters. A room relays each text
  frame, unchanged, to every other socket in it. It drops binary frames,
  frames over `API_LIMITS.maxFrameBytes`, and anything that is not exactly
  `{ "v": 1, "iv": …, "data": … }` with base64url strings. A room holds at
  most `API_LIMITS.maxSocketsPerRoom` sockets. Messages are never stored; the
  encryption key stays in the URL fragment and never reaches the Worker.
- Every Worker response carries the security headers in `headers.ts`. Paths
  outside `/api/*` are served by Cloudflare's static assets without running
  the Worker, so `public/_headers` must hold the same headers;
  `headers.test.ts` fails when the two differ.

## Run locally

From the project folder:

```sh
pnpm build
pnpm exec wrangler dev --config worker/wrangler.jsonc
```

`wrangler dev` serves the built app and the API on one origin
(`http://localhost:8787`). Rebuild after changing the app. To try sign-in,
put the development GitHub App's credentials in `worker/.dev.vars` (ignored
by git):

```sh
GITHUB_CLIENT_ID=Iv23...
GITHUB_CLIENT_SECRET=...
```

Use a separate GitHub App for development, with the callback URL
`http://localhost:8787/?oauth=callback`.

Tests run inside workerd through `@cloudflare/vitest-plugin` (decision 44):

```sh
pnpm exec vitest run --config worker/vitest.config.ts
```

## Deploy

```sh
pnpm build
pnpm exec wrangler deploy --config worker/wrangler.jsonc
pnpm exec wrangler secret put GITHUB_CLIENT_ID --config worker/wrangler.jsonc
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.jsonc
```

From GitHub, `.github/workflows/docwalk-deploy-cloudflare.yml` runs the same
build and deploy when started by hand. It reads `CLOUDFLARE_API_TOKEN` (and
`CLOUDFLARE_ACCOUNT_ID` when the token reaches several accounts) from the
repository secrets; the two GitHub secrets above stay Worker secrets.

Secrets take effect without a redeploy. Leave them unset to deploy without
sign-in: `/api/health` then omits `oauth` and the app hides the button.

`APP_ORIGIN` in `wrangler.jsonc` is empty by default, which means "the
origin the request came to". Set it to pin one origin, for example
`https://docwalk.example` when the Worker also answers on `workers.dev`:
token requests from any other origin are then refused.

`observability` and Wrangler's `send_metrics` are off: docwalk ships no
telemetry (decision 12).

## Register the GitHub App

On GitHub: Settings → Developer settings → GitHub Apps → New GitHub App.

| Setting                                                | Value                                     |
| ------------------------------------------------------ | ----------------------------------------- |
| Homepage URL                                           | `<origin>`                                |
| Callback URL                                           | `<origin>/?oauth=callback`                |
| Expire user authorization tokens                       | on                                        |
| Request user authorization (OAuth) during installation | off                                       |
| Enable Device Flow                                     | off                                       |
| Webhook → Active                                       | off (no webhook URL)                      |
| Repository permissions → Contents                      | Read-only                                 |
| All other permissions                                  | No access (Metadata read-only is implied) |
| Where can this GitHub App be installed?                | Any account, for a public deployment      |

`<origin>` is where the app is served, for example
`https://docwalk.example`, with no trailing slash. After creating the app,
copy its Client ID and generate a client secret; those are the two secrets
above.

"Expire user authorization tokens" must stay on: the Worker refuses a GitHub
answer without a refresh token, and the app refreshes the 8-hour token
before it runs out. A user signs in once, then installs the app on the
repositories docwalk may read; the token reaches nothing else.

## Self-host modes (decision 38)

- **Static**: copy `dist/` to any static host. There is no `/api`, so the app
  hides sign-in and remote control; pasted tokens, `?src=` and the presenter
  window still work. The CSP comes from a `<meta>` tag, which cannot carry
  `frame-ancestors`, so the page can be framed. Prefer a host that can set
  headers and copy `public/_headers` into its configuration.
- **Full**: `wrangler deploy` as above, with your own GitHub App. Sign-in and
  remote control both work.
- **Full without sign-in**: deploy without the two secrets.
- **Full without remote control**: delete the `durable_objects` and
  `migrations` blocks from `wrangler.jsonc` before the first deploy.
  `/api/health` then omits `remote`. On an existing deployment, removing the
  class needs a `deleted_classes` migration instead.

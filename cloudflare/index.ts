import { Container } from "@cloudflare/containers";

export interface Env {
  LINKFORTY: DurableObjectNamespace;
  DATABASE_URL: string;
  REDIS_URL?: string;
}

/**
 * LinkForty Core as a Cloudflare Container.
 *
 * The image is the repo's root Dockerfile (Node/Fastify on port 3000, runs
 * migrations then examples/basic-server.ts). Containers have ephemeral disk
 * and no sidecars, so Postgres/Redis live externally and reach the app via
 * DATABASE_URL / REDIS_URL injected at start time (see below).
 */
export class LinkFortyContainer extends Container {
  defaultPort = 3000;
  requiredPorts = [3000];
  sleepAfter = "30m";
  enableInternet = true; // required for outbound Postgres/Redis connections
  // Liveness only — /health/ready would fail when the external DB is slow,
  // which would make the platform kill a healthy process.
  pingEndpoint = "/health";

  envVars = {
    NODE_ENV: "production",
    // Pin the port so the app and defaultPort always agree, whatever the
    // platform injects (custom envVars override runtime-provided ones).
    PORT: "3000",
    HOST: "0.0.0.0",
    CORS_ORIGIN: "*",
    // We sit behind Cloudflare's proxy: read client IP from X-Forwarded-For.
    TRUST_PROXY: "1",
  };
}

// LinkForty is a redirect engine: every path is a /:shortCode lookup, so "/"
// would surface the app's JSON 404. Serve a human-readable status page there
// instead; everything else proxies through.
function landingPage(url: URL): Response {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LinkForty Core</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 4rem auto; padding: 0 1.5rem; color: #1a1a2e; }
  h1 { font-size: 1.6rem; } h1 span { color: #4f8cff; }
  .ok { display: inline-block; padding: .15rem .6rem; border-radius: 1rem;
        background: #e6f6ec; color: #0a7d38; font-size: .85rem; font-weight: 600; }
  code { background: #f2f4f8; padding: .1rem .4rem; border-radius: .3rem; font-size: .9em; }
  li { margin: .4rem 0; }
  footer { margin-top: 2.5rem; color: #777; font-size: .85rem; }
</style>
</head>
<body>
  <h1>LinkForty Core <span>·</span> <span class="ok">running</span></h1>
  <p>This is a <strong>deeplink management API</strong>, not a website — every
     path is treated as a short link, which is why unknown ones return
     <code>{"error":"Link not found"}</code>.</p>
  <ul>
    <li><code>GET /:shortCode</code> — redirect (e.g. <a href="/health">/health</a> is reserved)</li>
    <li><code>GET /health</code> · <code>GET /health/ready</code> — liveness / database check</li>
    <li><code>POST /api/links</code> — create a link (<code>userId</code> UUID, <code>originalUrl</code>)</li>
    <li><code>GET /api/links?userId=…</code> — list links</li>
    <li><code>GET /api/analytics/overview?userId=…</code> — analytics</li>
    <li><code>GET /api/sdk/v1/health</code> — SDK health</li>
  </ul>
  <footer>host: ${url.hostname}</footer>
</body>
</html>`;
  return new Response(page, {
    headers: { "content-type": "text/html;charset=utf8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return landingPage(url);
    // Singleton: the image runs `migrate.js` on boot, so a single instance
    // avoids concurrent-migration races.
    const container = env.LINKFORTY.getByName("singleton");

    // No-op once the container is running; injects secrets on cold start.
    await container.startAndWaitForPorts({
      startOptions: {
        envVars: {
          DATABASE_URL: env.DATABASE_URL,
          ...(env.REDIS_URL ? { REDIS_URL: env.REDIS_URL } : {}),
        },
      },
    });

    // fetch() (not containerFetch) — safe default even though this app
    // registers no WebSocket routes today.
    return container.fetch(request);
  },
};

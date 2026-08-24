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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

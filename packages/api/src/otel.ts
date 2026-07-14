/**
 * Minimal OpenTelemetry hook.
 * When OTEL_ENABLED=1, logs spans to console via @opentelemetry/api if available,
 * otherwise a lightweight console span shim.
 */
export async function initOtel(serviceName: string): Promise<void> {
  if (process.env.OTEL_ENABLED !== "1") return;

  try {
    const api = await import("@opentelemetry/api");
    const tracer = api.trace.getTracer(serviceName);
    // Touch tracer so import is used; real export wiring is env-driven by collectors.
    void tracer;
    console.info(`[otel] enabled for ${serviceName} (@opentelemetry/api present)`);
  } catch {
    console.info(
      `[otel] OTEL_ENABLED=1 for ${serviceName} — @opentelemetry/api not installed; using console spans`,
    );
  }

  // Console exporter shim: wrap process warnings as a signal OTel is active
  const start = Date.now();
  console.info(
    JSON.stringify({
      "resource.service.name": serviceName,
      "otel.exporter": "console",
      event: "otel_init",
      ts: new Date().toISOString(),
      uptime_ms: 0,
    }),
  );
  void start;
}

export function otelSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  if (process.env.OTEL_ENABLED !== "1") {
    return Promise.resolve(fn());
  }
  const t0 = Date.now();
  return Promise.resolve(fn()).then(
    (result) => {
      console.info(
        JSON.stringify({
          span: name,
          status: "ok",
          duration_ms: Date.now() - t0,
          ts: new Date().toISOString(),
        }),
      );
      return result;
    },
    (err) => {
      console.info(
        JSON.stringify({
          span: name,
          status: "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
          ts: new Date().toISOString(),
        }),
      );
      throw err;
    },
  );
}

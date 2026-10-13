/** Quota failures can occur before the Durable Object's fetch handler runs. */
export function quotaResponse(error: unknown): Response | null {
  if (!error || typeof error !== "object" || !("message" in error) ||
      error.message !== "Exceeded allowed rows read in Durable Objects free tier.") return null;
  const now = Date.now();
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return Response.json({
    code: "durable_objects_daily_read_limit",
    error: "Cloudflare Durable Objects daily database read limit exceeded. The free limit resets at 00:00 UTC.",
    retry_at: reset.toISOString(),
  }, {status: 503, headers: {
    "Cache-Control": "no-store",
    "Retry-After": String(Math.max(1, Math.ceil((reset.getTime() - now) / 1000))),
  }});
}

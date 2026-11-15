import { createClient } from "@supabase/supabase-js";
import { WEATHER_SAMPLE_EVENT } from "./weatherTopic";

/**
 * Announce that a weather sample was written for one cell.
 *
 * The payload is a signal, not data: `{ location, observed_at }`. Readings stay
 * behind `/api/weather`, which reads them server-side, so a public broadcast
 * channel never exposes the samples themselves. Listeners refetch that route.
 *
 * Best effort by design — the database write already happened, so a missing
 * environment or a dropped socket must never surface as a failed request.
 */

let warned = false;

export function broadcastWeatherSample(locationKey: string, observedAt: string): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (!warned) {
      warned = true;
      console.warn(
        "[weather] live updates disabled: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set, so the panel will not refresh on new samples.",
      );
    }
    return;
  }

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const channel = client.channel(`weather:${locationKey}`, { config: { broadcast: { self: false } } });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(guard);
    void client.removeChannel(channel);
  };
  // A socket that never subscribes must not outlive the request.
  const guard = setTimeout(close, 5000);

  channel.subscribe((status) => {
    if (status !== "SUBSCRIBED") {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") close();
      return;
    }
    void channel
      .send({
        type: "broadcast",
        event: WEATHER_SAMPLE_EVENT,
        payload: { location: locationKey, observed_at: observedAt },
      })
      .finally(close);
  });
}

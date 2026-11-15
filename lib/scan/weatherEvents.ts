import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
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

/** One client for the process: building one per write opened a socket each time. */
let client: SupabaseClient | null = null;
/** Channels share that client's single socket; one per cell we publish to. */
const publishers = new Map<string, RealtimeChannel>();
const MAX_CHANNELS = 24;
const JOIN_TIMEOUT_MS = 5000;

let warnedMissingEnv = false;
let warnedFailure = false;

function weatherClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.warn(
        "[weather] live updates disabled: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set, so the panel will not refresh on new samples.",
      );
    }
    return null;
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Joined channels are reused; a channel left behind by a dropped socket is replaced. */
function channelFor(cell: string): RealtimeChannel | null {
  const db = weatherClient();
  if (!db) return null;
  const existing = publishers.get(cell);
  if (existing) return existing;

  const channel = db.channel(`weather:${cell}`, { config: { broadcast: { self: false } } });
  channel.subscribe();
  publishers.set(cell, channel);

  // Bounded so a long-lived process cannot hold a channel per cell forever.
  while (publishers.size > MAX_CHANNELS) {
    const oldest = publishers.keys().next().value;
    if (oldest === undefined || oldest === cell) break;
    const stale = publishers.get(oldest);
    publishers.delete(oldest);
    if (stale) void db.removeChannel(stale);
  }
  return channel;
}

/** A send on an unjoined channel is dropped, so give a reconnect a moment to finish. */
async function waitForJoin(channel: RealtimeChannel): Promise<boolean> {
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  for (;;) {
    if (channel.state === "joined") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function publish(cell: string, observedAt: string): Promise<void> {
  const db = weatherClient();
  if (!db) return;
  const channel = channelFor(cell);
  if (!channel) return;
  if (!(await waitForJoin(channel))) return;
  const result = await channel.send({
    type: "broadcast",
    event: WEATHER_SAMPLE_EVENT,
    payload: { location: cell, observed_at: observedAt },
  });
  if (result !== "ok") {
    // Drop the channel so the next write rebuilds it rather than reusing a dead one.
    publishers.delete(cell);
    void db.removeChannel(channel);
    throw new Error(`weather broadcast to ${cell} returned ${result}`);
  }
}

export function broadcastWeatherSample(locationKey: string, observedAt: string): void {
  void publish(locationKey, observedAt).catch((error: unknown) => {
    if (warnedFailure) return;
    warnedFailure = true;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[weather] live update failed: ${detail}`);
  });
}

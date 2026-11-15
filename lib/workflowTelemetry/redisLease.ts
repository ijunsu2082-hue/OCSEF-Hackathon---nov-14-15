const env = () => {
  const url = process.env.WORKFLOW_TELEMETRY_REDIS_URL;
  const token = process.env.WORKFLOW_TELEMETRY_REDIS_TOKEN;
  if (!url || !token) throw new Error("WORKFLOW_TELEMETRY_REDIS_URL and WORKFLOW_TELEMETRY_REDIS_TOKEN are required");
  return { url: url.replace(/\/$/, ""), token };
};

async function command<T>(args: (string | number)[]): Promise<T> {
  const { url, token } = env();
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Redis REST returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(String(payload.error));
  return payload.result as T;
}

export async function acquireLease(key: string, token: string, ttlMs: number): Promise<boolean> {
  return (await command<string | null>(["SET", key, token, "NX", "PX", ttlMs])) === "OK";
}

export async function releaseLease(key: string, token: string): Promise<void> {
  await command<number>(["EVAL", "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token]);
}

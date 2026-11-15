"use client";

import { createClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { WEATHER_SAMPLE_EVENT, weatherTopic } from "./weatherTopic";

export type WeatherSource = "live" | "persisted" | "historical" | "none";

export interface WeatherSample {
  time: string;
  temp_c: number;
  wind_mps: number;
  wind_direction_deg: number;
  shortwave_wm2: number;
  provider: "open-meteo";
}

export interface WeatherStatus {
  current: WeatherSample | null;
  source: WeatherSource;
  fetched_at: string | null;
}

export interface WeatherPoint {
  lat: number;
  lon: number;
}

export interface WeatherRequestState {
  weather: WeatherStatus | null;
  pending: boolean;
  error: boolean;
}

export function useWeatherSample(point: WeatherPoint | null): WeatherRequestState {
  const [weather, setWeather] = useState<WeatherStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  /** Bumped by a broadcast or a reconnect: the stored sample may be newer. */
  const [revision, setRevision] = useState(0);
  const cellShown = useRef<string | null>(null);
  const subscribedBefore = useRef(false);

  // Live updates. The broadcast carries only "a sample landed for this cell",
  // so readings still come from /api/weather and no weather row is streamed.
  useEffect(() => {
    if (!point) return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;

    subscribedBefore.current = false;
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const channel = client
      .channel(weatherTopic(point.lat, point.lon))
      .on("broadcast", { event: WEATHER_SAMPLE_EVENT }, () => setRevision((n) => n + 1))
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        // The first subscribe follows the mount fetch. Later ones are reconnects,
        // where anything broadcast while offline was dropped — refetch then.
        if (subscribedBefore.current) setRevision((n) => n + 1);
        else subscribedBefore.current = true;
      });

    return () => { void client.removeChannel(channel); };
  }, [point?.lat, point?.lon]);

  useEffect(() => {
    if (!point) {
      setWeather(null);
      setPending(false);
      setError(false);
      cellShown.current = null;
      return;
    }

    const controller = new AbortController();
    // A live update refetches the same cell, so keep the reading on screen
    // instead of flashing back to a pending state.
    const cell = `${point.lat},${point.lon}`;
    const newCell = cellShown.current !== cell;
    cellShown.current = cell;
    if (newCell) {
      setWeather(null);
      setPending(true);
    }
    setError(false);
    const params = new URLSearchParams({ lat: String(point.lat), lon: String(point.lon) });
    fetch(`/api/weather?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Weather request failed (${response.status})`);
        return (await response.json()) as WeatherStatus;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setWeather(payload);
        setPending(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
        setPending(false);
      });

    return () => controller.abort();
  }, [point?.lat, point?.lon, revision]);

  return { weather, pending, error };
}

export function weatherSampleAgeLabel(time: string | null): string {
  if (!time) return "age unavailable";
  const value = /(?:Z|[+-]\d{2}:?\d{2})$/.test(time) ? time : `${time}:00Z`;
  const stamp = new Date(value).getTime();
  if (!Number.isFinite(stamp)) return "age unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60_000));
  if (minutes < 60) return `${minutes} min old`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} hr old`;
  return `${Math.floor(minutes / (60 * 24))} d old`;
}

export function weatherSourceLabel(source: WeatherSource): string {
  switch (source) {
    case "live": return "Live weather";
    case "persisted": return "Last saved weather";
    case "historical": return "Historical weather";
    default: return "No current weather";
  }
}

/** [lon,lat] GeoJSON polyline midpoint, weighted by geographic segment length. */
export function pointOnCorridor(coordinates: [number, number][]): WeatherPoint | null {
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return { lat: coordinates[0][1], lon: coordinates[0][0] };
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const distance = (a: [number, number], b: [number, number]) => {
    const dLat = radians(b[1] - a[1]);
    const dLon = radians(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const lengths = coordinates.slice(1).map((point, index) => distance(coordinates[index], point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= 0) return { lat: coordinates[0][1], lon: coordinates[0][0] };
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const fraction = length > 0 ? remaining / length : 0;
      const [aLon, aLat] = coordinates[index];
      const [bLon, bLat] = coordinates[index + 1];
      return { lat: aLat + (bLat - aLat) * fraction, lon: aLon + (bLon - aLon) * fraction };
    }
    remaining -= length;
  }
  return { lat: coordinates[0][1], lon: coordinates[0][0] };
}

/** Geographic bearing of the longest corridor segment, clockwise from north. */
export function corridorBearingDeg(coordinates: [number, number][]): number | null {
  if (coordinates.length < 2) return null;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  let bestLength = -1;
  let bestBearing = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [lon1, lat1] = coordinates[index - 1];
    const [lon2, lat2] = coordinates[index];
    const phi1 = radians(lat1);
    const phi2 = radians(lat2);
    const deltaLon = radians(lon2 - lon1);
    const y = Math.sin(deltaLon) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);
    const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const dLat = phi2 - phi1;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLon / 2) ** 2;
    const length = 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    if (length > bestLength) {
      bestLength = length;
      bestBearing = bearing;
    }
  }
  return bestLength > 0 ? bestBearing : null;
}

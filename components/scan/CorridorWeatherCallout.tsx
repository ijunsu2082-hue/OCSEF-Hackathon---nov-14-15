"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtNumber } from "@/lib/format";
import {
  conductorForVoltage,
  heatwaveWireSummary,
  hourLabel,
  latestArchiveWeather,
  RATING_FALLBACK_CSV_URL,
  RATING_CSV_URL,
  rateWeatherSample,
  type WireHour,
} from "@/lib/scan/wire";
import {
  corridorBearingDeg,
  pointOnCorridor,
  useWeatherSample,
  weatherSampleAgeLabel,
  weatherSourceLabel,
} from "@/lib/scan/useWeatherSample";

interface Props {
  coordinates: [number, number][];
  voltage: number | null;
  heatwave?: boolean;
}

async function fetchArchive(url: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(url, { signal });
  return response.ok ? response.text() : null;
}

export default function CorridorWeatherCallout({ coordinates, voltage, heatwave = false }: Props) {
  const [csv, setCsv] = useState<string | null>(null);
  const [archivePending, setArchivePending] = useState(true);
  const [archiveError, setArchiveError] = useState(false);
  const point = useMemo(() => pointOnCorridor(coordinates), [coordinates]);
  const bearing = useMemo(() => corridorBearingDeg(coordinates), [coordinates]);
  const { weather, pending, error } = useWeatherSample(point);

  useEffect(() => {
    const controller = new AbortController();
    setCsv(null);
    setArchivePending(true);
    setArchiveError(false);
    fetchArchive(RATING_CSV_URL, controller.signal)
      .then((primary) => primary ?? fetchArchive(RATING_FALLBACK_CSV_URL, controller.signal))
      .then((archive) => {
        if (controller.signal.aborted) return;
        setCsv(archive);
        setArchiveError(!archive);
        setArchivePending(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setArchiveError(true);
        setArchivePending(false);
      });
    return () => controller.abort();
  }, []);

  const archiveSample = useMemo(
    () => csv ? latestArchiveWeather(csv) : null,
    [csv],
  );
  const archiveYear = archiveSample?.time.slice(0, 4) ?? "";
  const liveRating: WireHour | null =
    voltage !== null && weather?.current ? rateWeatherSample(voltage, weather.current) : null;
  const bundledRating: WireHour | null =
    voltage !== null && archiveSample ? rateWeatherSample(voltage, archiveSample) : null;
  const rating = liveRating ?? bundledRating;
  const simulated = voltage === null ? null : heatwaveWireSummary(voltage);
  const ratingRatio = heatwave ? simulated?.ratio : rating?.ratio;
  const provenance = weather?.current
    ? weatherSourceLabel(weather.source)
    : bundledRating
      ? `Bundled ${archiveYear} archive`
      : "No weather sample";

  return (
    <aside className="corridor-weather-callout" aria-label="Selected corridor weather rating">
      <header className="corridor-weather-head">
        <b>Corridor weather</b>
        {voltage !== null ? (
          <span>{conductorForVoltage(voltage)} · {fmtNumber(voltage, 0)} kV</span>
        ) : (
          <span>Voltage unavailable</span>
        )}
      </header>

      {pending || archivePending ? <p>Loading weather and archived comparison…</p> : null}
      {voltage === null ? <p>No voltage value for this selected line.</p> : null}
      {rating && voltage !== null ? (
        <div className="corridor-weather-values">
          <b>{heatwave ? `${fmtNumber(simulated?.ratio ?? 1, 2)}×` : `${fmtNumber(ratingRatio ?? 0, 2)}×`}</b>
          <span>
            {heatwave ? "Simulated 105 °F heatwave" : provenance}
            {` · ${weather?.current ? hourLabel(weather.current.time) + " UTC" : hourLabel(rating.time) + " Pacific"}`}
            {` · ${weatherSampleAgeLabel(rating.time)}`}
          </span>
        </div>
      ) : null}

      {rating && voltage !== null ? (
        <dl>
          <div><dt>Still-air rating</dt><dd>{fmtNumber(rating.still_a, 0)} A</dd></div>
          <div><dt>{heatwave ? "Heatwave rating ratio" : "Weather-based rating"}</dt>
            <dd>{heatwave ? `${fmtNumber(simulated?.ratio ?? 1, 2)}×` : `${fmtNumber(rating.breeze_a, 0)} A`}</dd></div>
          {weather?.current ? <div><dt>Ambient / wind speed</dt>
            <dd>{fmtNumber(weather.current.temp_c, 1)} °C · {fmtNumber(weather.current.wind_mps, 1)} m/s</dd></div> : null}
          {weather?.current ? <div><dt>Wind direction (from)</dt>
            <dd>{Math.round(weather.current.wind_direction_deg)}°</dd></div> : null}
          {bearing !== null ? <div><dt>Corridor bearing</dt>
            <dd>{Math.round(bearing)}° clockwise from north</dd></div> : null}
        </dl>
      ) : null}

      {error || archiveError ? <p>Current weather or bundled archive is unavailable.</p> : null}
      <p className="corridor-weather-note">
        MODELED (IEEE 738 screening), not an operating rating. Wind direction is a meteorological
        bearing from north; the screening model uses wind speed and does not adjust for line heading.
      </p>
    </aside>
  );
}

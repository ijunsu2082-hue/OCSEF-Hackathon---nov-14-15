-- Weather samples move out of `.data/weather.sqlite` and into Postgres.
--
-- `lib/scan/weather.ts` reads and writes these tables with the service role key,
-- which is the only role allowed to touch them: RLS is on with no policy, so a
-- public (anon) client cannot read operational weather state. The weather
-- collector (`scripts/weather-collector.ts`) and `GET /api/weather` are the
-- writers.

create table if not exists public.weather_locations (
  location_key   text primary key,                -- 'lat,lon' rounded to 3 dp
  lat            double precision not null,
  lon            double precision not null,
  first_seen_at  timestamptz not null,
  last_seen_at   timestamptz not null
);

create index if not exists weather_locations_recent_idx
  on public.weather_locations(last_seen_at desc);

create table if not exists public.weather_samples (
  location_key        text not null references public.weather_locations(location_key) on delete cascade,
  observed_at         timestamptz not null,
  temp_c              double precision not null,
  wind_mps            double precision not null,
  wind_direction_deg  double precision not null,
  shortwave_wm2       double precision not null,
  provider            text not null default 'open-meteo',
  primary key (location_key, observed_at)
);

create index if not exists weather_samples_recent_idx
  on public.weather_samples(location_key, observed_at desc);

-- Reconcile a project created from an older shape of these tables.
alter table public.weather_locations add column if not exists lat double precision;
alter table public.weather_locations add column if not exists lon double precision;
alter table public.weather_locations add column if not exists first_seen_at timestamptz;
alter table public.weather_locations add column if not exists last_seen_at timestamptz;
alter table public.weather_samples   add column if not exists observed_at timestamptz;
alter table public.weather_samples   add column if not exists temp_c double precision;
alter table public.weather_samples   add column if not exists wind_mps double precision;
alter table public.weather_samples   add column if not exists wind_direction_deg double precision;
alter table public.weather_samples   add column if not exists shortwave_wm2 double precision;
alter table public.weather_samples   add column if not exists provider text default 'open-meteo';

alter table public.weather_locations enable row level security;
alter table public.weather_samples   enable row level security;

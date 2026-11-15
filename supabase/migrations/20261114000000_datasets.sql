-- Mapergy datasets: schema for everything that used to live in data/ and public/layers/.
-- Geometry is stored as GeoJSON (jsonb) plus lon/lat for points, so no PostGIS dependency.
-- All tables are public, read-only reference data: RLS on, anon/authenticated may SELECT.

create table if not exists public.regions (
  id            text primary key,
  name          text not null,
  state         text,
  center_lat    double precision not null,
  center_lon    double precision not null,
  radius_miles  double precision,
  bounds        jsonb,             -- [[south, west], [north, east]]
  grid_zone     text
);

create table if not exists public.nodes (
  id                text primary key,
  region_id         text not null references public.regions(id) on delete cascade,
  name              text not null,
  type              text,
  lon               double precision not null,
  lat               double precision not null,
  provider          jsonb,
  infrastructure    jsonb,
  energy_profile    jsonb,
  upgrade_potential jsonb,
  sort_order        int not null default 0
);
create index if not exists nodes_region_idx on public.nodes(region_id);

create table if not exists public.node_flows (
  id         text primary key,
  region_id  text not null references public.regions(id) on delete cascade,
  from_node  text not null references public.nodes(id) on delete cascade,
  to_node    text not null references public.nodes(id) on delete cascade,
  label      text,
  mva        double precision,
  sort_order int not null default 0
);

create table if not exists public.plants (
  plant_code                  int primary key,
  plant_name                  text not null,
  utility_name                text,
  distance_mi                 double precision,
  county                      text,
  city                        text,
  balancing_authority         text,
  sector                      text,
  grid_voltage_kv             double precision,
  nameplate_mw                double precision,
  mw_by_source                jsonb,
  oldest_year                 int,
  newest_year                 int,
  planned_retirement_mw       double precision,
  generator_count             int,
  primary_source              text,
  technologies                text[],
  capacity_weighted_year      int,
  capacity_weighted_age_years int,
  lon                         double precision not null,
  lat                         double precision not null,
  sort_order                  int not null default 0
);

create table if not exists public.substations (
  osm_id      text primary key,
  name        text,
  operator    text,
  voltage_kv  double precision,
  substation  text,
  lon         double precision not null,
  lat         double precision not null,
  sort_order  int not null default 0
);

create table if not exists public.transmission_lines (
  osm_id      bigint primary key,
  voltage_kv  double precision,
  operator    text,
  name        text,
  cables      text,
  circuits    text,
  line        text,
  geometry    jsonb not null,      -- GeoJSON LineString
  sort_order  int not null default 0
);

create table if not exists public.niche_cases (
  id           text primary key,
  title        text not null,
  category     text,
  location     jsonb,
  one_liner    text,
  problem      text,
  fix          text,
  shock_line   text,
  stats        jsonb,
  team_bullets jsonb,
  chart        jsonb,
  sort_order   int not null default 0
);

create table if not exists public.line_ratings (
  dataset                     text not null default 'westminster_hs_2024',
  time                        timestamp not null,  -- local hour as in the source CSV
  temp_c                      double precision,
  wind_ms                     double precision,
  sun_wm2                     double precision,
  static_a                    double precision,
  aar_a                       double precision,
  dlr_a                       double precision,
  dlr_conservative_a          double precision,
  dlr_vs_static               double precision,
  dlr_conservative_vs_static  double precision,
  primary key (dataset, time)
);

-- FeatureCollection-level metadata (source, license, center, radius) per layer.
create table if not exists public.layer_metadata (
  layer    text primary key,
  metadata jsonb not null
);

do $$
declare t text;
begin
  foreach t in array array['regions','nodes','node_flows','plants','substations',
                           'transmission_lines','niche_cases','line_ratings','layer_metadata']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

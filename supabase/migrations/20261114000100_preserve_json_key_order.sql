-- jsonb re-sorts object keys (e.g. mw_by_source {solar, battery} -> {battery, solar}),
-- which changes legend/chart order in the UI. json keeps the source text and key order.
alter table public.regions            alter column bounds            type json using bounds::json;
alter table public.nodes              alter column provider          type json using provider::json,
                                      alter column infrastructure    type json using infrastructure::json,
                                      alter column energy_profile    type json using energy_profile::json,
                                      alter column upgrade_potential type json using upgrade_potential::json;
alter table public.plants             alter column mw_by_source      type json using mw_by_source::json;
alter table public.transmission_lines alter column geometry          type json using geometry::json;
alter table public.niche_cases        alter column location          type json using location::json,
                                      alter column stats             type json using stats::json,
                                      alter column team_bullets      type json using team_bullets::json,
                                      alter column chart             type json using chart::json;
alter table public.layer_metadata     alter column metadata          type json using metadata::json;

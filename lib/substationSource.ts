export function osmSubstationSource(id: unknown) {
  if (typeof id !== "string" || !/^(node|way|relation)\/[1-9]\d*$/.test(id)) return null;
  return { id, url: `https://www.openstreetmap.org/${id}` };
}

export function substationSourceCard(properties: {
  name?: string | null;
  osm_id?: unknown;
  operator?: string | null;
  voltage_kv?: number | null;
}): HTMLElement {
  const card = document.createElement("div");
  card.style.color = "#172033";
  const title = document.createElement("strong");
  title.textContent = properties.name?.trim() || "Name unavailable";
  card.append(title);
  const details = document.createElement("p");
  const operator = properties.operator?.trim() || "Operator unavailable";
  const voltage = properties.voltage_kv && properties.voltage_kv > 0
    ? `${properties.voltage_kv} kV (OSM tag)`
    : "Voltage unavailable";
  details.textContent = `${operator} · ${voltage}`;
  card.append(details);
  const source = osmSubstationSource(properties.osm_id);
  if (source) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.color = "#1746a2";
    link.textContent = `OpenStreetMap ${source.id}`;
    card.append(link);
    const caveat = document.createElement("p");
    caveat.textContent = "Community-mapped record. Map tags come from the bundled extract. Utility confirmation unavailable.";
    card.append(caveat);
  } else {
    card.append("Source record unavailable");
  }
  return card;
}

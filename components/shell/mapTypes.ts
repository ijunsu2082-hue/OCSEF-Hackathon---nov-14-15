export interface MapController {
  zoomIn: () => void;
  zoomOut: () => void;
  fitBounds: (bounds: [[number, number], [number, number]], options?: { padding?: number | [number, number]; animate?: boolean }) => void;
  flyTo: (center: [number, number], zoom: number, options?: { duration?: number }) => void;
  setView: (center: [number, number], zoom: number, options?: { animate?: boolean }) => void;
}

export interface CorridorSelection {
  id: string;
  coordinates: [number, number][];
  voltage: number | null;
}

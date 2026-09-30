/** The readings of the map. The URL carries it as `?view=`, since MapLibre owns the hash. */
export type ViewKey = 'floods' | 'weather' | 'outlook' | '3d'

export const VIEW_LABELS: Record<ViewKey, string> = {
  floods: 'Floods',
  weather: 'Weather',
  outlook: 'Outlook',
  '3d': '3D',
}

export function viewFromUrl(): ViewKey {
  const v = new URLSearchParams(window.location.search).get('view')
  return v === 'weather' || v === 'outlook' || v === '3d' ? v : 'floods'
}

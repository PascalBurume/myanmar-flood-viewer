export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'myanmar-flood-viewer-theme'

function systemPref(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'light' || saved === 'dark' ? saved : systemPref()
}

/** Update <html data-theme="…"> and persist the current theme. */
export function applyThemeAttr(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(STORAGE_KEY, theme)
}

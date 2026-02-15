// Theme management
const THEME_KEY = 'epub-reader-theme'

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'light'
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme)
  document.documentElement.setAttribute('data-theme', theme)
}

const THEME_CYCLE = ['light', 'dark', 'eink']

export function toggleTheme() {
  const current = getTheme()
  const idx = THEME_CYCLE.indexOf(current)
  const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]
  setTheme(next)
  return next
}

export function initTheme() {
  const theme = getTheme()
  document.documentElement.setAttribute('data-theme', theme)
}

// Auto-init on load
initTheme()

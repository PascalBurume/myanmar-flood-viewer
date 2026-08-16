import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'

import { App } from './App'
import { loadIndex } from './layers'
import './style.css'

// The index decides what the map draws, and the opening camera is derived from it, so it is loaded
// before the first render rather than as an effect — otherwise the map would mount with no bounds
// and then jump.
const index = await loadIndex(import.meta.env.BASE_URL)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialIndex={index} />
  </StrictMode>,
)

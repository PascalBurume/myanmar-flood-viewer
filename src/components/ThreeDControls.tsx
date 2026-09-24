import type { Look3d } from './Flood3D'
import { formatDay, type SceneIndex } from '../scenes'

/**
 * The 3D pane: which scene, and how it is drawn.
 *
 * Scenes are listed by how many buildings the water reached, the order the pipeline wrote them
 * in, so the first card is the place a flood most touched people's houses. Every card carries its
 * dates and sources, and the note at the top says plainly which part of what the view shows was
 * observed and which part is simulated — the view is the most persuasive thing in this viewer, and
 * the least measured, so it says the most about itself.
 */
export function ThreeDControls({
  scenes,
  sceneId,
  onScene,
  look,
  onLook,
}: {
  scenes: SceneIndex | null
  sceneId: string | null
  onScene: (id: string | null) => void
  look: Look3d
  onLook: (patch: Partial<Look3d>) => void
}) {
  return (
    <div className="td">
      <p className="notice td-notice">
        <strong>Where the water was is observed; how it got there is simulated.</strong> On each
        dated step the water is exactly the extent UNOSAT traced from that satellite pass. Between
        steps, newly flooded ground fills deepest-first by an estimate from SRTM terrain and receding
        ground drains shallowest-first — an illustration of the order, not a hydraulic model, and no
        depth is claimed.
      </p>

      <div className="controls-card td-scenes">
        <p className="controls-head">Scenes</p>
        <button
          type="button"
          className={`td-scene${sceneId === null ? ' is-on' : ''}`}
          onClick={() => onScene(null)}
          aria-pressed={sceneId === null}
        >
          <span className="td-scene-name">Whole country</span>
          <span className="td-scene-sub">Terrain, people exposed per township, every traced extent</span>
        </button>
        {scenes?.scenes.length ? (
          scenes.scenes.map((s) => {
            const worst = s.observations.reduce((a, b) => (b.buildingsInWater > a.buildingsInWater ? b : a))
            return (
              <button
                key={s.id}
                type="button"
                className={`td-scene${sceneId === s.id ? ' is-on' : ''}`}
                onClick={() => onScene(s.id)}
                aria-pressed={sceneId === s.id}
              >
                <span className="td-scene-name">{s.name}</span>
                <span className="td-scene-sub">
                  {s.region} · {s.event}
                </span>
                <span className="td-scene-figs">
                  {s.observations.map((o) => (
                    <span key={o.t}>
                      {formatDay(o.date)}: <strong>{o.waterKm2}</strong> km² water,{' '}
                      <strong>{o.buildingsInWater.toLocaleString()}</strong> buildings in it
                    </span>
                  ))}
                </span>
                {worst.buildingsInWater === 0 ? <span className="td-scene-sub">No mapped building reached.</span> : null}
              </button>
            )
          })
        ) : (
          <p className="field-note">No scenes built yet — run scripts/build_scenes.py.</p>
        )}
      </div>

      <div className="controls-card">
        <p className="controls-head">Display</p>
        <div className="wx-display">
          <div className="seg wx-style" role="radiogroup" aria-label="Base">
            {(
              [
                ['satellite', 'Satellite'],
                ['map', 'Map'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={look.base === key}
                className={`seg-btn${look.base === key ? ' is-on' : ''}`}
                onClick={() => onLook({ base: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="wx-density td-slider">
          <span>Terrain</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.1}
            value={look.exaggeration}
            aria-label="Terrain exaggeration"
            onChange={(e) => onLook({ exaggeration: Number(e.target.value) })}
          />
          <em>{look.exaggeration.toFixed(1)}×</em>
        </label>
        <label className="wx-density td-slider">
          <span>Water</span>
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={look.water}
            aria-label="Water density"
            onChange={(e) => onLook({ water: Number(e.target.value) })}
          />
          <em>{Math.round(look.water * 100)}%</em>
        </label>
        {(
          [
            ['buildings', 'Buildings', 'Microsoft footprints, drawn at a nominal height.'],
            ['highlight', 'Mark buildings in the water', 'In the water means exposed, not necessarily damaged.'],
            ['orbit', 'Orbit the camera', 'A slow turn; stops the moment you touch the map.'],
          ] as const
        ).map(([key, label, desc]) => (
          <div className="cy-row" key={key}>
            <label className="toggle">
              <input type="checkbox" checked={look[key]} onChange={(e) => onLook({ [key]: e.target.checked })} />
              <span className="switch" />
              <span className="t-label">{label}</span>
            </label>
            <p className="layer-desc">{desc}</p>
          </div>
        ))}
      </div>

      <p className="field-note">
        {scenes
          ? `${scenes.sources.extents} · ${scenes.sources.terrain} · ${scenes.sources.buildings}. Radar misses water between buildings, so buildings in the water are a floor, not a count of every flooded house. Scenes built ${formatDay(scenes.generatedAt.slice(0, 10))}.`
          : 'Terrain: Mapzen / AWS (SRTM).'}
      </p>
    </div>
  )
}

# Running this unattended

Three files, all samples — copy, edit the paths, install. Nothing here is required to use the
viewer; it is required to have the viewer keep itself current without anyone watching.

`myanmar-flood.service` runs the web server. `myanmar-flood-update.service` /
`.timer` run the pipeline twice a day. Together they are the whole of the automation: no CI account,
no external scheduler, no secrets.

## Install

```bash
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now myanmar-flood.service myanmar-flood-update.timer
```

Edit `User=`, `WorkingDirectory=` and `Environment=PUBLISH_DIR=` first — they are written for a
`flood` user with the repository at `/srv/myanmar-flood`.

## Watching it

```bash
curl -s localhost:5180/api/health | python3 -m json.tool
```

**`/api/health` answers from disk on every request, never from a cached verdict.** A process that
decided it was healthy at startup would go on saying so long after the pipeline behind it died —
which is the exact failure the endpoint exists to catch. It returns **200** when the pipeline has
run recently and concluded cleanly, and **503** with a `faults` array when it has not:

```jsonc
{
  "ok": false,
  "pipeline": { "lastRunAt": "...", "ageHours": 61.2, "maxAgeHours": 48, "conclusion": "ok" },
  "faults": ["last run was 61.2h ago, over the 48h threshold"]
}
```

A 503 here is the one signal worth alerting on externally, because it is the only one that stays
true when everything else has stopped: the page can be perfectly healthy and completely out of date,
and only the age of the run tells you so. Any uptime monitor that understands HTTP status will do.

## Cron instead

If you would rather not use systemd, the timer is only a schedule:

```cron
17 1,13 * * *  cd /srv/myanmar-flood && /usr/bin/python3 scripts/run_pipeline.py --publish /var/www/flood >> /var/log/flood.log 2>&1
```

The pipeline serialises itself, so an overlapping run is harmless.

## Why the timer, not the server, runs the pipeline

`POST /api/run` exists for the button in the page, and the server refuses concurrent runs and
rate-limits to one per 30s. But it is the *timer* that keeps the data current, and it works with the
web server stopped. Update and serve are separate jobs; coupling them would mean a crashed web
server silently stops the data updating too.

# Samsung Mirror (Netlify)

Mirror and control a Samsung phone from an iPad browser. Netlify can't host
WebSockets, so the relay is one Netlify Function (`netlify/functions/api.mjs`)
that shares state through Netlify Blobs. The home agent uploads JPEG frames over
HTTPS and the iPad long-polls for the newest one.

## Deploy
1. Import this repo in Netlify (no build command; publish dir `public`).
2. Site settings > Environment variables: set `APP_PASSWORD` and `AGENT_TOKEN` (any long random string).
3. Deploy. Open the site URL on the iPad and log in.

## Run the agent (computer with the phone attached via ADB)
Needs Node 18+, `adb` and `ffmpeg`:

    SERVER_URL=https://YOUR-SITE.netlify.app AGENT_TOKEN=... node agent.js

Optional tuning: `STREAM_WIDTH` (default 540), `JPEG_Q` (default 8, lower = sharper/bigger),
`INFLIGHT` (parallel uploads, default 2), `ADB_SERIAL`.

## Notes
- Frames are only sent while someone has the page open.
- Every poll and upload is a function invocation, so long sessions use Netlify credits.

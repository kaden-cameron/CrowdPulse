# Track audio

Drop audio files for catalog tracks here and list them in `manifest.json`, keyed by track ID:

```json
{
  "track_01": "gator-glow.mp3",
  "track_07": "stage-lightning.mp3"
}
```

Tracks without a file play a **generated demo version**, built live in the browser from the track's BPM, energy and genre, so the demo works with an empty manifest.

**Only add music you're allowed to play in public.** That means your own tracks, royalty-free music, or Creative Commons tracks that allow this use, with any required attribution credited on the stage or in the README. Don't add commercial songs. Files here are served publicly by the app.

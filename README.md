# B+W Field Guide

Private field app for Brown + Wheaten's ground game: today's plan, where-am-I, quick capture (notes, photos, voice notes, conversations, drop-offs) and follow-ups.

- Static site (GitHub Pages). Works offline once loaded; captures wait on the device until they can be sent.
- Reference data (`data.enc`) is encrypted with AES-GCM; it unlocks only with the owner's passphrase.
- Captures and day plans go to B+W's own backend (Google Apps Script → BigQuery and Drive). No data is stored in this repository.

## Places tab (phase 1, branch `places-v1`)

A place card for any district, corridor, ZIP, tract or neighborhood, or the tracts around where you stand: who lives here, who works here,
what's opening and closing, property and money, food access and a small health section. Every survey figure shows its margin and a verdict
(solid, rough, inside the margin) using the packet builder's rules.

- `places-core.js`: the margin rules (a copy of the packet builder's survey rules). `test/places_gate.mjs` rebuilds the built packets' survey
  figures from the snapshot files and fails on any unexplained mismatch.
- `places.js`, `places.css`: the tab, loaded only when it opens.
- Data: snapshot files are built outside this repository and kept in the owner's Google Drive; the backend action `placesFile` serves them to a
  signed-in device, which keeps them encrypted for offline use. No figures are stored in this repository.

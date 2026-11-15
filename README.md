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

## Places phase 2a (branch `places-v2`, app 1.7.0)

- `places-records.js`: Philadelphia address records (licenses, permits, parcels, deeds, SBA loans, storefront grants) counted for any
  corridor (its address rule, as the packets count), district (inside the City boundary), tract or neighborhood, or the true circle around
  Here. Counts by year, no yearly average unless the run is steady, no direction words, and the packets' gates shown as tags.
- `test/places_gate.mjs` now also rebuilds the packets' records figures and the district tables' counts from the point snapshots.
- Districts with a published corridor carry a corridor line and its tract list; area districts stay on the boundary rule, marked desk only.
- The point snapshots, like the rest, are built outside this repository and kept in the owner's Google Drive.

## Places phase 2b (branch `places-v3`, app 1.8.0; stacked on phase 2a)

- `places-work.js`: jobs and commuting from LEHD LODES (jobs here by sector, earnings and age; where workers live and where residents work, by
  distance band and county; a daytime estimate labeled as a B+W estimate with its method), transit boardings by stop (SEPTA stops counted by
  distinct stop code at 60 m of a corridor line with the 40 m and 80 m second paths, inside a district, in tracts or in a true circle; stations
  listed beside the stops and never added to them; MBTA and PATH the same way), SNAP store openings and closings by year (years listed, no
  direction words), the below-poverty-not-receiving-SNAP survey share, and Pennsylvania WIC stores and community-eligibility schools.
- `test/places_gate.mjs` also checks the new files against the phase 1 tract file and the packets' jobs and transit figures and the district
  tables; phase 1 and 2a checks are unchanged.
- The new snapshot files, like the rest, are built outside this repository and kept in the owner's Google Drive.

## Places phase 2, final pass (branch `places-v4`, app 1.9.0; stacked on phases 2a and 2b)

- Review fixes for phase 2a: snapshot files are versioned (the meta lists each file's sha256 and a revision; a saved copy that differs from the
  one in Drive is fetched again, and an older app's meta or area file is never trusted while there is signal); permit sentences obey CL-19;
  address rules use the packet builder's own matcher (CL-36, CL-38); deeds count once per deed with medians on single-property deeds; meeting
  mode never shows a run that ends below its start and labels the part year; SBA counts made by map position are floors ("at least N").
- County card (QCEW employment and pay by sector, LAUS unemployment, CRA small-business lending, business ownership, Map the Meal Gap, the Food
  Environment Atlas, farms), ZIP extras (CDC PLACES by ZIP, the decade change where the ZIP area did not change, ZIP outlines, jobs by ZIP in
  Pennsylvania), address search (Philadelphia from the saved parcels; elsewhere the backend action `placesGeocode`), a side-by-side view of two
  pinned places (internal), and meeting mode with two settings (district meeting, food-access meeting).
- `backend/Code.gs`: the read-only `placesGeocode` action (the City property file in the warehouse for Philadelphia; the Census Bureau's public
  geocoder, no key, elsewhere).
- `test/places_gate.mjs`: a "final pass" block checks the fixes against references kept outside the repo.
- Combined review fixes (app 1.9.1): the app checks the snapshot file list against the files it downloads and shows a banner and withholds
  records when Drive serves an older list; a saved copy is kept when a fetch fails; meeting mode shows no falling run, median deed price or
  signed change and keeps one-line warnings; county sectors missing from the latest BLS file show the year before, labeled, never "withheld".
- Owner names: only non-individual owners (firms, institutions, government) are named; individuals read "Private owner (individual)", with
  the parcel count kept. Names are stripped when the snapshot is built, so they never reach a device. Each listed owner and each Philadelphia
  address links to the City's property site by OPA account number (no name in the link).

# B+W Field Guide

Private field app for Brown + Wheaten's ground game: today's plan, where-am-I, quick capture (notes, photos, voice notes, conversations, drop-offs) and follow-ups.

- Static site (GitHub Pages). Works offline once loaded; captures wait on the device until they can be sent.
- Reference data (`data.enc`) is encrypted with AES-GCM; it unlocks only with the owner's passphrase.
- Captures and day plans go to B+W's own backend (Google Apps Script → BigQuery and Drive). No data is stored in this repository.

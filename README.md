# Nuvio-Plugin

Nuvio providers for a personal Dropbox media library.

**Install** (Settings -> Content & Discovery -> Plugins):

```
https://raw.githubusercontent.com/SUFahad007/Nuvio-Plugin/main/manifest.json
```

Two providers, each toggleable in the app:

| Provider | Streams from | URL lifetime |
|---|---|---|
| **DB-Server** | dl.dropboxusercontent.com (direct Dropbox) | ~4 h (temporary links) |
| **CF-Server** | Cloudflare edge proxy | permanent |

Published automatically from the private Dropbox-Media source — one source of truth, never edited by hand.

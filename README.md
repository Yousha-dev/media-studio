# Media Studio

A standalone CLIProxyAPI ABI v1 / schema 6 plugin with an image, voice, and video playground. Adds **Media Studio** to the management sidebar without modifying the official executable or management HTML.

Open <http://127.0.0.1:8317/v0/resource/plugins/media-studio/studio> and connect with an existing **proxy client API key**, available under API Keys in management (not the management password). Credentials stay in page memory and are cleared on disconnect/reload. No key discovery, upstream credential access, persistent browser storage, or third-party scripts.

## Features

- Searchable categories, live `/v1/models` discovery, and a bundled catalog of known media capabilities, including hidden `gpt-live-1-codex`. Reference entries are hidden by default. After connection, the main view includes listed models and the Codex WebRTC and GPT-Realtime WebSocket entries when a non-generating route probe detects the dedicated voice endpoint. Its badge explicitly says account access is unverified. Compatibility aliases and unrelated reference models stay out of this view.
- Image generation, reference-image editing, inline preview, and download through the OpenAI image endpoints. Gemini image models use native `generateContent`.
- Realtime WebSocket voice with microphone streaming, automatic greeting, streamed speaker playback, transcripts, a playable/downloadable WAV of the last reply, mute, interruption handling, and stop. The native Realtime model requested is reported by the server.
- Codex OAuth WebRTC voice with ICE candidate gathering, microphone permission, playback, event/transcript display, mute, stop, and a finite connection watchdog. If no voice events arrive, the page releases the microphone and recommends the WebSocket alternative.
- xAI speech generation with playback/download.
- Grok video generation, automatic status polling, stop polling, preview, and download.
- Request/response details for troubleshooting, with large known base64 payloads abbreviated. Diagnostics may include prompts, transcripts and provider-returned text; review them before sharing. No automatic generation or microphone activation.

## Availability and limits

The catalog is **not an entitlement list**. Listed models still need a successful generation to establish account access. Hidden voice has a dedicated route but may be unavailable to a particular account. Unlisted catalog entries require appropriate provider configuration. Tests consume the accounts' normal quota/billing.

The **Hide reference catalog** checkbox is enabled by default. Unlike a strict `/v1/models` filter, it keeps the canonical Codex WebRTC and GPT-Realtime WebSocket entries visible when the voice route is detected, without relabeling them as listed models. Uncheck it to browse the full reference catalog. The route check is an authenticated plain GET to `/v1/realtime`; only the expected HTTP 426 error code identifies the route. It creates no session and does not use the microphone or consume voice quota.

The proxy's WebRTC compatibility route maps Realtime names to `gpt-live-1-codex`. Studio instead uses the native `/v1/realtime?model=...` **WebSocket** route for Realtime models, which forwards the requested model unchanged. Each Realtime variant and account needs its own access and audio test. The actual public `gpt-live-1` API is not implemented by this proxy. Sora-style compatibility routes map to Grok video, so Sora is marked as needing an adapter. Imagen, unsupported video variants, transcription-only models, and other unsupported transports are visible when discovered but cannot run with an incorrect adapter. Image/video/audio *input* alone does not classify a text model as a media generator.

The bundled catalog was extracted from CLIProxyAPI model definitions, plus the built-in image/speech/voice handlers. It is refreshed at page load against live discovery; it is not an exhaustive catalog of every external AI service. Adding a provider or model does not bypass endpoint/entitlement limitations. For arbitrary aliases whose metadata does not expose output modalities, use recognizable IDs or extend `models.mjs`.

GPT-Live and GPT-Realtime use different routes and have different account requirements. A successful WebRTC bootstrap does not establish that audio will flow. GPT-Live WebRTC media is not verified across accounts or networks; use the watchdog and stop control, and test your own backend explicitly. A detected voice route or successful GPT-Realtime session does not establish GPT-Live access.

Voice requires localhost or HTTPS and microphone permission in a browser. If embedded iframe permissions block the microphone, open the direct Studio link in a browser tab. WebRTC depends on network/UDP reachability and existing relay configuration. Session configuration is sent through the proxy's Codex compatibility endpoint. Advanced backend tool delegation is not provided. Stop releases local media immediately and attempts upstream hangup. Closing/reloading also releases local microphone tracks. Stopping a video poll or aborting a generation request may leave provider work running.

The WebSocket transport avoids UDP and does not require a WebRTC relay. Browser WebSockets cannot supply an Authorization header, so Studio uses the host's existing `auth_token` query parameter for this same-origin socket only. The URL is never navigated, persisted, or displayed in Studio diagnostics; the verified host masks that query value in its own logs; other gateways, reverse proxies and browser network tools may still record it. Use HTTPS outside localhost. Redact query strings, credentials, prompts and transcripts before sharing diagnostic or network logs. Speech is PCM16 mono at 24 kHz. Microphone frames are discarded while muted or while the socket is backpressured; local playback is interrupted when server VAD detects the user speaking.

## Install

Install **Media Studio** from the CLIProxyAPI Plugin Store when its registry entry is available. For a manual install:

1. Download the archive for your OS and architecture from [Releases](https://github.com/Yousha-dev/media-studio/releases/latest).
2. Verify the archive against the release's `checksums.txt`.
3. Extract `media-studio.dll` (Windows), `media-studio.so` (Linux), or `media-studio.dylib` (macOS) into your proxy's plugin directory.
4. Enable it in the native configuration and restart the proxy if required to load the library:

```yaml
plugins:
  enabled: true
  configs:
    media-studio:
      enabled: true
```

The management sidebar opens **Media Studio**, or visit `/v0/resource/plugins/media-studio/studio` on your proxy. It uses the host's existing inference endpoints, accounts, routing and billing. It does not add provider credentials or media backend support.

## Build and test

Requires Go 1.26.10 or later, a compatible C compiler, Node.js for interface tests, and Python 3.9 or later for packaging tests. Clone this repository and run:

```sh
go vet ./...
go test -race ./...
node --test models.test.mjs
node --check app.mjs
node --check realtime.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
CGO_ENABLED=1 go build -buildmode=c-shared -trimpath -o media-studio.so .
```

Use `.dll` on Windows or `.dylib` on macOS; set a matching C compiler/target when cross-compiling. `browser-checks.js` is an optional fixture expression for an isolated Studio tab with simulated providers and a synthetic microphone. It is not a standalone Node test, and must not be injected into a real workload tab.

Release CI builds all six required targets: Windows x64/ARM64, Linux x64/ARM64 and macOS x64/ARM64. Before publishing, it verifies the complete archive matrix, checksums, zip layouts and binary architectures. ABI v1 / schema 6 resource loading has been verified against official CLIProxyAPI 8.0.51 on Windows x64; ARM64 packages have build and format validation, not runtime verification. Endpoint availability and model access may differ on other host versions.

All resources are public static files; inference remains protected by the host's client authentication and existing scheduler. No management mutation routes are registered. Plugin assets have a restrictive content-security policy; resource paths are allowlisted. External result URLs must be HTTPS (or same-origin HTTP); credentials and executable URLs are rejected.

## Discovery

Reviewed the official [CLIProxyAPI Plugins Store](https://github.com/router-for-me/CLIProxyAPI-Plugins-Store) and [CPA Model Playground](https://github.com/hex-ci/cpa-plugin-model-playground). The latter is a general text-chat interface using `/v1/models`; it does not cover hidden voice routes or a combined media playground. Provider plugins such as GFlow add upstream access, rather than this testing interface. No third-party playground code was installed or bundled.

The C ABI adapter follows [Claude Remote Login](https://github.com/Yousha-dev/claude-remote-login). The media interface is implemented here. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and [UPSTREAM-LICENSE](UPSTREAM-LICENSE) for applicable notices.

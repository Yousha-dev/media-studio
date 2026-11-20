# Changelog

## 1.1.0

- Merge provider-advertised media adapters with the public plugin release.
- Add audio-file transcription and editable JSON requests for embeddings,
  reranking, moderation, decisions and extractions.
- Add OpenRouter image and chat-media responses, provider voice choices,
  and HeyGen PCM-to-WAV playback.
- Keep the official repository metadata, shared-library ABI, voice transports,
  six-platform builds and release packaging checks.

## 1.0.1

- Add the Windows ARM64 shared-library package required by the Plugin Store.
- Require all six platform archives, matching checksums, root-level libraries
  and correct binary architectures before publishing a release.
- Add packaging regression tests, including the missing Windows ARM64 case.

## 1.0.0

- First public Media Studio release for CLIProxyAPI ABI v1 / schema 6.
- Image generation/editing, supported speech and video requests, and optional
  realtime WebSocket/WebRTC voice through existing host endpoints.
- Runtime model discovery, reference-catalog filtering, input/output capability
  classification, request cancellation and local media cleanup.
- Client credentials remain in page memory. Unsupported adapters stay disabled;
  detected routes are not represented as verified account access.

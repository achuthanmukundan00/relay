# Changelog

## Unreleased

### Added

- Cline context/token usage support: Relay now preserves and surfaces OpenAI/Anthropic usage metadata in streaming and non-streaming responses for compatible clients.

### Notes

- Exact token usage depends on upstream llama.cpp/OpenAI-compatible servers exposing usage counts.

## v0.1.1 - 2026-05-02

### Added

- Canonical smoke command: `./scripts/smoke-local-openai.sh`
- Public compatibility matrix in README
- Benchmarks surfaced in README
- Explicit "what Relay is / is not" positioning

### Changed

- Release positioning tightened around local-first compatibility (not agent/runtime orchestration)
- Recommended setup path clarified: primary systemd/local, Docker as secondary

### Notes

- This release is intentionally focused on predictability and compatibility clarity, not feature expansion.

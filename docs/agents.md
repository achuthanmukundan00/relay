# Agents And Client Compatibility

Relay is designed for local-agent workflows where tools expect hosted API shapes.

## Typical Agent Flow

1. Agent client sends OpenAI- or Anthropic-style request.
2. Relay normalizes request fields to a canonical internal model.
3. Relay forwards to upstream OpenAI-like chat endpoint.
4. Relay maps upstream responses back to client protocol shape.

## Practical Compatibility Scope

Relay works best with clients that allow custom base URLs and model IDs.

- OpenAI-compatible clients: chat/responses/completions style workflows
- Anthropic-compatible clients: messages workflows
- Local agent tools (for example Cline) using OpenAI-compatible mode

## Known Limits

Relay intentionally does not implement full hosted platform orchestration APIs.

See [API Compatibility](./api-compatibility.md) for explicit support boundaries.

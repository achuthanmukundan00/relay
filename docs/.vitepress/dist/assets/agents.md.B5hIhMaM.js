import { _ as _export_sfc, o as openBlock, c as createElementBlock, ae as createStaticVNode } from "./chunks/framework.CaVXODBr.js";
const __pageData = JSON.parse('{"title":"Agents And Client Compatibility","description":"","frontmatter":{},"headers":[],"relativePath":"agents.md","filePath":"agents.md"}');
const _sfc_main = { name: "agents.md" };
function _sfc_render(_ctx, _cache, $props, $setup, $data, $options) {
  return openBlock(), createElementBlock("div", null, [..._cache[0] || (_cache[0] = [
    createStaticVNode('<h1 id="agents-and-client-compatibility" tabindex="-1">Agents And Client Compatibility <a class="header-anchor" href="#agents-and-client-compatibility" aria-label="Permalink to &quot;Agents And Client Compatibility&quot;">​</a></h1><p>Relay is designed for local-agent workflows where tools expect hosted API shapes.</p><h2 id="typical-agent-flow" tabindex="-1">Typical Agent Flow <a class="header-anchor" href="#typical-agent-flow" aria-label="Permalink to &quot;Typical Agent Flow&quot;">​</a></h2><ol><li>Agent client sends OpenAI- or Anthropic-style request.</li><li>Relay normalizes request fields to a canonical internal model.</li><li>Relay forwards to upstream OpenAI-like chat endpoint.</li><li>Relay maps upstream responses back to client protocol shape.</li></ol><h2 id="practical-compatibility-scope" tabindex="-1">Practical Compatibility Scope <a class="header-anchor" href="#practical-compatibility-scope" aria-label="Permalink to &quot;Practical Compatibility Scope&quot;">​</a></h2><p>Relay works best with clients that allow custom base URLs and model IDs.</p><ul><li>OpenAI-compatible clients: chat/responses/completions style workflows</li><li>Anthropic-compatible clients: messages workflows</li><li>Local agent tools (for example Cline) using OpenAI-compatible mode</li></ul><h2 id="known-limits" tabindex="-1">Known Limits <a class="header-anchor" href="#known-limits" aria-label="Permalink to &quot;Known Limits&quot;">​</a></h2><p>Relay intentionally does not implement full hosted platform orchestration APIs.</p><p>See <a href="./api-compatibility.html">API Compatibility</a> for explicit support boundaries.</p>', 10)
  ])]);
}
const agents = /* @__PURE__ */ _export_sfc(_sfc_main, [["render", _sfc_render]]);
export {
  __pageData,
  agents as default
};

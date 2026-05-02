import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Agents And Client Compatibility","description":"","frontmatter":{},"headers":[],"relativePath":"agents.md","filePath":"agents.md"}');
const _sfc_main = { name: "agents.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="agents-and-client-compatibility" tabindex="-1">Agents And Client Compatibility <a class="header-anchor" href="#agents-and-client-compatibility" aria-label="Permalink to &quot;Agents And Client Compatibility&quot;">​</a></h1><p>Relay is designed for local-agent workflows where tools expect hosted API shapes.</p><h2 id="typical-agent-flow" tabindex="-1">Typical Agent Flow <a class="header-anchor" href="#typical-agent-flow" aria-label="Permalink to &quot;Typical Agent Flow&quot;">​</a></h2><ol><li>Agent client sends OpenAI- or Anthropic-style request.</li><li>Relay normalizes request fields to a canonical internal model.</li><li>Relay forwards to upstream OpenAI-like chat endpoint.</li><li>Relay maps upstream responses back to client protocol shape.</li></ol><h2 id="practical-compatibility-scope" tabindex="-1">Practical Compatibility Scope <a class="header-anchor" href="#practical-compatibility-scope" aria-label="Permalink to &quot;Practical Compatibility Scope&quot;">​</a></h2><p>Relay works best with clients that allow custom base URLs and model IDs.</p><ul><li>OpenAI-compatible clients: chat/responses/completions style workflows</li><li>Anthropic-compatible clients: messages workflows</li><li>Local agent tools (for example Cline) using OpenAI-compatible mode</li></ul><h2 id="known-limits" tabindex="-1">Known Limits <a class="header-anchor" href="#known-limits" aria-label="Permalink to &quot;Known Limits&quot;">​</a></h2><p>Relay intentionally does not implement full hosted platform orchestration APIs.</p><p>See <a href="./api-compatibility.html">API Compatibility</a> for explicit support boundaries.</p></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("agents.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const agents = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  agents as default
};

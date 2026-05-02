import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Relay Documentation","description":"","frontmatter":{},"headers":[],"relativePath":"index.md","filePath":"index.md"}');
const _sfc_main = { name: "index.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="relay-documentation" tabindex="-1">Relay Documentation <a class="header-anchor" href="#relay-documentation" aria-label="Permalink to &quot;Relay Documentation&quot;">​</a></h1><p>Relay is a local-model gateway that presents practical OpenAI- and Anthropic-compatible APIs for agent tools and clients.</p><p>Use these docs to get running quickly, configure safely, and operate Relay in local or service environments.</p><h2 id="start-here" tabindex="-1">Start Here <a class="header-anchor" href="#start-here" aria-label="Permalink to &quot;Start Here&quot;">​</a></h2><ul><li><a href="./quickstart.html">Quickstart</a></li><li><a href="./configuration.html">Configuration</a></li><li><a href="./api-compatibility.html">API Compatibility</a></li><li><a href="./troubleshooting.html">Troubleshooting</a></li></ul><h2 id="operations" tabindex="-1">Operations <a class="header-anchor" href="#operations" aria-label="Permalink to &quot;Operations&quot;">​</a></h2><ul><li><a href="./systemd.html">Systemd Deployment</a></li><li><a href="./architecture.html">Architecture</a></li><li><a href="./agents.html">Agents</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("index.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const index = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  index as default
};

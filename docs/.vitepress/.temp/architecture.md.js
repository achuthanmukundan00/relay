import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
import { _ as _export_sfc } from "./plugin-vue_export-helper.1tPrXgE0.js";
const __pageData = JSON.parse('{"title":"Architecture","description":"","frontmatter":{},"headers":[],"relativePath":"architecture.md","filePath":"architecture.md"}');
const _sfc_main = { name: "architecture.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${ssrRenderAttrs(_attrs)}><h1 id="architecture" tabindex="-1">Architecture <a class="header-anchor" href="#architecture" aria-label="Permalink to &quot;Architecture&quot;">​</a></h1><p>Relay translates a focused subset of OpenAI/Anthropic requests into a canonical internal model and forwards to an upstream OpenAI-compatible endpoint.</p><h2 id="request-and-response-flow" tabindex="-1">Request And Response Flow <a class="header-anchor" href="#request-and-response-flow" aria-label="Permalink to &quot;Request And Response Flow&quot;">​</a></h2><div class="language-text vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">text</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>client protocol</span></span>
<span class="line"><span>  -&gt; endpoint parser/auth/field policy</span></span>
<span class="line"><span>  -&gt; canonical request</span></span>
<span class="line"><span>  -&gt; upstream OpenAI-like chat request</span></span>
<span class="line"><span>  -&gt; canonical response/stream event</span></span>
<span class="line"><span>  -&gt; client protocol response</span></span></code></pre></div><h2 id="canonical-layers" tabindex="-1">Canonical Layers <a class="header-anchor" href="#canonical-layers" aria-label="Permalink to &quot;Canonical Layers&quot;">​</a></h2><ul><li>Request model: <code>src/internal/canonical.ts</code></li><li>Protocol converters: <code>src/internal/openai-chat.ts</code>, <code>src/internal/openai-responses.ts</code>, <code>src/internal/anthropic-messages.ts</code></li><li>Response model: <code>src/internal/response.ts</code></li><li>Shared sampling logic: <code>src/internal/sampling.ts</code></li></ul><h2 id="streaming-guarantees" tabindex="-1">Streaming Guarantees <a class="header-anchor" href="#streaming-guarantees" aria-label="Permalink to &quot;Streaming Guarantees&quot;">​</a></h2><ul><li>OpenAI chat streams emit one terminal <code>[DONE]</code>.</li><li>Missing <code>[DONE]</code> is repaired; duplicates are collapsed.</li><li>Responses and Anthropic streams are emitted in protocol-appropriate event order.</li></ul><h2 id="observability" tabindex="-1">Observability <a class="header-anchor" href="#observability" aria-label="Permalink to &quot;Observability&quot;">​</a></h2><p>When enabled, Relay exposes:</p><ul><li><code>/relay/capabilities</code></li><li><code>/relay/stats</code></li><li><code>/relay/requests</code></li><li><code>/relay/requests/:id</code></li></ul><p>Sensitive values are redacted by default.</p></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("architecture.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const architecture = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  architecture as default
};

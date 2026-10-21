import { randomBytes } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { pluginJsonValueSchema, pluginFrameBindingSchema, pluginViewerTicketSchema, PLUGIN_LIMITS, ValidationError, type PluginManifest } from "@task-weaver/contracts";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
export type PluginUiNode = { text: string } | { tag: string; title?: string; method?: string; input?: unknown; result?: true; children: PluginUiNode[] };
const compiledFrontend = Symbol("compiledPluginFrontend");
export type PluginFrontend = { nodes: PluginUiNode[]; format: "restricted_html_v1"; readonly [compiledFrontend]: true };
const tags = new Set(["div", "section", "article", "p", "h1", "h2", "h3", "strong", "em", "small", "ul", "ol", "li", "button", "output", "code", "pre", "table", "thead", "tbody", "tr", "th", "td", "hr", "br"]);

/** Parse on the server, then build fresh DOM nodes. Uploaded markup never enters a browser parser. */
export function compilePluginFrontend(html: string, manifest: PluginManifest): PluginFrontend {
  if (Buffer.byteLength(html) > PLUGIN_LIMITS.frontendBytes) throw new ValidationError("Plugin frontend exceeds its artifact byte limit");
  const document = parse(html);
  const root = document.childNodes.find(node => "tagName" in node && node.tagName === "html") as Element | undefined;
  if (!root) throw new ValidationError("Plugin frontend must contain an HTML document");
  const head = root.childNodes.find(node => "tagName" in node && node.tagName === "head") as Element | undefined;
  const body = root.childNodes.find(node => "tagName" in node && node.tagName === "body") as Element | undefined;
  if (!body) throw new ValidationError("Plugin frontend body is missing");
  if (root.attrs.length || body.attrs.length || head?.attrs.length) throw new ValidationError("Plugin document wrappers cannot declare attributes");
  for (const node of head?.childNodes ?? []) {
    if (node.nodeName === "#comment" || "value" in node && !node.value.trim()) continue;
    if ("tagName" in node && node.tagName === "title" && !node.attrs.length && node.childNodes.every(child => child.nodeName === "#text")) continue;
    if ("tagName" in node && node.tagName === "meta" && node.attrs.length === 1 && node.attrs[0]?.name === "charset" && node.attrs[0].value.toLowerCase() === "utf-8") continue;
    throw new ValidationError("Plugin frontend head supports only a text title and UTF-8 charset");
  }
  let count = 0;
  const visit = (node: Node, depth: number): PluginUiNode[] => {
    if (++count > 512 || depth > 16) throw new ValidationError("Plugin frontend exceeds its node/depth budget");
    if (node.nodeName === "#comment") return [];
    if ("value" in node) return [{ text: node.value }];
    if (!("tagName" in node) || node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !tags.has(node.tagName)) throw new ValidationError("Plugin frontend contains an unsupported element");
    const result: Exclude<PluginUiNode, { text: string }> = { tag: node.tagName, children: [] };
    let hasInput = false;
    for (const attribute of node.attrs) {
      if (attribute.namespace || attribute.prefix) throw new ValidationError("Plugin frontend attributes cannot use namespaces");
      if (attribute.name === "title" && attribute.value.length <= 256) result.title = attribute.value;
      else if (attribute.name === "data-tw-method" && node.tagName === "button") {
        if (!manifest.methods.some(method => method.name === attribute.value)) throw new ValidationError("Plugin frontend button references an undeclared method");
        result.method = attribute.value;
      } else if (attribute.name === "data-tw-input" && node.tagName === "button") {
        let value: unknown;
        try { value = JSON.parse(attribute.value); } catch { throw new ValidationError("Plugin frontend method input must be bounded JSON"); }
        result.input = pluginJsonValueSchema.parse(value); hasInput = true;
      } else if (attribute.name === "data-tw-result" && node.tagName === "output" && !attribute.value) result.result = true;
      else throw new ValidationError("Plugin frontend contains an unsupported attribute");
    }
    if (node.tagName === "button" && !result.method || hasInput && !result.method) throw new ValidationError("Plugin frontend buttons require an explicit declared method");
    if (result.method && !hasInput) result.input = {};
    result.children = node.childNodes.flatMap(child => visit(child, depth + 1));
    return [result];
  };
  const frontend: PluginFrontend = { format: "restricted_html_v1", nodes: body.childNodes.flatMap(node => visit(node, 0)), [compiledFrontend]: true };
  if (Buffer.byteLength(JSON.stringify(frontend)) > 65536) throw new ValidationError("Compiled plugin frontend exceeds its byte budget");
  return frontend;
}

export type PluginFrameBinding = { installationId: string; revision: number; manifestHash: string; bridgeNonce: string; webOrigin: string; allowedMethods: string[] };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const jsonForScript = (value: unknown) => "JSON.parse(" + JSON.stringify(JSON.stringify(value)).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + ")";

/** Only this fixed renderer executes. Plugins supply a closed HTML subset and declarative method bindings. */
export function renderPluginFrontend(frontend: PluginFrontend, binding: PluginFrameBinding) {
  pluginFrameBindingSchema.parse(binding);
  if (frontend[compiledFrontend] !== true) throw new ValidationError("Plugin frontend must be compiled by the trusted host");
  const nonce = randomBytes(24).toString("base64");
  const origin = new URL(binding.webOrigin);
  if (origin.origin !== binding.webOrigin || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new ValidationError("Plugin viewer requires one exact trusted Web origin");
  const script = `"use strict";(()=>{
const config=${jsonForScript(binding)},ui=${jsonForScript(frontend)};
const root=document.getElementById("tw-plugin-root"),status=document.getElementById("tw-plugin-status");
const outputs=[],buttons=[];let pending=null,timer=null,initialized=false;
const denied=read=>{try{read();return false;}catch(error){return error&&error.name==="SecurityError";}};
const isolation={opaqueOrigin:window.origin==="null",coreDomDenied:denied(()=>window.parent.document),cookiesDenied:denied(()=>document.cookie),localStorageDenied:denied(()=>window.localStorage)};
const isolated=window.parent!==window&&Object.values(isolation).every(value=>value===true);
const ready=()=>window.parent.postMessage({protocol:1,kind:"ready",installationId:config.installationId,revision:config.revision,manifestHash:config.manifestHash,nonce:config.bridgeNonce,isolation},config.webOrigin);
const show=value=>{for(const output of outputs)output.textContent=typeof value==="string"?value:JSON.stringify(value);};
const settle=()=>{pending=null;clearTimeout(timer);for(const button of buttons)button.disabled=!initialized||!isolated||!config.allowedMethods.includes(button.dataset.method);};
const render=node=>{if(Object.hasOwn(node,"text"))return document.createTextNode(node.text);const element=document.createElement(node.tag);
if(node.title)element.title=node.title;
for(const child of node.children)element.appendChild(render(child));
if(node.result)outputs.push(element);
if(node.method){element.type="button";element.dataset.method=node.method;element.disabled=true;buttons.push(element);element.addEventListener("click",event=>{
if(!event.isTrusted||pending||!initialized||!isolated||!config.allowedMethods.includes(node.method))return;
pending=crypto.randomUUID();for(const button of buttons)button.disabled=true;status.textContent="Running…";
const message={protocol:1,kind:"invoke",installationId:config.installationId,revision:config.revision,manifestHash:config.manifestHash,nonce:config.bridgeNonce,requestId:pending,method:node.method,input:node.input};
window.parent.postMessage(message,config.webOrigin);
timer=setTimeout(()=>{settle();status.textContent="Request timed out. Check the current installation before retrying.";},30000);
});}return element;};
for(const node of ui.nodes)root.appendChild(render(node));
window.addEventListener("message",event=>{if(event.source!==window.parent||event.origin!==config.webOrigin)return;const message=event.data;
if(!message||typeof message!=="object"||message.protocol!==1||message.nonce!==config.bridgeNonce||message.installationId!==config.installationId||message.revision!==config.revision||message.manifestHash!==config.manifestHash)return;
if(message.kind==="initialize"){initialized=isolated;settle();status.textContent=isolated?(config.allowedMethods.length?"Isolation verified":"No backend methods are enabled for your current role."):"Plugin isolation is unavailable";ready();return;}
if(!pending||message.kind!=="result"||message.requestId!==pending)return;
try{if(new TextEncoder().encode(JSON.stringify(message)).length>32768)return;}catch{return;}
settle();if(message.ok===true){show(message.result);status.textContent="Updated";}else status.textContent="Plugin request failed. Inspect the installation status before retrying.";
});
status.textContent=window.parent===window?"Open this plugin from Task Weaver to use its methods.":"Checking isolation…";
})();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">body{font:16px system-ui,sans-serif;margin:0;padding:24px;color:#172033;background:#fff}button{font:inherit;border:1px solid #ccd3dd;border-radius:8px;padding:10px 16px;background:#f2f5fa;cursor:pointer}button:disabled{opacity:.55;cursor:wait}output{display:block;font-size:24px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#tw-plugin-status{font-size:13px;color:#536174;margin-top:20px}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #dde2ea}</style></head><body><main id="tw-plugin-root"></main><p id="tw-plugin-status" role="status"></p><script nonce="${nonce}">${script}</script></body></html>`;
  const headers = {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-dns-prefetch-control": "off",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'none'; child-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${binding.webOrigin}; sandbox allow-scripts`,
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), display-capture=()",
  };
  return { html, headers };
}

/** Trusted application shell. The opaque frame gets only owned-state results, never session/CSRF credentials. */
export function renderPluginViewer(raw: unknown) {
  const ticket = pluginViewerTicketSchema.parse(raw);
  const artifactOrigin = new URL(ticket.artifactUrl).origin;
  if (new URL(artifactOrigin).hostname === new URL(ticket.webOrigin).hostname) throw new ValidationError("Plugin viewer requires a separate artifact host");
  const nonce = randomBytes(24).toString("base64");
  const script = `"use strict";(()=>{
const config=${jsonForScript(ticket)},frame=document.getElementById("tw-plugin-frame"),status=document.getElementById("tw-viewer-status");
let epoch=0,busy=false,frameReady=false;frame.addEventListener("load",()=>{epoch++;frameReady=false;status.textContent="Plugin frame changed. Waiting for isolation verification.";delete status.dataset.isolation;frame.contentWindow.postMessage({protocol:1,kind:"initialize",installationId:config.installationId,revision:config.revision,manifestHash:config.manifestHash,nonce:config.bridgeNonce},"*");});
window.addEventListener("message",async event=>{
if(event.source!==frame.contentWindow||event.origin!=="null")return;const message=event.data;
if(!message||typeof message!=="object"||message.protocol!==1||message.installationId!==config.installationId||message.revision!==config.revision||message.manifestHash!==config.manifestHash||message.nonce!==config.bridgeNonce)return;
if(message.kind==="ready"){
if(Object.keys(message).sort().join(",")!=="installationId,isolation,kind,manifestHash,nonce,protocol,revision"||!message.isolation||Object.keys(message.isolation).sort().join(",")!=="cookiesDenied,coreDomDenied,localStorageDenied,opaqueOrigin")return;
frameReady=Object.values(message.isolation).every(value=>value===true);status.dataset.isolation=JSON.stringify(message.isolation);status.textContent=frameReady?"Isolation verified":"Plugin isolation is unavailable. Reload before using this plugin.";return;}
if(!frameReady||busy||message.kind!=="invoke"||Object.keys(message).sort().join(",")!=="input,installationId,kind,manifestHash,method,nonce,protocol,requestId,revision"||!config.allowedMethods.includes(message.method)||typeof message.requestId!=="string"||!/^[a-f0-9-]{36}$/i.test(message.requestId))return;
try{if(new TextEncoder().encode(JSON.stringify(message)).length>32768)return;}catch{return;}
busy=true;const source=event.source,requestEpoch=epoch;let reply={protocol:1,kind:"result",installationId:config.installationId,revision:config.revision,manifestHash:config.manifestHash,nonce:config.bridgeNonce,requestId:message.requestId,ok:false};
status.textContent="Running plugin method…";
try{
const challenge=await fetch("/api/auth/csrf",{credentials:"same-origin",cache:"no-store"});if(!challenge.ok)throw Error();const csrf=await challenge.json();
const response=await fetch("/api/plugins/"+encodeURIComponent(config.installationId)+"/invoke",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json","x-csrf-token":csrf.csrfToken},body:JSON.stringify({method:message.method,input:message.input,expectedRevision:config.revision,idempotencyKey:message.requestId,confirmed:true})});
if(!response.ok)throw Error();const result=await response.json();if(new TextEncoder().encode(JSON.stringify(result)).length>32768)throw Error();reply={...reply,ok:true,result:result.result};if(epoch===requestEpoch)status.textContent="Updated";
}catch{if(epoch===requestEpoch)status.textContent="Request failed. Check your session, project permissions or installation status before retrying.";}
finally{busy=false;}
// Opaque sandbox origins require '*'; send only to the pinned frame and suppress results after a navigation.
if(frame.contentWindow===source&&epoch===requestEpoch)source.postMessage(reply,"*");
});
})();`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task Weaver plugin</title><style nonce="${nonce}">body{font:15px system-ui,sans-serif;margin:0;background:#f6f8fb;color:#172033}header{display:flex;gap:20px;align-items:center;padding:16px 24px;background:white;border-bottom:1px solid #dfe5ef}a{color:#285caa}iframe{display:block;width:calc(100% - 48px);height:70vh;margin:24px;border:1px solid #dfe5ef;border-radius:12px;background:white}#tw-viewer-status{margin:0 24px;color:#536174}</style></head><body><header><a href="/projects">Task Weaver</a><strong>${escapeHtml(ticket.displayName)}</strong><span>${escapeHtml(ticket.pluginId)}</span><span>Revision ${ticket.revision}</span></header><iframe id="tw-plugin-frame" title="Isolated plugin" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${ticket.artifactUrl}"></iframe><p id="tw-viewer-status" role="status">The plugin uses its own isolated state.</p><script nonce="${nonce}">${script}</script></body></html>`;
  return { html, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src ${ticket.artifactUrl}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  } };
}

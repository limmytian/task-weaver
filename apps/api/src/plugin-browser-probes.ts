import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";

/** Disposable fixture only: preserve shipped CSP/sandbox while adding trusted attack controls. */
export async function startPluginBrowserProbeProxy(options: {
  port: number; upstreamPort: number; role: "web" | "artifact";
  webOrigin: string; apiOrigin: string; sinkOrigin: string;
  report(): Promise<unknown>;
}) {
  let sinkRequests = 0;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    if (options.role === "web" && path === "/fixture-probe-report") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(await options.report())); return;
    }
    if (path.startsWith("/fixture-probe-sink")) {
      sinkRequests++; response.writeHead(200, { "content-type": "text/plain" }); response.end("Unexpected probe request reached sink"); return;
    }
    const upstream = httpRequest({ hostname: "127.0.0.1", port: options.upstreamPort, path, method: request.method, headers: { ...request.headers, host: request.headers.host, "accept-encoding": "identity" } }, incoming => {
      const contentType = String(incoming.headers["content-type"] ?? "");
      const instrument = request.method === "GET" && incoming.statusCode === 200 && contentType.includes("text/html") && (options.role === "artifact" ? path.startsWith("/artifacts/") : /^\/plugins\/[a-f0-9-]{36}$/.test(path));
      if (!instrument) { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); return; }
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
        const encoded = html.match(/const config=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)?.[1];
        if (!nonce || !encoded) { response.writeHead(502); response.end("Fixture instrumentation could not bind the shipped renderer"); return; }
        const binding = JSON.parse(JSON.parse(encoded));
        const script = options.role === "artifact" ? artifactProbe(binding, options) : viewerProbe(binding);
        const headers = { ...incoming.headers }; delete headers["content-length"]; delete headers["content-encoding"];
        response.writeHead(incoming.statusCode ?? 200, headers);
        response.end(html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`));
      });
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Fixture upstream unavailable"); });
    request.pipe(upstream);
  });
  server.listen(options.port, "127.0.0.1"); await once(server, "listening");
  return { server, sinkRequests: () => sinkRequests, stop: () => close(server) };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
const js = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
function artifactProbe(binding: Record<string, unknown>, options: { webOrigin: string; apiOrigin: string; sinkOrigin: string }) {
  return `(()=>{"use strict";
const config=${js(binding)},targets=${js([options.webOrigin, options.apiOrigin, options.sinkOrigin])};
const panel=document.createElement("section"),heading=document.createElement("h2"),report=document.createElement("pre");heading.textContent="Disposable browser security probes";panel.append(heading,report);document.body.append(panel);
const results={violations:[],messages:0,network:[],topNavigationDenied:false};
document.addEventListener("securitypolicyviolation",event=>{results.violations.push({directive:event.effectiveDirective,blocked:event.blockedURI});show();});
const show=()=>{report.textContent=JSON.stringify(results,null,2);};
const button=(name,action)=>{const b=document.createElement("button");b.textContent=name;b.addEventListener("click",action);panel.append(b);};
button("Run sandbox probes",async()=>{
try{window.top.location.href=targets[2]+"/fixture-probe-sink/top";}catch(error){results.topNavigationDenied=error.name==="SecurityError";}
for(const target of targets){try{await fetch(target+"/fixture-probe-sink/fetch");results.network.push("UNEXPECTED success");}catch{results.network.push("fetch denied: "+target);}}
const image=document.createElement("img");image.src=targets[2]+"/fixture-probe-sink/image";panel.append(image);
const nested=document.createElement("iframe");nested.src=targets[2]+"/fixture-probe-sink/nested";panel.append(nested);
show();
});
const invoke={protocol:1,kind:"invoke",installationId:config.installationId,revision:config.revision,manifestHash:config.manifestHash,nonce:config.bridgeNonce,requestId:"33333333-3333-4333-8333-333333333333",method:"increment",input:{}};
button("Send invalid bound-frame messages",()=>{
const cyclic={};cyclic.self=cyclic;
for(const message of [null,{...invoke,nonce:"wrong"},{...invoke,installationId:"44444444-4444-4444-8444-444444444444"},{...invoke,revision:999},{...invoke,manifestHash:"d".repeat(64)},{...invoke,protocol:2},{...invoke,method:"__tw_preflight"},{...invoke,requestId:"bad"},{...invoke,sql:"SELECT 1"},{...invoke,input:{value:"x".repeat(40000)}},{...invoke,input:cyclic}]){window.parent.postMessage(message,config.webOrigin);results.messages++;}show();
});
button("Send valid message from sibling frame",()=>{window.parent.postMessage(invoke,config.webOrigin);results.messages++;show();});
for(const [index,label] of ["Core","API","sink"].entries())button("Attempt frame navigation to "+label,()=>{location.href=targets[index]+"/fixture-probe-sink/navigation";});
show();})();`;
}
function viewerProbe(binding: Record<string, unknown>) {
  return `(()=>{"use strict";
const config=${js(binding)},panel=document.createElement("section"),heading=document.createElement("h2"),report=document.createElement("pre");heading.textContent="Disposable host probe observations";panel.append(heading,report);document.body.append(panel);
const violations=[];document.addEventListener("securitypolicyviolation",event=>{violations.push({directive:event.effectiveDirective,blocked:event.blockedURI});report.textContent=JSON.stringify({violations},null,2);});
const button=(name,action)=>{const b=document.createElement("button");b.textContent=name;b.addEventListener("click",action);panel.append(b);};
button("Read authoritative fixture state",async()=>{const response=await fetch("/fixture-probe-report",{cache:"no-store"});report.textContent=JSON.stringify({violations,state:await response.json()},null,2);});
button("Add opaque sibling frame",()=>{if(document.getElementById("probe-sibling"))return;const sibling=document.createElement("iframe");sibling.id="probe-sibling";sibling.title="Unbound sibling probe";sibling.sandbox="allow-scripts";sibling.src=config.artifactUrl;panel.append(sibling);});
button("Send message from host origin",()=>{window.postMessage({protocol:1,kind:"invoke",installationId:config.installationId,revision:config.revision,manifestHash:config.manifestHash,nonce:config.bridgeNonce,requestId:"55555555-5555-4555-8555-555555555555",method:"increment",input:{}},config.webOrigin);});
})();`;
}

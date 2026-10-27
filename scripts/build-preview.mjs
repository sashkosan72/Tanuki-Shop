// Connector deployment fallback: bundle small static files as modules.
// Normal Wrangler deployments continue to use native Workers Assets.
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const files={};
function walk(dir){for(const d of readdirSync(dir,{withFileTypes:true})){const p=join(dir,d.name);if(d.isDirectory())walk(p);else files['/'+p.slice(7)]=readFileSync(p,'utf8');}}
walk('public');
for(const width of [320,390,768])files['/__qa/mobile-'+width+'.html']=`<!doctype html><html lang="uk"><meta charset="utf-8"><title>Preview QA — ${width}px</title><body style="margin:16px;background:#ddd;font:16px system-ui"><p>Перевірка адаптивності: ${width}px</p><iframe title="Tanuki Shop ${width}px" src="/" style="width:${width}px;height:844px;border:1px solid #333"></iframe></body></html>`;
mkdirSync('dist-preview',{recursive:true});
const entry=`import worker from './index.js';\nconst files=${JSON.stringify(files)};\nconst types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'application/javascript; charset=utf-8',svg:'image/svg+xml'};\nexport default { async fetch(request,env,ctx){ if(env.ENVIRONMENT!=='preview')return new Response('Preview only',{status:503}); const ASSETS={async fetch(req){ const u=new URL(req.url);let path=u.pathname;if(path.endsWith('/'))path+='index.html';if(!files[path]&&files[path+'/index.html'])return Response.redirect(u.origin+path+'/',308);if(!files[path])return new Response('Not found',{status:404});return new Response(req.method==='HEAD'?null:files[path],{headers:{'Content-Type':types[path.split('.').pop()]||'text/plain','Cache-Control':'no-store'}}); }};const r=await worker.fetch(request,{...env,ASSETS},ctx);const out=new Response(r.body,r);out.headers.set('X-Robots-Tag','noindex, nofollow');return out; }};`;
writeFileSync('dist-preview/preview.js',entry);

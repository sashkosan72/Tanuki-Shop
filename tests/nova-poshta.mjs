import assert from 'node:assert/strict';
import {handleNovaPoshtaLookup,isPostomat} from '../src/nova-poshta.js';
const base='https://preview.example/api/shipping/nova-poshta';
function request(q){return new Request(base+(q?'?'+q:''));}
async function check(q,env,status){const r=await handleNovaPoshtaLookup(request(q),env);assert.equal(r.status,status,q);return r.json();}
assert.equal((await check('type=areas',{},503)).code,'not_configured');
await check('type=unknown',{},400);
await check('type=cities&q=Ки', {NOVA_POSHTA_API_KEY:'test'},400);
await check('type=warehouses&city=invalid',{NOVA_POSHTA_API_KEY:'test'},400);
assert.equal(isPostomat({Description:'Поштомат №1'}),true);
assert.equal(isPostomat({Description:'Відділення №2'}),false);
const original=globalThis.fetch;
try{
 globalThis.fetch=async(url,options)=>{
   assert.equal(url,'https://api.novaposhta.ua/v2.0/json/');
   const req=JSON.parse(options.body);
   assert.equal(req.apiKey,'test');
   return new Response(JSON.stringify({success:true,data:req.calledMethod==='getAreas'?
     [{Ref:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',Description:'Київська'}]:
     [{Ref:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',Description:'Поштомат №1'},
      {Ref:'cccccccc-cccc-cccc-cccc-cccccccccccc',Description:'Відділення №2'}]}),
     {headers:{'Content-Type':'application/json'}});
 };
 const areas=await check('type=areas',{NOVA_POSHTA_API_KEY:'test'},200);
 assert.equal(areas.items[0].name,'Київська');
 const wh=await check('type=warehouses&city=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&filter=postomat',{NOVA_POSHTA_API_KEY:'test'},200);
 assert.deepEqual(wh.items.map(x=>x.name),['Поштомат №1']);
}finally{globalThis.fetch=original;}
console.log('PASS: Nova Poshta key isolation, validation, API proxy and postomat filter');

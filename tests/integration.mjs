import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
const origin='https://tanuki-shop-preview-pr6.sashh4051.workers.dev',messages=[];
let deliveryOK=true,checks=0;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist-preview/index.js',compatibilityDate:'2026-10-11',d1Databases:['DB'],bindings:{ADMIN_PASSWORD:'local-admin-fixture',ENVIRONMENT:'preview',TANUKI_COINS_ENABLED:'true',CUSTOMER_PASSWORD_PEPPER:'ab'.repeat(32),SITE_ORIGIN:origin,CUSTOMER_AUTH_ENABLED:'true',TELEGRAM_BOT_USERNAME:'TanukiQATestBot',TELEGRAM_BOT_TOKEN:'local-test-token',TELEGRAM_WEBHOOK_SECRET:'local-test-webhook'},outboundService:async request=>{assert.equal(new URL(request.url).hostname,'api.telegram.org');messages.push(await request.json());return new Response(JSON.stringify({ok:deliveryOK,result:{message_id:1}}),{status:deliveryOK?200:503,headers:{'Content-Type':'application/json'}});}}));
const db=await mf.getD1Database('DB');
async function sql(s){return db.prepare(s).run();}
async function call(path,body,expected=200,headers={}){const r=await mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Origin':origin,'X-Tanuki-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(d)}`);checks++;return {r,d};}
try{
for(const path of ['tests/store-schema.sql','migrations/20261023_customer_accounts.sql','migrations/20261024_telegram_login.sql','migrations/20261025_partners.sql','migrations/20261028_promotions.sql','migrations/20261028_shipping_methods.sql','migrations/20261028_tanuki_coins_preview.sql']){
 const source=readFileSync(path,'utf8').replace(/^--.*$/gm,'');
 const triggerIndex=source.indexOf('CREATE TRIGGER');
 const plain=triggerIndex<0?source:source.slice(0,triggerIndex);
 for(const s of plain.split(';').filter(s=>s.trim()))await sql(s);
 if(triggerIndex>=0){
   const triggers=source.slice(triggerIndex).split(/(?=CREATE TRIGGER IF NOT EXISTS )/).filter(x=>x.trim());
   for(const trigger of triggers)await sql(trigger.trim().replace(/;\s*$/,''));
 }
}
await call('/api/health'); await call('/api/products');await call('/api/unknown',undefined,404);await call('/api/admin/orders',undefined,401);await call('/api/customer/me',undefined,401);await call('/api/customer/orders',undefined,401);
const stamp=Math.floor(Date.now()/1000);
function signed(patch={},token='local-test-token'){
 const data={id:123456,first_name:'QA',auth_date:stamp,...patch};
 const check=Object.keys(data).sort().map(k=>k+'='+data[k]).join('\n');
 return {...data,hash:createHmac('sha256',createHash('sha256').update(token).digest()).update(check).digest('hex')};
}
const endpoint='/api/customer/telegram';
const config=await call('/api/customer/auth-config');assert.equal(config.d.botUsername,'TanukiQATestBot');checks++;
for(const route of ['register','login','forgot','reset'])await call('/api/customer/'+route,{},410);
await call(endpoint,signed(),403,{Origin:'https://evil.invalid'});
await call(endpoint,signed(),403,{'X-Tanuki-Request':''});
await call(endpoint,{},401);
await call(endpoint,signed({},'wrong-token'),401);
await call(endpoint,{...signed(),first_name:'Tampered'},401);
await call(endpoint,signed({auth_date:stamp-301}),401);
await call(endpoint,signed({auth_date:stamp+60}),401);
await call(endpoint,signed({id:'123456'}),401);
await call(endpoint,signed({id:-1}),401);
await call(endpoint,signed({id:1.5}),401);
await call(endpoint,signed({first_name:{bad:1}}),401);
await call(endpoint,signed({email:'attacker@example.invalid'}),401);
await call(endpoint,signed({username:'a'.repeat(6000)}),401);
let login=await call(endpoint,signed());let cookie=login.r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);cookie=cookie.split(';')[0];checks++;
assert.equal(login.d.customer.email,'');checks++;
await call(endpoint,signed(),409);
await call('/api/customer/me',undefined,200,{Cookie:cookie});const emptyOrders=await call('/api/customer/orders',undefined,200,{Cookie:cookie});assert.deepEqual(emptyOrders.d.orders,[]);checks++;let wallet=await call('/api/customer/wallet',undefined,200,{Cookie:cookie});assert.equal(wallet.d.points,0);assert.deepEqual(wallet.d.transactions,[]);assert.equal(wallet.d.enabled,true);checks+=3;
await call('/api/customer/logout',{},200,{Cookie:cookie});await call('/api/customer/me',undefined,401,{Cookie:cookie});
// A legacy account and its balances remain attached to its verified Telegram ID.
await sql("INSERT INTO customer_accounts(name,email,password_salt,password_hash,password_iterations,telegram_id,verified_at) VALUES('Legacy','old@example.invalid','salt','oldhash',180000,'777',CURRENT_TIMESTAMP)");
const legacy=await db.prepare("SELECT id FROM customer_accounts WHERE telegram_id='777'").first();
await db.prepare("INSERT INTO customer_wallet_transactions(customer_id,points_delta,reason) VALUES(?,37,'test')").bind(legacy.id).run();
login=await call(endpoint,signed({id:777}));assert.equal(login.d.customer.id,legacy.id);assert.equal(login.d.customer.email,'old@example.invalid');checks++;
cookie=login.r.headers.get('set-cookie').split(';')[0];wallet=await call('/api/customer/wallet',undefined,200,{Cookie:cookie});assert.equal(wallet.d.points,37);assert.equal(wallet.d.transactions.length,1);assert.equal(wallet.d.transactions[0].delta,37);assert.equal(wallet.d.transactions[0].reason,'test');assert.equal(wallet.d.enabled,true);checks+=5;
const unchanged=await db.prepare('SELECT password_hash FROM customer_accounts WHERE id=?').bind(legacy.id).first();assert.equal(unchanged.password_hash,'oldhash');checks++;
// Concurrent replay: exactly one session, not one per racing request.
const race=signed({id:888});const results=await Promise.all([200,409].map(()=>mf.dispatchFetch(origin+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Tanuki-Request':'1'},body:JSON.stringify(race)})));
assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);checks++;
assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM customer_sessions s JOIN customer_accounts a ON a.id=s.customer_id WHERE a.telegram_id='888'").first()).n,1);checks++;
// Do not merge a new Telegram identity into an email account.
login=await call(endpoint,signed({id:999,username:'old'}));assert.notEqual(login.d.customer.id,legacy.id);checks++;
const otherWallet=await call('/api/customer/wallet',undefined,200,{Cookie:login.r.headers.get('set-cookie').split(';')[0]});
assert.equal(otherWallet.d.points,0);assert.deepEqual(otherWallet.d.transactions,[]);checks+=2;
await call('/api/telegram/webhook',{message:{}},401);
await sql("DELETE FROM customer_request_limits");
for(let i=0;i<40;i++)await call(endpoint,{},401);
await call(endpoint,{},429);
await sql("DELETE FROM customer_request_limits");
const order={customerName:'QA Only',customerPhone:'0000000000',customerCity:'Тест',customerAddress:'Тестова адреса',shippingMethod:'nova_poshta',items:[{id:'qa-sticker',quantity:2,price:1}]};
await call('/api/orders',{...order,shippingMethod:'invalid'},400);
await call('/api/orders',{...order,shippingMethod:''},400);
const {d:ordered}=await call('/api/orders',order,201);
assert.equal(ordered.shipping_method,'nova_poshta');checks++;
assert.equal((await db.prepare('SELECT shipping_method FROM orders WHERE id=?').bind(ordered.order_id).first()).shipping_method,'nova_poshta');checks++;
const ukr=await call('/api/orders',{...order,shippingMethod:'ukrposhta',items:[{id:'qa-sticker',quantity:1}]},201);
assert.equal(ukr.d.shipping_method,'ukrposhta');checks++;
assert.equal((await db.prepare('SELECT shipping_method FROM orders WHERE id=?').bind(ukr.d.order_id).first()).shipping_method,'ukrposhta');checks++;
assert.equal(ordered.total,160);checks++;
const linkedTelegram=await db.prepare("INSERT INTO telegram_customers(telegram_id) VALUES('777')").run();
const linkedId=linkedTelegram.meta.last_row_id;
const createdOrder=await db.prepare("SELECT id FROM orders WHERE order_number=?").bind(ordered.orderNumber).first();
assert.ok(createdOrder);checks++;
{
 await db.prepare("INSERT INTO order_telegram_links(order_id,telegram_customer_id) VALUES(?,?)").bind(createdOrder.id,linkedId).run();
 const owned=await call('/api/customer/orders',undefined,200,{Cookie:cookie});
 assert.equal(owned.d.orders.length,1);checks++;
 assert.equal(owned.d.orders[0].total,160);checks++;
 assert.equal(owned.d.orders[0].shippingMethod,'nova_poshta');checks++;
 const unowned=await call('/api/customer/orders',undefined,200,{Cookie:login.r.headers.get('set-cookie').split(';')[0]});
 assert.deepEqual(unowned.d.orders,[]);checks++;
}

assert.equal((await db.prepare("SELECT stock FROM products WHERE id='qa-sticker'").first()).stock,7);checks++;
await call('/api/orders',{...order,items:[{id:'qa-sticker',quantity:99}]},400);
await call('/api/orders',{...order,items:[{id:'qa-sticker',quantity:2},{id:'qa-soldout',quantity:1}]},400);
assert.equal((await db.prepare("SELECT stock FROM products WHERE id='qa-sticker'").first()).stock,7);checks++;
// Invalid shipping must not create an order or reserve stock.
const beforeInvalid=(await db.prepare('SELECT COUNT(*) AS n FROM orders').first()).n;
const stockInvalid=(await db.prepare("SELECT stock FROM products WHERE id='qa-sticker'").first()).stock;
await call('/api/orders',{...order,shippingMethod:'not-a-provider'},400);
assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM orders').first()).n,beforeInvalid);checks++;
assert.equal((await db.prepare("SELECT stock FROM products WHERE id='qa-sticker'").first()).stock,stockInvalid);checks++;
await call('/api/orders',{...order,items:[]},400);
await call('/api/orders',{...order,items:[{id:'qa-sticker',quantity:-1}]},400);

// Partner CRUD through the actual router and isolated D1.
await call('/api/partners');
await call('/api/admin/partners',undefined,401);
await call('/api/admin/partners',{},401);
const admin=await call('/api/admin/login',{password:'local-admin-fixture'});
const adminCookie=admin.r.headers.get('set-cookie').split(';')[0];
const fixture={name:'QA <script>literal</script>',description:'Partner description',url:'https://example.com/',image_url:'https://example.com/avatar.png',sort_order:2,active:false};
async function partner(method,path,body,expected,extra={}){
 const response=await mf.dispatchFetch(origin+path,{method,headers:{Cookie:adminCookie,Origin:origin,'Content-Type':'application/json','X-Tanuki-Request':'1',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));checks++;return data;
}
await partner('POST','/api/admin/partners',fixture,403,{Origin:'https://evil.invalid'});
await partner('POST','/api/admin/partners',fixture,403,{'X-Tanuki-Request':''});
for(const patch of [{url:'javascript:alert(1)'},{image_url:'data:image/svg+xml,test'},{url:'https://user:password@example.com'},{sort_order:-1},{active:'true'},{name:''},{description:'a'.repeat(1001)}])await partner('POST','/api/admin/partners',{...fixture,...patch},400);
await partner('POST','/api/admin/partners',{...fixture,description:'a'.repeat(17000)},400);
const created=await partner('POST','/api/admin/partners',fixture,201);
let publicRows=(await call('/api/partners')).d.partners;assert.equal(publicRows.length,0);checks++;
const route='/api/admin/partners/'+created.id;
await partner('PATCH',route,{...fixture,active:true},200);
publicRows=(await call('/api/partners')).d.partners;assert.equal(publicRows.length,1);assert.equal(publicRows[0].name,fixture.name);checks++;
await partner('PATCH',route,{...fixture,active:false,image_url:''},200);
assert.equal((await call('/api/partners')).d.partners.length,0);checks++;
await partner('PATCH','/api/admin/partners/999999',fixture,404);
await partner('DELETE',route,undefined,200);
await partner('DELETE',route,undefined,404);
assert.equal((await call('/api/partners')).d.partners.length,0);checks++;

// Promotion quote uses authoritative sale prices; activation is explicit.
await call('/api/admin/promotions',undefined,401);
const promo={code:'qa-oct28',percent:10,min_total:100,expires_at:null,active:false};
await partner('POST','/api/admin/promotions',promo,403,{Origin:'https://evil.invalid'});
await partner('POST','/api/admin/promotions',promo,403,{'X-Tanuki-Request':''});
for(const patch of [{percent:100},{percent:0},{percent:2.5},{min_total:-1},{code:'<script>'},{active:'true'},{expires_at:'garbage'}])await partner('POST','/api/admin/promotions',{...promo,...patch},400);
const promoCreated=await partner('POST','/api/admin/promotions',promo,201);
await partner('POST','/api/admin/promotions',promo,409);
const promoRoute='/api/admin/promotions/'+promoCreated.id;
await sql("UPDATE products SET stock=10 WHERE id='qa-sticker'");
const quote={code:promo.code,items:order.items,total:1,discount_amount:99999};
await call('/api/promotions/quote',quote,400);
await partner('PATCH',promoRoute,{...promo,active:true},200);
await call('/api/promotions/quote',quote,403,{'X-Tanuki-Request':''});
const quoted=(await call('/api/promotions/quote',quote)).d;
assert.equal(quoted.subtotal,160);assert.equal(quoted.discount_amount,16);assert.equal(quoted.total,144);checks++;
await call('/api/promotions/quote',{...quote,items:[{id:'qa-sticker',quantity:1}]},400);
await call('/api/promotions/quote',{...quote,items:[{id:'qa-sticker',quantity:-1}]},400);
await call('/api/promotions/quote',{...quote,items:[{id:'qa-sticker',quantity:99},{id:'qa-sticker',quantity:99}]},400);
await call('/api/promotions/quote',{...quote,items:[{id:'missing',quantity:2}]},400);
const stockBefore=(await db.prepare("SELECT stock FROM products WHERE id='qa-sticker'").first()).stock;
await call('/api/orders',{...order,promo_code:'DOES-NOT-EXIST'},400);
assert.equal((await db.prepare("SELECT stock FROM products WHERE id='qa-sticker'").first()).stock,stockBefore);checks++;
const discounted=(await call('/api/orders',{...order,promo_code:promo.code,total:1,discount_amount:159},201)).d;
assert.equal(discounted.total,144);checks++;
const snapshot=await db.prepare('SELECT * FROM order_promotions WHERE order_id=?').bind(discounted.order_id).first();assert.equal(snapshot.code,'QA-OCT28');assert.equal(snapshot.subtotal,160);assert.equal(snapshot.discount_amount,16);checks++;
await partner('PATCH',promoRoute,{...promo,percent:20,active:false},200);
assert.equal((await db.prepare('SELECT discount_amount FROM order_promotions WHERE order_id=?').bind(discounted.order_id).first()).discount_amount,16);checks++;
await call('/api/orders',{...order,promo_code:promo.code},400);
await sql("UPDATE promotions SET active=1,expires_at='2020-01-01T00:00:00.000Z'");
await call('/api/promotions/quote',quote,400);
await call('/api/orders',{...order,promo_code:promo.code},400);
const adminOrders=await call('/api/admin/orders',undefined,200,{Cookie:adminCookie});assert.equal(adminOrders.d.orders.find(x=>x.id===discounted.order_id).promotion.discount_amount,16);checks++;

// Tanuki Coins integration: isolated D1, feature flag remains off on Production.
{
 const {noteOrderStatus,previewWallet}=await import('../src/tanuki-coins.js');
 const env={DB:db,ENVIRONMENT:'preview',TANUKI_COINS_ENABLED:'true'};
 const customer=await db.prepare("SELECT id,telegram_id FROM customer_accounts WHERE telegram_id='777'").first();
 // Existing test order is explicitly linked to this account. Confirm it and backdate
 // only the isolated completion timestamp to simulate the 14-day vesting period.
 await db.prepare("UPDATE orders SET status='completed' WHERE id=?").bind(createdOrder.id).run();
 await noteOrderStatus(env,createdOrder.id,'completed');
 await db.prepare("UPDATE loyalty_order_completions SET completed_at=datetime('now','-15 days') WHERE order_id=?").bind(createdOrder.id).run();
 let coins=await previewWallet(env,customer);
 assert.equal(coins.enabled,true);assert.equal(coins.redemptionEnabled,true);
 assert.equal(coins.points,37+10+3);checks+=3;
 const first=await db.prepare("SELECT COUNT(*) AS n FROM loyalty_awards WHERE order_id=?").bind(createdOrder.id).first();
 assert.equal(first.n,2);checks++;
 // Actual checkout endpoint validates the session, promo exclusion and 20% cap.
 const orderCoins={...order,items:[{id:'qa-sticker',quantity:1}],coins_to_spend:10};
 await call('/api/orders',orderCoins,400); // no authenticated cookie
 await call('/api/orders',{...orderCoins,coins_to_spend:17},400,{Cookie:cookie}); // > 20% of 80
 await call('/api/orders',{...orderCoins,promo_code:'QA-OCT28'},400,{Cookie:cookie});
 const redeemed=(await call('/api/orders',{...orderCoins,coins_to_spend:10},201,{Cookie:cookie})).d;
 assert.equal(redeemed.coins_spent,10);assert.equal(redeemed.total,70);checks+=2;
 assert.equal((await db.prepare("SELECT SUM(points) AS spent FROM loyalty_spends WHERE order_id=?").bind(redeemed.order_id).first()).spent,10);checks++;
 const spendBalance=(await call('/api/customer/wallet',undefined,200,{Cookie:cookie})).d;
 assert.equal(spendBalance.points,40);checks++;
 const secondAttempt=(await call('/api/orders',{...orderCoins,coins_to_spend:10},400,{Cookie:cookie})).d;
 assert.match(secondAttempt.error,/Недостатньо/);checks++;
 await db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").bind(redeemed.order_id).run();
 await noteOrderStatus(env,redeemed.order_id,'cancelled');
 assert.equal((await previewWallet(env,customer)).points,50);checks++;


 coins=await previewWallet(env,customer);
 assert.equal(coins.points,50);checks++;
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM loyalty_awards WHERE order_id=?").bind(createdOrder.id).first()).n,2);checks++;
 await db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").bind(createdOrder.id).run();
 await noteOrderStatus(env,createdOrder.id,'cancelled');
 coins=await previewWallet(env,customer);
 assert.equal(coins.points,37);checks++;
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM loyalty_awards WHERE order_id=? AND reversed_at IS NOT NULL").bind(createdOrder.id).first()).n,2);checks++;
 const productionWallet=await import('../src/tanuki-coins.js');
 assert.equal(productionWallet.coinsEnabled({ENVIRONMENT:'production',TANUKI_COINS_ENABLED:'true'}),false);checks++;
}
// Spend ledger: DB trigger prevents overspending, other-account use and cancelled original awards.
{
 const customer=await db.prepare("SELECT id FROM customer_accounts WHERE telegram_id='777'").first();
 const awardSource=await db.prepare("SELECT id FROM orders WHERE status='new' LIMIT 1").first();
 const orig=await db.prepare("SELECT id FROM orders WHERE status='completed' LIMIT 1").first();
 // Create a synthetic completed order and matured award in isolated D1.
 const completed=await db.prepare("INSERT INTO orders(order_number,customer_name,customer_phone,customer_city,customer_address,total_amount,status,shipping_method) VALUES('QA-COINS-SOURCE','QA','000','test','test',1000,'completed','nova_poshta')").run();
 const cid=completed.meta.last_row_id;
 const issued=await db.prepare("INSERT INTO loyalty_awards(order_id,customer_id,kind,points,available_at,expires_at) VALUES(?,?,'base',60,datetime('now','-1 day'),datetime('now','+30 day'))").bind(cid,customer.id).run();
 const aid=issued.meta.last_row_id;
 const checkout=await db.prepare("INSERT INTO orders(order_number,customer_name,customer_phone,customer_city,customer_address,total_amount,status,shipping_method) VALUES('QA-COINS-SPEND','QA','000','test','test',100,'new','nova_poshta')").run();
 const oid=checkout.meta.last_row_id;
 await db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(oid,aid,customer.id,40).run();
 await assert.rejects(()=>db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(oid+999,aid,customer.id,1).run());checks++;
 const checkout2=await db.prepare("INSERT INTO orders(order_number,customer_name,customer_phone,customer_city,customer_address,total_amount,status,shipping_method) VALUES('QA-COINS-SPEND2','QA','000','test','test',100,'new','nova_poshta')").run();
 await assert.rejects(()=>db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(checkout2.meta.last_row_id,aid,customer.id,30).run());checks++;
 await db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(checkout2.meta.last_row_id,aid,customer.id,20).run();checks++;
 await assert.rejects(()=>db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(oid,aid,999999,1).run());checks++;
 await db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").bind(oid).run();
 await db.prepare("UPDATE loyalty_spends SET refunded_at=CURRENT_TIMESTAMP WHERE order_id=?").bind(oid).run();
 const checkout3=await db.prepare("INSERT INTO orders(order_number,customer_name,customer_phone,customer_city,customer_address,total_amount,status,shipping_method) VALUES('QA-COINS-SPEND3','QA','000','test','test',100,'new','nova_poshta')").run();
 await db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(checkout3.meta.last_row_id,aid,customer.id,40).run();checks++;
 await db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").bind(cid).run();
 await assert.rejects(()=>db.prepare("INSERT INTO loyalty_spends(order_id,award_id,customer_id,points) VALUES(?,?,?,?)").bind(checkout3.meta.last_row_id,aid,customer.id,1).run());checks++;
}
console.log(`PASS: ${checks} integration assertions (local Workers runtime + isolated D1; Telegram transport mocked)`);
}finally{await mf.dispose();}


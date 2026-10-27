import {normalizePromoCode,quotePromo} from "./promo-engine.js";
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const fail=(message,status=400)=>json({ok:false,error:message},status);
const codePattern=/^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const promoEnabled=env=>env.PROMO_CODES_ENABLED==="true";
export function promoError(reason){
 return ({invalid_code:"Некоректний промокод.",inactive:"Промокод неактивний або не існує.",invalid_rule:"Некоректні налаштування промокоду.",minimum_order:"Недостатня сума замовлення для промокоду.",not_started:"Промокод ще не діє.",expired:"Термін дії промокоду минув.",limit:"Ліміт використань промокоду вичерпано."})[reason]||"Промокод недоступний.";
}
function asPromo(row){
 return {code:row.code,active:row.active===1,type:row.discount_type,value:row.value,minimumOrder:row.minimum_order,startsAt:row.starts_at,expiresAt:row.expires_at};
}
export async function validatePromoForSubtotal(env,rawCode,subtotal){
 if(!promoEnabled(env))return {ok:false,reason:"disabled"};
 const code=normalizePromoCode(rawCode);
 if(!code)return {ok:false,reason:"invalid_code"};
 const row=await env.DB.prepare("SELECT code,discount_type,value,minimum_order,starts_at,expires_at,max_uses,active FROM promo_codes WHERE code=?").bind(code).first();
 if(!row)return {ok:false,reason:"inactive"};
 const quote=quotePromo(asPromo(row),subtotal);
 if(!quote.ok)return quote;
 if(row.max_uses!==null){
   const used=await env.DB.prepare("SELECT COUNT(*) AS n FROM promo_redemptions WHERE code=?").bind(row.code).first();
   if(Number(used.n)>=row.max_uses)return {ok:false,reason:"limit"};
 }
 return {...quote,rule:row};
}
// Guard conditions are rechecked transactionally at order INSERT time so two
// simultaneous buyers cannot both redeem the last remaining use.
export const orderPromoEligibility=`
 EXISTS (SELECT 1 FROM promo_codes p WHERE p.code=? AND p.active=1
 AND p.discount_type=? AND p.value=? AND p.minimum_order=?
 AND COALESCE(p.starts_at,'')=COALESCE(?,'')
 AND COALESCE(p.expires_at,'')=COALESCE(?,'')
 AND COALESCE(p.max_uses,-1)=COALESCE(?,-1)
 AND (p.starts_at IS NULL OR p.starts_at<=?)
 AND (p.expires_at IS NULL OR p.expires_at>?)
 AND (p.max_uses IS NULL OR (SELECT COUNT(*) FROM promo_redemptions pr WHERE pr.code=p.code)<p.max_uses))
`;
export function orderPromoBindings(rule,now=new Date()){
 const iso=now.toISOString();
 return [rule.code,rule.discount_type,rule.value,rule.minimum_order,rule.starts_at,rule.expires_at,rule.max_uses,iso,iso];
}
function checkOrigin(req){
 return req.headers.get("Origin")===new URL(req.url).origin&&req.headers.get("X-Tanuki-Request")==="1";
}
async function parseBody(req){
 if(!req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))throw Error("Потрібен JSON.");
 if(Number(req.headers.get("Content-Length")||0)>12000)throw Error("Завеликий запит.");
 if(!req.body)throw Error("Немає даних.");
 const reader=req.body.getReader(),pieces=[];let size=0;
 while(true){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>12000){await reader.cancel();throw Error("Завеликий запит.");}pieces.push(x.value);}
 const bytes=new Uint8Array(size);let pos=0;for(const piece of pieces){bytes.set(piece,pos);pos+=piece.length;}
 let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error("Некоректний JSON.");}
 if(!body||typeof body!=="object"||Array.isArray(body))throw Error("Некоректні дані.");
 return body;
}
function dateOrNull(x){
 if(x===null||x==="")return null;
 if(typeof x!=="string"||!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/.test(x)||!Number.isFinite(Date.parse(x)))throw Error("Дата має бути у форматі UTC ISO 8601.");
 return x;
}
function validateAdminBody(body){
 const code=normalizePromoCode(body.code);
 if(!code||!codePattern.test(code))throw Error("Код: 3–32 символи латиницею, цифри, _ або -.");
 if(body.type!=="percent"&&body.type!=="fixed")throw Error("Оберіть тип знижки.");
 if(!Number.isSafeInteger(body.value)||body.value<1||(body.type==="percent"&&body.value>100)||(body.type==="fixed"&&body.value>100000000))throw Error("Некоректна знижка.");
 if(!Number.isSafeInteger(body.minimumOrder)||body.minimumOrder<0||body.minimumOrder>100000000)throw Error("Некоректна мінімальна сума.");
 if(body.maxUses!==null&&(!Number.isSafeInteger(body.maxUses)||body.maxUses<1||body.maxUses>1000000))throw Error("Некоректний ліміт.");
 if(typeof body.active!=="boolean")throw Error("Укажіть активність.");
 const starts=dateOrNull(body.startsAt??null),expires=dateOrNull(body.expiresAt??null);
 if(starts&&expires&&starts>=expires)throw Error("Кінцева дата має бути пізнішою за початок.");
 return {code,type:body.type,value:body.value,minimumOrder:body.minimumOrder,starts,expires,maxUses:body.maxUses,active:body.active?1:0};
}
export async function adminPromos(request,env){
 const method=request.method,path=new URL(request.url).pathname;
 const match=path.match(/^\\/api\\/admin\\/promos(?:\\/([A-Za-z0-9_-]{3,32}))?$/);
 if(!match)return fail("Маршрут не знайдено.",404);
 const id=match[1]||null;
 try{
   if(method==="GET"&&id===null){
     const data=await env.DB.prepare("SELECT p.*, (SELECT COUNT(*) FROM promo_redemptions r WHERE r.code=p.code) AS used_count FROM promo_codes p ORDER BY p.created_at DESC LIMIT 200").all();
     return json({ok:true,enabled:promoEnabled(env),promos:data.results||[]});
   }
   if(!((method==="POST"&&id===null)||(method==="PATCH"&&id!==null)))return fail("Метод не підтримується.",405);
   if(!checkOrigin(request))return fail("Недозволений запит.",403);
   const p=validateAdminBody(await parseBody(request));
   if(id===null){
     await env.DB.prepare("INSERT INTO promo_codes(code,discount_type,value,minimum_order,starts_at,expires_at,max_uses,active) VALUES(?,?,?,?,?,?,?,?)").bind(p.code,p.type,p.value,p.minimumOrder,p.starts,p.expires,p.maxUses,p.active).run();
     return json({ok:true,code:p.code},201);
   }
   if(p.code!==id.toUpperCase())return fail("Код існуючого промокоду змінювати не можна.",400);
   const updated=await env.DB.prepare("UPDATE promo_codes SET discount_type=?,value=?,minimum_order=?,starts_at=?,expires_at=?,max_uses=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE code=?").bind(p.type,p.value,p.minimumOrder,p.starts,p.expires,p.maxUses,p.active,p.code).run();
   return updated.meta?.changes?json({ok:true,code:p.code}):fail("Промокод не знайдено.",404);
 }catch(e){
   if(e.message?.includes("UNIQUE"))return fail("Такий промокод уже існує.",409);
   if(e.message?.startsWith("D1")||e.message?.includes("no such table"))return fail("Міграцію промокодів ще не застосовано.",503);
   if(/^(Некоректн|Потрібен|Завеликий|Немає|Код:|Оберіть|Укажіть|Дата|Кінцева)/.test(e.message||""))return fail(e.message);
   console.error("Admin promos",e?.name||"unknown");return fail("Помилка промокодів.",500);
 }
}
export async function quotePromoCart(request,env){
 if(!promoEnabled(env))return fail("Промокоди ще не запущені.",503);
 if(!checkOrigin(request))return fail("Недозволений запит.",403);
 try{
   const body=await parseBody(request),items=body.items;
   if(!Array.isArray(items)||items.length<1||items.length>30)return fail("Некоректний кошик.");
   const quantities=new Map();
   for(const item of items){
     if(!item||typeof item.id!=="string"||item.id.length>100||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>99)return fail("Некоректний товар.");
     quantities.set(item.id,(quantities.get(item.id)||0)+item.quantity);
   }
   let subtotal=0;
   for(const [id,qty] of quantities){
     if(qty>99)return fail("Завелика кількість.");
     const p=await env.DB.prepare("SELECT price,sale_price,active,stock,track_stock FROM products WHERE id=?").bind(id).first();
     if(!p||p.active!==1||(p.track_stock===1&&p.stock<qty))return fail("Товар недоступний.");
     const price=p.sale_price===null?Number(p.price):Number(p.sale_price);
     if(!Number.isSafeInteger(price)||price<=0)return fail("Некоректна ціна.");
     subtotal+=price*qty;
     if(!Number.isSafeInteger(subtotal)||subtotal>10000000000)return fail("Завелика сума.");
   }
   const quoted=await validatePromoForSubtotal(env,body.promoCode,subtotal);
   if(!quoted.ok)return fail(promoError(quoted.reason));
   return json({ok:true,code:quoted.code,subtotal:quoted.subtotal,discount:quoted.discount,total:quoted.total});
 }catch(e){if(/^(Некоректн|Потрібен|Завеликий|Немає)/.test(e.message||""))return fail(e.message);console.error("Promo quote",e?.name||"unknown");return fail("Тимчасова помилка промокоду.",500);}
}

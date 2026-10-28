const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export class PromotionError extends Error {}
export function normalizeCode(value){
 if(typeof value!=='string'||! /^[A-Za-z0-9_-]{3,32}$/.test(value.trim()))throw new PromotionError('Промокод: 3–32 латинські літери, цифри, дефіс або підкреслення.');
 return value.trim().toUpperCase();
}
export async function boundedJSON(request){
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new PromotionError('Потрібен JSON.');
 const reader=request.body?.getReader();if(!reader)throw new PromotionError('Немає даних.');
 const parts=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16000){await reader.cancel();throw new PromotionError('Завеликий запит.');}parts.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new PromotionError('Некоректний JSON.');}
}
export async function discountFor(env,code,subtotal){
 code=normalizeCode(code);
 const p=await env.DB.prepare('SELECT code,percent,min_total,expires_at FROM promotions WHERE code=? AND active=1').bind(code).first();
 if(!p||(p.expires_at&&Date.parse(p.expires_at)<=Date.now()))throw new PromotionError('Промокод не діє або строк дії закінчився.');
 if(subtotal<p.min_total)throw new PromotionError('Мінімальна сума для цього промокоду: '+p.min_total+' ₴.');
 const discount=Math.floor(subtotal*p.percent/100);
 if(discount<1)throw new PromotionError('Сума кошика замала для цієї знижки.');
 return {code:p.code,percent:p.percent,subtotal,discount_amount:discount,total:subtotal-discount};
}
export async function quotePromotion(request,env){
 if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('X-Tanuki-Request')!=='1')return json({ok:false,error:'Недозволений запит.'},403);
 try{
 const body=await boundedJSON(request);
 if(!body||!Array.isArray(body.items)||!body.items.length||body.items.length>30)throw new PromotionError('Перевірте кошик.');
 const quantities=new Map();
 for(const item of body.items){if(typeof item?.id!=='string'||item.id.length>100||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>99)throw new PromotionError('Некоректна позиція кошика.');quantities.set(item.id,(quantities.get(item.id)||0)+item.quantity);}
 let subtotal=0;
 for(const [id,quantity] of quantities){if(quantity>99)throw new PromotionError('Завелика кількість товару.');const p=await env.DB.prepare('SELECT price,sale_price,stock,track_stock FROM products WHERE id=? AND active=1').bind(id).first();if(!p||p.track_stock&&p.stock<quantity)throw new PromotionError('Товар недоступний у потрібній кількості.');const price=p.sale_price??p.price;if(!Number.isSafeInteger(price)||price<1)throw new PromotionError('Некоректна ціна.');subtotal+=price*quantity;}
 if(!Number.isSafeInteger(subtotal)||subtotal<1)throw new PromotionError('Некоректна сума.');
 return json({ok:true,...await discountFor(env,body.code,subtotal)});
 }catch(e){if(e instanceof PromotionError)return json({ok:false,error:e.message},400);throw e;}
}
export async function adminPromotions(request,env){
 const match=new URL(request.url).pathname.match(/^\/api\/admin\/promotions(?:\/(\d+))?$/);if(!match)return json({ok:false},404);
 const id=match[1]?Number(match[1]):null;
 if(request.method==='GET'&&id===null){const r=await env.DB.prepare('SELECT * FROM promotions ORDER BY id DESC LIMIT 200').all();return json({ok:true,promotions:r.results});}
 if(!(request.method==='POST'&&id===null||request.method==='PATCH'&&id!==null))return json({ok:false},405);
 if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('X-Tanuki-Request')!=='1')return json({ok:false,error:'Недозволений запит.'},403);
 try{
 const p=await boundedJSON(request);if(!p||typeof p!=='object')throw new PromotionError('Некоректні дані.');const code=normalizeCode(p.code);
 if(!Number.isSafeInteger(p.percent)||p.percent<1||p.percent>90||!Number.isSafeInteger(p.min_total)||p.min_total<0||p.min_total>1000000||typeof p.active!=='boolean')throw new PromotionError('Знижка: 1–90%; мінімальна сума: 0–1 000 000 ₴.');
 let expires=null;
 if(p.expires_at){if(typeof p.expires_at!=='string'||!Number.isFinite(Date.parse(p.expires_at)))throw new PromotionError('Некоректний строк дії.');expires=new Date(p.expires_at).toISOString();if(p.active&&Date.parse(expires)<=Date.now())throw new PromotionError('Дата завершення має бути в майбутньому.');}
 const duplicate=await env.DB.prepare('SELECT id FROM promotions WHERE code=?').bind(code).first();if(duplicate&&duplicate.id!==id)return json({ok:false,error:'Такий промокод уже існує.'},409);
 const values=[code,p.percent,p.min_total,expires,p.active?1:0];
 const r=id===null?await env.DB.prepare('INSERT INTO promotions(code,percent,min_total,expires_at,active) VALUES(?,?,?,?,?)').bind(...values).run():await env.DB.prepare('UPDATE promotions SET code=?,percent=?,min_total=?,expires_at=?,active=? WHERE id=?').bind(...values,id).run();
 if(id!==null&&!r.meta.changes)return json({ok:false,error:'Промокод не знайдено.'},404);
 return json({ok:true,id:id??r.meta.last_row_id},id===null?201:200);
 }catch(e){if(e instanceof PromotionError)return json({ok:false,error:e.message},400);if(String(e.message).includes('UNIQUE constraint'))return json({ok:false,error:'Такий промокод уже існує.'},409);throw e;}
}

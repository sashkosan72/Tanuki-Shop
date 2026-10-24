/* Tanuki Shop customer accounts. Requires preview D1 migration. Disabled by default. */
import {telegramBotUsername, telegramReady, siteOrigin} from './environment.js';
const COOKIE="__Host-tanuki_customer",ENC=new TextEncoder();
const ok=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});
const err=(message,status=400)=>ok({ok:false,error:message},status);
const hex=b=>Array.from(b,n=>n.toString(16).padStart(2,"0")).join("");
const random=(n=32)=>hex(crypto.getRandomValues(new Uint8Array(n)));
const sha=async text=>hex(new Uint8Array(await crypto.subtle.digest("SHA-256",ENC.encode(text))));
const unhex=h=>new Uint8Array((h.match(/../g)||[]).map(x=>parseInt(x,16)));
function getCookie(request){
  for(const part of (request.headers.get("Cookie")||"").split(";")){
    const i=part.indexOf("=");
    if(i>0&&part.slice(0,i).trim()===COOKIE)return part.slice(i+1).trim();
  }
  return "";
}
const setCookie=(value,age=604800)=>[COOKIE+"="+value,"Path=/","Secure","HttpOnly","SameSite=Strict","Max-Age="+age].join("; ");
function allowed(request){return request.headers.get("Origin")===new URL(request.url).origin&&request.headers.get("X-Tanuki-Request")==="1";}
async function input(request){
  if(!request.headers.get("Content-Type")?.startsWith("application/json"))return null;
  if(!request.body)return null;
  const reader=request.body.getReader(),chunks=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>5000){await reader.cancel();return null;}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text=new TextDecoder().decode(bytes);
  try{const val=JSON.parse(text);return val&&!Array.isArray(val)&&typeof val==="object"?val:null;}catch{return null;}
}
const publicUser=x=>({id:x.id,name:x.name,email:x.email?.endsWith('@telegram.invalid')?'':x.email,telegramLinked:!!x.telegram_id});
async function rate(env,req,action,max,windowSeconds){
  const ip=req.headers.get("CF-Connecting-IP")||"unknown";
  const key=await sha("tanuki:"+action+":"+ip);
  const now=Math.floor(Date.now()/1000),cutoff=now-windowSeconds;
  await env.DB.prepare("INSERT INTO customer_request_limits(key_hash,window_start,attempts) VALUES(?,?,1) ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN ? ELSE window_start END")
    .bind(key,now,cutoff,cutoff,now).run();
  const row=await env.DB.prepare("SELECT attempts FROM customer_request_limits WHERE key_hash=?").bind(key).first();
  return Number(row?.attempts||0)<=max;
}
async function currentUser(req,env){
  const token=getCookie(req);if(!/^[0-9a-f]{64}$/.test(token))return null;
  return env.DB.prepare("SELECT a.id,a.name,a.email,a.telegram_id FROM customer_sessions s JOIN customer_accounts a ON a.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>datetime('now') AND a.verified_at IS NOT NULL LIMIT 1")
    .bind(await sha(token)).first();
}
// Only fields documented by Telegram Login Widget are accepted and signed.
async function telegramLogin(req,env){
  if(!telegramReady(env))return err("Вхід через Telegram ще не налаштований.",503);
  if(!await rate(env,req,"telegram-login",40,900))return err("Забагато спроб. Спробуйте через 15 хвилин.",429);
  const data=await input(req),now=Math.floor(Date.now()/1000);
  const keys=['id','first_name','last_name','username','photo_url','auth_date','hash'];
  if(!data||Object.keys(data).some(k=>!keys.includes(k))||
    !Number.isSafeInteger(data.id)||data.id<=0||
    !Number.isSafeInteger(data.auth_date)||data.auth_date<now-300||data.auth_date>now+30||
    typeof data.first_name!=='string'||!data.first_name.trim()||data.first_name.length>256||
    !/^[0-9a-f]{64}$/.test(data.hash||'')||
    ['last_name','username','photo_url'].some(k=>k in data&&(typeof data[k]!=='string'||data[k].length>2048)))
    return err("Підтвердження Telegram недійсне або застаріле. Спробуйте увійти знову.",401);
  const check=Object.keys(data).filter(k=>k!=='hash').sort().map(k=>k+'='+data[k]).join('\n');
  const secret=await crypto.subtle.digest('SHA-256',ENC.encode(env.TELEGRAM_BOT_TOKEN));
  const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,unhex(data.hash),ENC.encode(check)))
    return err("Не вдалося перевірити підпис Telegram.",401);
  const telegramId=String(data.id),token=random(),tokenHash=await sha(token);
  // Preserve account IDs, emails, balances and order relationships. Never merge by email or username.
  await env.DB.prepare("INSERT INTO customer_accounts(name,email,password_salt,password_hash,password_iterations,telegram_id,verified_at) VALUES(?,?,'','telegram-only',0,?,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO NOTHING")
    .bind((data.first_name+' '+(data.last_name||'')).trim().slice(0,70),random(16)+'@telegram.invalid',telegramId).run();
  const user=await env.DB.prepare("SELECT id,name,email,telegram_id,verified_at FROM customer_accounts WHERE telegram_id=?").bind(telegramId).first();
  if(!user?.verified_at)return err("Цей акаунт ще не підтверджений. Зверніться до підтримки.",403);
  // Atomic one-use proof claim, including concurrent requests. A replay cannot mint a second session.
  const result=await env.DB.batch([
    env.DB.prepare("DELETE FROM customer_telegram_logins WHERE expires_at<?").bind(now),
    env.DB.prepare("INSERT INTO customer_telegram_logins(proof_hash,claim,expires_at) VALUES(?,?,?) ON CONFLICT(proof_hash) DO NOTHING").bind(data.hash,tokenHash,data.auth_date+360),
    env.DB.prepare("INSERT INTO customer_sessions(customer_id,token_hash,expires_at) SELECT ?,?,datetime('now','+7 days') WHERE EXISTS(SELECT 1 FROM customer_telegram_logins WHERE proof_hash=? AND claim=?)").bind(user.id,tokenHash,data.hash,tokenHash)
  ]);
  if(!result[2]?.meta?.changes)return err("Це підтвердження вже використане. Повторіть вхід через Telegram.",409);
  return ok({ok:true,customer:publicUser(user)},200,{'Set-Cookie':setCookie(token)});
}
export async function handleCustomerRoute(request,env){
  if(env.CUSTOMER_AUTH_ENABLED!=="true")return err("Особистий кабінет ще готується до запуску.",503);
  if(!env.DB)return err("База даних недоступна.",503);
  const path=new URL(request.url).pathname,method=request.method.toUpperCase();
  const gets=["/api/customer/me","/api/customer/wallet","/api/customer/auth-config"];
  const posts=["/api/customer/telegram","/api/customer/register","/api/customer/login","/api/customer/logout","/api/customer/forgot","/api/customer/reset"];
  if(!((method==="GET"&&gets.includes(path))||(method==="POST"&&posts.includes(path))))return err("Маршрут не знайдено.",404);
  if(method==="POST"&&!allowed(request))return err("Неприпустиме джерело запиту.",403);
  try{
    if(path==="/api/customer/auth-config")return ok({ok:true,mode:'telegram',botUsername:telegramBotUsername(env),ready:telegramReady(env)});
    if(path==="/api/customer/telegram")return await telegramLogin(request,env);
    if(['/api/customer/register','/api/customer/login','/api/customer/forgot','/api/customer/reset'].includes(path))
      return err("Тепер вхід і реєстрація відбуваються через Telegram без пароля. Відкрийте особистий кабінет.",410);
    if(path==="/api/customer/logout"){
      const token=getCookie(request);
      if(/^[0-9a-f]{64}$/.test(token))
        await env.DB.prepare("DELETE FROM customer_sessions WHERE token_hash=?").bind(await sha(token)).run();
      return ok({ok:true},200,{"Set-Cookie":setCookie("",0)});
    }
    const customer=await currentUser(request,env);
    if(!customer)return err("Увійдіть до акаунта.",401);
    if(path==="/api/customer/me")return ok({ok:true,customer:publicUser(customer)});
    const balance=await env.DB.prepare("SELECT COALESCE(SUM(points_delta),0) AS points FROM customer_wallet_transactions WHERE customer_id=?").bind(customer.id).first();
    return ok({ok:true,points:Number(balance?.points||0),enabled:false,currency:"bonus_points",message:"Бонусна програма ще не запущена."});
  }catch(error){
    console.error("Customer API error",error?.name||"unknown");
    return err("Тимчасова помилка. Спробуйте пізніше.",500);
  }
}
export async function confirmAccountFromTelegram(env,telegramUser,token){
  if(env.CUSTOMER_AUTH_ENABLED!=="true")return "Реєстрація акаунтів поки не запущена.";
  if(!/^[0-9a-f]{48}$/.test(token))return "Посилання підтвердження некоректне.";
  const telegramId=String(telegramUser?.id||"");
  if(!/^\d+$/.test(telegramId))return "Не вдалося перевірити Telegram.";
  try {
    const result=await env.DB.prepare("UPDATE customer_accounts SET telegram_id=?,verified_at=CURRENT_TIMESTAMP,pending_token_hash=NULL,pending_expires_at=NULL WHERE pending_token_hash=? AND verified_at IS NULL AND pending_expires_at>datetime('now') AND NOT EXISTS(SELECT id FROM customer_accounts WHERE telegram_id=?)").bind(telegramId,await sha(token),telegramId).run();
    return result.meta?.changes===1
      ?"✅ Акаунт підтверджено! Поверніться до Tanuki Shop та натисніть «Увійти через Telegram»."
      :"Посилання недійсне або цей Telegram уже прив'язаний до іншого акаунта.";
  }catch(error){
    console.error("Customer confirmation error",error?.name||"unknown");
    return "Не вдалося підтвердити акаунт. Зверніться до підтримки.";
  }
}

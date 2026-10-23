/* Tanuki Shop customer accounts. Requires preview D1 migration. Disabled by default. */
const BOT="TanukiShopNotifyBot",COOKIE="__Host-tanuki_customer",ITERS=180000,ENC=new TextEncoder();
const ok=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});
const err=(message,status=400)=>ok({ok:false,error:message},status);
const hex=b=>Array.from(b,n=>n.toString(16).padStart(2,"0")).join("");
const random=(n=32)=>hex(crypto.getRandomValues(new Uint8Array(n)));
const sha=async text=>hex(new Uint8Array(await crypto.subtle.digest("SHA-256",ENC.encode(text))));
const unhex=h=>new Uint8Array((h.match(/../g)||[]).map(x=>parseInt(x,16)));
async function hashPassword(password,salt,iterations=ITERS) {
  const key=await crypto.subtle.importKey("raw",ENC.encode(password),"PBKDF2",false,["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt:unhex(salt),iterations,hash:"SHA-256"},key,256)));
}
function equal(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
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
  const text=await request.text();if(text.length>5000)return null;
  try{const val=JSON.parse(text);return val&&!Array.isArray(val)&&typeof val==="object"?val:null;}catch{return null;}
}
function emailValue(x){
  if(typeof x!=="string")return "";
  const val=x.trim().toLowerCase();return val.length<=254&&/^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]{2,}$/.test(val)?val:"";
}
const validPass=x=>typeof x==="string"&&x.length>=10&&x.length<=128&&ENC.encode(x).length<=256;
const publicUser=x=>({id:x.id,name:x.name,email:x.email,telegramLinked:!!x.telegram_id});
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
async function register(req,env){
  if(!await rate(env,req,"register",8,3600))return err("Забагато спроб. Спробуйте пізніше.",429);
  const body=await input(req),email=emailValue(body?.email),name=typeof body?.name==="string"?body.name.trim():"";
  if(!email||name.length<2||name.length>70||!validPass(body?.password))
    return err("Вкажіть ім'я, коректний email та пароль від 10 до 128 символів.");
  if(await env.DB.prepare("SELECT id FROM customer_accounts WHERE email=?").bind(email).first())
    return err("Цей email уже використовується. Увійдіть або відновіть доступ.",409);
  const salt=random(16),digest=await hashPassword(body.password,salt),token=random(24),tokenHash=await sha(token);
  try {
    await env.DB.prepare("INSERT INTO customer_accounts(name,email,password_salt,password_hash,password_iterations,pending_token_hash,pending_expires_at) VALUES(?,?,?,?,?,?,datetime('now','+30 minutes'))")
      .bind(name,email,salt,digest,ITERS,tokenHash).run();
  }catch(e){
    if(String(e).includes("UNIQUE"))return err("Цей email уже використовується.",409);
    throw e;
  }
  return ok({ok:true,verificationRequired:true,message:"Підтвердіть акаунт у Telegram протягом 30 хвилин.",
    telegramUrl:"https://t.me/"+BOT+"?start=acc_"+token},201);
}
async function login(req,env){
  if(!await rate(env,req,"login",40,900))return err("Забагато спроб входу. Спробуйте через 15 хвилин.",429);
  const body=await input(req),email=emailValue(body?.email),pass=body?.password;
  if(!email||typeof pass!=="string"||pass.length>128)return err("Невірні дані для входу.",401);
  const row=await env.DB.prepare("SELECT * FROM customer_accounts WHERE email=?").bind(email).first();
  if(row?.locked_until&&Date.parse(row.locked_until.replace(" ","T")+"Z")>Date.now())
    return err("Вхід тимчасово заблоковано. Спробуйте через 15 хвилин.",429);
  const iters=Number(row?.password_iterations||ITERS);
  if(iters<100000||iters>1000000)throw new Error("Invalid password hashing configuration");
  const digest=await hashPassword(pass,row?.password_salt||"9b12cdbb5fa32411cfe26f397fed6598",iters);
  if(!row||!equal(digest,row.password_hash)){
    if(row)await env.DB.prepare("UPDATE customer_accounts SET failed_logins=failed_logins+1,locked_until=CASE WHEN failed_logins>=7 THEN datetime('now','+15 minutes') ELSE locked_until END WHERE id=?").bind(row.id).run();
    return err("Невірний email або пароль.",401);
  }
  if(!row.verified_at)return err("Спочатку підтвердіть акаунт у Telegram.",403);
  await env.DB.prepare("UPDATE customer_accounts SET failed_logins=0,locked_until=NULL WHERE id=?").bind(row.id).run();
  const token=random(32);
  await env.DB.prepare("INSERT INTO customer_sessions(customer_id,token_hash,expires_at) VALUES(?,?,datetime('now','+7 days'))").bind(row.id,await sha(token)).run();
  return ok({ok:true,customer:publicUser(row)},200,{"Set-Cookie":setCookie(token)});
}
async function sendTelegram(env,chatId,message){
  if(!env.TELEGRAM_BOT_TOKEN)return false;
  const res=await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendMessage",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text:message,disable_web_page_preview:true})
  });
  return res.ok;
}
async function forgot(req,env){
  if(!await rate(env,req,"forgot",5,3600))return err("Забагато запитів. Спробуйте пізніше.",429);
  const body=await input(req),email=emailValue(body?.email);if(!email)return err("Введіть коректний email.");
  const response=ok({ok:true,message:"Якщо акаунт підтверджено, посилання прийде до вашого Telegram."});
  const user=await env.DB.prepare("SELECT id,telegram_id FROM customer_accounts WHERE email=? AND verified_at IS NOT NULL AND telegram_id IS NOT NULL").bind(email).first();
  if(!user||!env.TELEGRAM_BOT_TOKEN)return response;
  const recent=await env.DB.prepare("SELECT id FROM customer_password_resets WHERE customer_id=? AND created_at>datetime('now','-2 minutes') LIMIT 1").bind(user.id).first();
  if(recent)return response;
  const token=random(32),url=new URL("/account/?reset="+token,req.url).toString();
  await env.DB.prepare("INSERT INTO customer_password_resets(customer_id,token_hash,expires_at) VALUES(?,?,datetime('now','+20 minutes'))").bind(user.id,await sha(token)).run();
  try {await sendTelegram(env,user.telegram_id,"🔐 Tanuki Shop: відновлення пароля.\nПосилання дійсне 20 хвилин:\n"+url+"\nЯкщо ви не запитували це — ігноруйте повідомлення.");}
  catch(e){console.error("Customer password reset delivery error");}
  return response;
}
async function reset(req,env){
  if(!await rate(env,req,"reset",12,3600))return err("Забагато запитів. Спробуйте пізніше.",429);
  const body=await input(req);
  if(!/^[0-9a-f]{64}$/.test(body?.token||"")||!validPass(body?.password))
    return err("Невірне посилання або пароль коротший за 10 символів.");
  const row=await env.DB.prepare("SELECT id,customer_id FROM customer_password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>datetime('now') LIMIT 1").bind(await sha(body.token)).first();
  if(!row)return err("Посилання недійсне або термін його дії минув.");
  const salt=random(16),digest=await hashPassword(body.password,salt);
  // Claim with a unique marker; a reused token cannot change a password.
  const claim=random(16);
  const result=await env.DB.batch([
    env.DB.prepare("UPDATE customer_password_resets SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>datetime('now')").bind(claim,row.id),
    env.DB.prepare("UPDATE customer_accounts SET password_salt=?,password_hash=?,password_iterations=?,failed_logins=0,locked_until=NULL WHERE id=? AND EXISTS(SELECT 1 FROM customer_password_resets WHERE id=? AND used_at=?)").bind(salt,digest,ITERS,row.customer_id,row.id,claim),
    env.DB.prepare("DELETE FROM customer_sessions WHERE customer_id=? AND EXISTS(SELECT 1 FROM customer_password_resets WHERE id=? AND used_at=?)").bind(row.customer_id,row.id,claim)
  ]);
  if(!result[0]?.meta?.changes)return err("Посилання вже використано.");
  return ok({ok:true,message:"Пароль змінено. Увійдіть із новим паролем."});
}
export async function handleCustomerRoute(request,env){
  if(env.CUSTOMER_AUTH_ENABLED!=="true")return err("Особистий кабінет ще готується до запуску.",503);
  if(!env.DB)return err("База даних недоступна.",503);
  const path=new URL(request.url).pathname,method=request.method.toUpperCase();
  const gets=["/api/customer/me","/api/customer/wallet"];
  const posts=["/api/customer/register","/api/customer/login","/api/customer/logout","/api/customer/forgot","/api/customer/reset"];
  if(!((method==="GET"&&gets.includes(path))||(method==="POST"&&posts.includes(path))))return err("Маршрут не знайдено.",404);
  if(method==="POST"&&!allowed(request))return err("Неприпустиме джерело запиту.",403);
  try{
    if(path==="/api/customer/register")return await register(request,env);
    if(path==="/api/customer/login")return await login(request,env);
    if(path==="/api/customer/forgot")return await forgot(request,env);
    if(path==="/api/customer/reset")return await reset(request,env);
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
      ?"✅ Акаунт підтверджено! Поверніться до Tanuki Shop та увійдіть з email і паролем."
      :"Посилання недійсне або цей Telegram уже прив'язаний до іншого акаунта.";
  }catch(error){
    console.error("Customer confirmation error",error?.name||"unknown");
    return "Не вдалося підтвердити акаунт. Зверніться до підтримки.";
  }
}

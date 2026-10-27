const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function httpsURL(value, optional=false){
 if(optional && value==='')return '';
 if(typeof value!=='string'||value.length>2048)throw Error('Вкажіть коректне HTTPS-посилання.');
 let u;try{u=new URL(value);}catch{throw Error('Вкажіть коректне HTTPS-посилання.');}
 if(u.protocol!=='https:'||u.username||u.password)throw Error('Дозволені лише HTTPS-посилання без паролів.');
 return u.href;
}
export function validatePartner(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Некоректні дані партнера.');
 const name=typeof body.name==='string'?body.name.trim():'';
 const description=typeof body.description==='string'?body.description.trim():null;
 if(!name||name.length>100||description===null||description.length>1000)throw Error('Назва: до 100 символів; опис: до 1000.');
 if(typeof body.active!=='boolean'||!Number.isSafeInteger(body.sort_order)||body.sort_order<0||body.sort_order>9999)throw Error('Перевірте видимість і порядок показу (0–9999).');
 return {name,description,url:httpsURL(body.url),image_url:httpsURL(body.image_url,true),sort_order:body.sort_order,active:body.active?1:0};
}
async function boundedJSON(request){
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw Error('Потрібен JSON.');
 const reader=request.body?.getReader();if(!reader)throw Error('Немає даних.');
 const parts=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16000){await reader.cancel();throw Error('Завеликий запит.');}parts.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error('Некоректний JSON.');}
}
export async function publicPartners(env){
 const data=await env.DB.prepare('SELECT id,name,description,url,image_url FROM partners WHERE active=1 ORDER BY sort_order,id').all();
 return json({ok:true,partners:data.results||[]});
}
// Called only after the existing admin session check in the main router.
export async function adminPartners(request,env){
 const path=new URL(request.url).pathname;
 const match=path.match(/^\/api\/admin\/partners(?:\/(\d+))?$/);
 if(!match)return json({ok:false,error:'Не знайдено.'},404);
 const id=match[1]?Number(match[1]):null,method=request.method;
 if(id!==null&&(!Number.isSafeInteger(id)||id<1))return json({ok:false,error:'Некоректний ID.'},400);
 if(method==='GET'&&id===null){const data=await env.DB.prepare('SELECT * FROM partners ORDER BY sort_order,id').all();return json({ok:true,partners:data.results||[]});}
 if(!((method==='POST'&&id===null)||(method==='PATCH'&&id!==null)||(method==='DELETE'&&id!==null)))return json({ok:false,error:'Метод не підтримується.'},405);
 if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('X-Tanuki-Request')!=='1')return json({ok:false,error:'Недозволений запит.'},403);
 if(method==='DELETE'){
  const result=await env.DB.prepare('DELETE FROM partners WHERE id=?').bind(id).run();
  return result.meta.changes?json({ok:true}):json({ok:false,error:'Партнера не знайдено.'},404);
 }
 let p;try{p=validatePartner(await boundedJSON(request));}catch(error){return json({ok:false,error:error.message},400);}
 const values=[p.name,p.description,p.url,p.image_url,p.sort_order,p.active];
 if(id===null){
  const result=await env.DB.prepare('INSERT INTO partners(name,description,url,image_url,sort_order,active) VALUES(?,?,?,?,?,?)').bind(...values).run();
  return json({ok:true,id:result.meta.last_row_id},201);
 }
 const result=await env.DB.prepare('UPDATE partners SET name=?,description=?,url=?,image_url=?,sort_order=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(...values,id).run();
 return result.meta.changes?json({ok:true,id}):json({ok:false,error:'Партнера не знайдено.'},404);
}

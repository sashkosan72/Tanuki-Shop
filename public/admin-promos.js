// Admin-only UX; every mutation remains protected by the Worker admin cookie and origin checks.
(() => {
 "use strict";
 const $=id=>document.getElementById(id);
 const list=$("promosList"),form=$("promoForm"),msg=$("promosMessage");
 if(!list||!form)return;
 let editing=null;
 const request=async(path,options={})=>{
   const response=await fetch(path,{credentials:"same-origin",...options});
   const data=await response.json().catch(()=>({ok:false,error:"Помилка відповіді"}));
   if(!response.ok||!data.ok)throw Error(data.error||"Не вдалося виконати запит.");
   return data;
 };
 const formatTime=x=>x?x.replace("T"," ").replace("Z"," UTC"):"без обмеження";
 const utcValue=x=>x?x.slice(0,16):"";
 const setNotice=(message,error=false)=>{msg.textContent=message;msg.className=error?"error":"muted";};
 function clear(){
   editing=null;form.reset();$("promoCode").readOnly=false;
   $("promoMinimum").value="0";$("promoActive").checked=false;
 }
 function select(p){
   editing=p.code;
   $("promoCode").value=p.code;$("promoCode").readOnly=true;
   $("promoType").value=p.discount_type;
   $("promoValue").value=p.value;$("promoMinimum").value=p.minimum_order;
   $("promoMaxUses").value=p.max_uses??"";
   $("promoStart").value=utcValue(p.starts_at);
   $("promoEnd").value=utcValue(p.expires_at);
   $("promoActive").checked=p.active===1;
   form.scrollIntoView({behavior:"smooth",block:"nearest"});
 }
 async function refresh(){
   try{
     const data=await request("/api/admin/promos");
     list.replaceChildren();
     setNotice(data.enabled?"Промокоди доступні покупцям.":"Промокоди вимкнені для покупців.");
     if(!data.promos.length){const p=document.createElement("p");p.textContent="Промокодів поки немає.";list.append(p);}
     for(const promo of data.promos){
       const card=document.createElement("div");card.className="panel";
       const title=document.createElement("strong");title.textContent=promo.code;
       const info=document.createElement("p");info.className="muted";
       info.textContent=(promo.discount_type==="percent"?promo.value+"%":promo.value+" ₴")+" · мінімум "+promo.minimum_order+" ₴ · використано "+promo.used_count+(promo.max_uses===null?"":" / "+promo.max_uses)+" · "+(promo.active===1?"активний":"неактивний")+" · до "+formatTime(promo.expires_at);
       const edit=document.createElement("button");edit.type="button";edit.textContent="Редагувати";edit.className="secondary";edit.addEventListener("click",()=>select(promo));
       card.append(title,info,edit);list.append(card);
     }
   }catch(error){setNotice(error.message,true);}
 }
 const toIso=id=>$(id).value?$(id).value+":00Z":null;
 form.addEventListener("submit",async event=>{
   event.preventDefault();
   const button=$("promoSave");button.disabled=true;
   try{
     const payload={
       code:$("promoCode").value.trim().toUpperCase(),type:$("promoType").value,
       value:Number($("promoValue").value),minimumOrder:Number($("promoMinimum").value),
       maxUses:$("promoMaxUses").value===""?null:Number($("promoMaxUses").value),
       startsAt:toIso("promoStart"),expiresAt:toIso("promoEnd"),active:$("promoActive").checked
     };
     await request("/api/admin/promos"+(editing?"/"+encodeURIComponent(editing):""),{
       method:editing?"PATCH":"POST",headers:{"Content-Type":"application/json","X-Tanuki-Request":"1"},body:JSON.stringify(payload)
     });
     clear();await refresh();setNotice("Промокод збережено.");
   }catch(error){setNotice(error.message,true);}finally{button.disabled=false;}
 });
 $("promoNew").addEventListener("click",clear);
 $("promosRefresh").addEventListener("click",refresh);
 const tab=document.querySelector('[data-tab="promosTab"]');
 tab?.addEventListener("click",refresh);
})();

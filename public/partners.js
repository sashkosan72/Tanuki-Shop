const container=document.getElementById('partnerCards');
const message=document.getElementById('partnerMessage');
const retry=document.getElementById('partnerRetry');
function safeURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
async function loadPartners(){
 message.textContent='Завантажуємо партнерів…';retry.hidden=true;container.replaceChildren();
 try{
  const response=await fetch('/api/partners');const data=await response.json();
  if(!response.ok||!data.ok)throw Error();
  for(const p of data.partners){
   const card=document.createElement('article');card.className='partner-card';
   const avatar=document.createElement('div');avatar.className='partner-avatar';avatar.textContent=p.name.slice(0,1).toUpperCase();
   const imageURL=safeURL(p.image_url);
   if(imageURL){const img=document.createElement('img');img.src=imageURL;img.alt='Логотип '+p.name;img.loading='lazy';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>img.remove());avatar.append(img);}
   const heading=document.createElement('h2');heading.textContent=p.name;
   const description=document.createElement('p');description.textContent=p.description;
   card.append(avatar,heading,description);
   const url=safeURL(p.url);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.className='btn btn-primary';link.textContent='Відвідати партнера ↗';card.append(link);}
   container.append(card);
  }
  message.textContent=data.partners.length?'':'Незабаром тут з’являться наші партнери.';
 }catch{message.textContent='Не вдалося завантажити партнерів. Спробуйте ще раз.';retry.hidden=false;}
}
retry.addEventListener('click',loadPartners);loadPartners();

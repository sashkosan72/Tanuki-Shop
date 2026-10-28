// Nova Poshta API 2.0 address directory proxy. The secret never reaches the browser.
// No TTN, payment, shipment, or state-changing Nova Poshta API methods are exposed.
const apiUrl = "https://api.novaposhta.ua/v2.0/json/";
const refPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reply = (body, status=200) => new Response(JSON.stringify(body), {
  status, headers: {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});
const short=(s,n)=>typeof s==="string"?s.trim().slice(0,n):"";
export function isPostomat(row){
  return /(?:поштомат|postomat|parcel\s*locker)/i.test(
    [row?.Description,row?.DescriptionRu,row?.CategoryOfWarehouse,row?.ShortAddress].join(" ")
  );
}
export async function handleNovaPoshtaLookup(request,env){
  if(request.method!=="GET") return reply({ok:false,error:"Method not allowed."},405);
  const url=new URL(request.url),kind=url.searchParams.get("type");
  if(!["areas","cities","warehouses"].includes(kind))return reply({ok:false,error:"Невідомий довідник."},400);
  if(!env.NOVA_POSHTA_API_KEY)return reply({ok:false,code:"not_configured",error:"Автоматичний вибір Нової пошти ще налаштовується. Поки вкажіть адресу вручну."},503);
  const area=short(url.searchParams.get("area"),40),city=short(url.searchParams.get("city"),40);
  const search=short(url.searchParams.get("q"),80);
  const page=Math.min(Math.max(Number(url.searchParams.get("page"))||1,1),20);
  if(kind==="cities"&&(!refPattern.test(area)||search.length<2))return reply({ok:false,error:"Спочатку виберіть область і введіть хоча б 2 літери міста."},400);
  if(kind==="warehouses"&&!refPattern.test(city))return reply({ok:false,error:"Спочатку виберіть місто."},400);
  const calledMethod=kind==="areas"?"getAreas":kind==="cities"?"getCities":"getWarehouses";
  const filter=url.searchParams.get("filter");
  const limit=30;
  // Search at Nova Poshta BEFORE pagination. Filtering a mixed page locally can
  // otherwise show no postomats even when hundreds exist further in the city.
  const term=filter==="postomat"?"Поштомат":filter==="branch"?"Відділення":"";
  const needle=kind==="warehouses" ? (search
    ? (/^\\d{1,5}$/.test(search)&&term ? term+" №"+search : search)
    : term) : "";
  const methodProperties=kind==="areas"?{}:kind==="cities"
    ? {FindByString:search,Page:"1",Limit:"100"}
    : {CityRef:city,Page:String(page),Limit:String(limit),...(needle?{FindByString:needle}:{})};
  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),12000);
    let response;
    try{
      response=await fetch(apiUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        apiKey:env.NOVA_POSHTA_API_KEY,modelName:"Address",calledMethod,methodProperties
      }),signal:controller.signal});
    }finally{clearTimeout(timeout)}
    if(!response.ok)return reply({ok:false,error:"Довідник Нової пошти зараз недоступний."},502);
    const result=await response.json();
    if(!result?.success||!Array.isArray(result.data))return reply({ok:false,error:"Нова пошта не повернула дані. Спробуйте ще раз."},502);
    let rows=result.data;
    if(kind==="cities")rows=rows.filter(row=>!row.Area||row.Area===area);
    // Keep a second check in case the provider returns mixed warehouse types.
    if(kind==="warehouses"&&["branch","postomat"].includes(filter))rows=rows.filter(row=>isPostomat(row)===(filter==="postomat"));
    const items=rows.slice(0,150).map(row=>({
      ref:short(row.Ref,40),name:short(row.Description,220),
      ...(kind==="cities"?{areaRef:short(row.Area,40)}:{}),
      ...(kind==="warehouses"?{postomat:isPostomat(row),number:short(row.Number,16)}:{})
    })).filter(item=>refPattern.test(item.ref)&&item.name);
    return reply({ok:true,items,page,hasMore:kind==="warehouses"&&result.data.length>=limit});
  }catch(error){
    console.error("Nova Poshta lookup failed",error?.name||"error");
    return reply({ok:false,error:"Немає зв'язку з Новою поштою. Можна вказати відділення вручну."},502);
  }
}

// Pure promo quote logic. NOT connected to checkout until server-side atomic redemption is built.
const CODE=/^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export function normalizePromoCode(input){
  if(typeof input!=="string")return null;
  const code=input.trim().toUpperCase();
  return CODE.test(code)?code:null;
}
export function quotePromo(promo,subtotal,now=new Date()){
  if(!Number.isSafeInteger(subtotal)||subtotal<=0)throw new TypeError("Invalid subtotal");
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new TypeError("Invalid date");
  if(!promo||!normalizePromoCode(promo.code)||normalizePromoCode(promo.code)!==promo.code)
    return {ok:false,reason:"invalid_code"};
  if(promo.active!==true)return {ok:false,reason:"inactive"};
  const minimum=promo.minimumOrder??0;
  if(!Number.isSafeInteger(minimum)||minimum<0)return {ok:false,reason:"invalid_rule"};
  if(subtotal<minimum)return {ok:false,reason:"minimum_order"};
  if(promo.startsAt!==null&&promo.startsAt!==undefined){
    const start=Date.parse(promo.startsAt);
    if(!Number.isFinite(start))return {ok:false,reason:"invalid_rule"};
    if(now.getTime()<start)return {ok:false,reason:"not_started"};
  }
  if(promo.expiresAt!==null&&promo.expiresAt!==undefined){
    const end=Date.parse(promo.expiresAt);
    if(!Number.isFinite(end))return {ok:false,reason:"invalid_rule"};
    if(now.getTime()>=end)return {ok:false,reason:"expired"};
  }
  let discount;
  if(promo.type==="percent"&&Number.isSafeInteger(promo.value)&&promo.value>=1&&promo.value<=100){
    discount=Math.floor(subtotal*promo.value/100);
  }else if(promo.type==="fixed"&&Number.isSafeInteger(promo.value)&&promo.value>0){
    discount=Math.min(subtotal,promo.value);
  }else return {ok:false,reason:"invalid_rule"};
  return {ok:true,code:promo.code,subtotal,discount,total:subtotal-discount};
}

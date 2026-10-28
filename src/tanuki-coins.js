// Tanuki Coins (Preview-only). NEVER activate automatically in Production.
// Monetary values are whole hryvnias; points are whole Coins.
// Approved milestone rewards: 10/20/40/70 Coins for 1st/3rd/5th/10th purchase.
export const COINS_RULES=Object.freeze({
  fanAt:1000,vipAt:5000,
  startPercent:2,fanPercent:3,vipPercent:5,
  releaseDays:14,validDays:180,
  maxBasePerOrder:100,maxBasePerMonth:300,
  redemptionCapPercent:20,
  milestoneOrders:[1,3,5,10]
});
export function coinsEnabled(env){
  return env.ENVIRONMENT==='preview' && env.TANUKI_COINS_ENABLED==='true';
}
export function coinsTier(spend){
  const amount=Number(spend)||0;
  return amount>=COINS_RULES.vipAt?{name:'VIP',percent:5,nextAt:null}
    :amount>=COINS_RULES.fanAt?{name:'Fan',percent:3,nextAt:5000}
    :{name:'Start',percent:2,nextAt:1000};
}
export function milestoneAmounts(env){
  const raw=String(env.TANUKI_COINS_MILESTONES||'').trim();
  // Strict 4-number format, never accept JSON supplied from customers.
  if(!/^[0-9]{1,3},[0-9]{1,3},[0-9]{1,3},[0-9]{1,3}$/.test(raw))
    return {1:10,3:20,5:40,10:70,configured:true};
  const vals=raw.split(',').map(Number);
  if(vals.some(v=>!Number.isSafeInteger(v)||v>500))
    return {1:10,3:20,5:40,10:70,configured:true};
  return {1:vals[0],3:vals[1],5:vals[2],10:vals[3],configured:true};
}
export function calculateAward(total,completedSpend,purchaseNumber,gifts){
  if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(purchaseNumber)||purchaseNumber<1)
    throw Error('Invalid loyalty purchase');
  const tier=coinsTier(completedSpend);
  const base=Math.min(COINS_RULES.maxBasePerOrder,Math.floor(total*tier.percent/100));
  const milestone=Number(gifts?.[purchaseNumber]||0);
  if(!Number.isSafeInteger(milestone)||milestone<0||milestone>500)throw Error('Invalid milestone reward');
  return {base,milestone,tier};
}
export function redemptionLimit(itemSubtotal){
  if(!Number.isSafeInteger(itemSubtotal)||itemSubtotal<0)throw Error('Invalid subtotal');
  return Math.floor(itemSubtotal*COINS_RULES.redemptionCapPercent/100);
}
export async function noteOrderStatus(env,orderId,status){
  if(!coinsEnabled(env))return;
  if(!Number.isSafeInteger(Number(orderId))||Number(orderId)<1)return;
  if(status==='completed'){
    // First completion timestamp is authoritative. Repeated callbacks do not reset hold time.
    await env.DB.prepare(`INSERT OR IGNORE INTO loyalty_order_completions(order_id,completed_at)
      SELECT id,CURRENT_TIMESTAMP FROM orders WHERE id=? AND status='completed'`).bind(orderId).run();
  }else if(status==='cancelled'){
    // Cancellation/return invalidates previously earned Coins without touching other accounts.
    await env.DB.prepare(`UPDATE loyalty_awards SET reversed_at=CURRENT_TIMESTAMP
      WHERE order_id=? AND reversed_at IS NULL`).bind(orderId).run();
    await env.DB.prepare(`UPDATE loyalty_spends SET refunded_at=CURRENT_TIMESTAMP
      WHERE order_id=? AND refunded_at IS NULL`).bind(orderId).run();
  }
}
// Reconcile on authenticated wallet reads. No client-supplied customer_id, amount or order_id.
// Orders linked to the verified Telegram identity only; old orders are not backfilled.
export async function previewWallet(env,customer){
  const gifts=milestoneAmounts(env),id=customer.id;
  const result=customer.telegram_id?await env.DB.prepare(`
    SELECT DISTINCT e.order_id,e.completed_at,o.total_amount
    FROM loyalty_order_completions e
    JOIN orders o ON o.id=e.order_id
    JOIN order_telegram_links l ON l.order_id=o.id
    JOIN telegram_customers tc ON tc.id=l.telegram_customer_id
    WHERE tc.telegram_id=? AND o.status='completed'
    ORDER BY e.completed_at,e.order_id
  `).bind(String(customer.telegram_id)).all():{results:[]};
  const orders=result.results||[];
  let completedSpend=0,pending=0;
  for(let i=0;i<orders.length;i++){
    const o=orders[i];const total=Number(o.total_amount);
    if(!Number.isSafeInteger(total)||total<0)continue;
    const a=calculateAward(total,completedSpend,i+1,gifts);
    completedSpend+=total;
    const clock=await env.DB.prepare(`SELECT datetime(?,'+14 days')<=datetime('now') AS ready,
      datetime(?,'+194 days')>datetime('now') AS valid`).bind(o.completed_at,o.completed_at).first();
    if(!clock?.valid)continue;
    const ready=!!clock.ready;
    if(!ready){pending+=a.base+a.milestone;continue;}
    for(const [kind,coins] of [['base',a.base],['milestone',a.milestone]]){
      if(coins<1)continue;
      let points=coins;
      if(kind==='base'){
        const monthRow=await env.DB.prepare("SELECT substr(datetime(?,'+14 days'),1,7) AS month").bind(o.completed_at).first();
        const month=monthRow?.month;
        const monthly=await env.DB.prepare(`SELECT COALESCE(SUM(points),0) AS used
          FROM loyalty_awards WHERE customer_id=? AND kind='base'
          AND substr(available_at,1,7)=? `).bind(id,month).first();
        points=Math.max(0,Math.min(points,COINS_RULES.maxBasePerMonth-Number(monthly?.used||0)));
        if(points===0)continue;
      }
      await env.DB.prepare(`
        INSERT OR IGNORE INTO loyalty_awards(order_id,customer_id,kind,points,available_at,expires_at)
        SELECT ?,?,?,?,datetime(?,'+14 days'),datetime(?,'+194 days')
        WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND status='completed')
      `).bind(o.order_id,id,kind,points,o.completed_at,o.completed_at,o.order_id).run();
    }
  }
  const [available,legacy,awards,legacyHistory,spent]=await Promise.all([
    env.DB.prepare(`
      SELECT COALESCE(SUM(a.points),0) AS coins FROM loyalty_awards a
      JOIN orders o ON o.id=a.order_id
      WHERE a.customer_id=? AND o.status='completed' AND a.reversed_at IS NULL
        AND a.available_at<=datetime('now') AND a.expires_at>datetime('now')
    `).bind(id).first(),
    env.DB.prepare('SELECT COALESCE(SUM(points_delta),0) AS points FROM customer_wallet_transactions WHERE customer_id=?').bind(id).first(),
    env.DB.prepare(`SELECT a.kind,a.points,a.available_at,a.expires_at,a.reversed_at,o.order_number
      FROM loyalty_awards a JOIN orders o ON o.id=a.order_id
      WHERE a.customer_id=? ORDER BY a.id DESC LIMIT 20`).bind(id).all(),
    env.DB.prepare(`SELECT points_delta,reason,created_at FROM customer_wallet_transactions
      WHERE customer_id=? ORDER BY id DESC LIMIT 20`).bind(id).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(s.points),0) AS coins FROM loyalty_spends s
      JOIN orders o ON o.id=s.order_id
      WHERE s.customer_id=? AND s.refunded_at IS NULL AND o.status!='cancelled'`).bind(id).first()
  ]);
  const now=Date.now();
  const history=(awards.results||[]).map(a=>({
    delta:a.reversed_at?0:Number(a.points),
    reason:(a.kind==='milestone'?'Подарунок за покупки: ':'Бонуси за замовлення: ')+a.order_number+(a.reversed_at?' (скасовано)':''),
    createdAt:a.available_at,
    expiresAt:a.expires_at,
    status:a.reversed_at?'reversed':Date.parse(a.expires_at+'Z')<=now?'expired':'earned'
  }));
  for(const x of legacyHistory.results||[])history.push({delta:Number(x.points_delta),reason:String(x.reason||'').slice(0,160),createdAt:x.created_at,status:'legacy'});
  const tier=coinsTier(completedSpend);
  return {ok:true,points:Math.max(0,Number(available?.coins||0)-Number(spent?.coins||0)+Number(legacy?.points||0)),
    pending,transactions:history.slice(0,20),enabled:true,redemptionEnabled:true,
    tier:tier.name,percent:tier.percent,completedSpend,nextTierAt:tier.nextAt,
    rules:COINS_RULES,milestoneRewardsConfigured:gifts.configured,
    currency:'bonus_points',message:'Тестова програма Tanuki Coins у Preview. Списання доступне лише в тестовому магазині.'};
}

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Exercise the real cart-reconciliation functions extracted from the storefront script.
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function section(start,end){
 const a=html.indexOf(start),b=html.indexOf(end,a);
 assert.ok(a!==-1&&b>a,'Missing storefront section: '+start);
 return html.slice(a,b);
}
const limitFn=section('function allowedQuantity(source) {','function saveCart() {');
const restoreFn=section('function loadCart() {','/* ГАЛЕРЕЯ */');
const execute=new Function('products','saved',`
 const MAX_QUANTITY=99,CART_KEY='tanukiShopCart';
 let cart=[];
 const productCatalog=Object.fromEntries(products.map(p=>[p.id,{id:p.id,name:p.name,price:p.current_price,icon:'🛍️'}]));
 const notice={hidden:true,textContent:''};
 const localStorage={getItem:()=>JSON.stringify(saved)};
 const $=id=>{if(id!=='cartStockNotice')throw new Error('Unexpected DOM id: '+id);return notice;};
 ${limitFn}
 ${restoreFn}
 loadCart();
 return {cart,notice};
`);
const products=[
 {id:'sold-out',name:'Sold out',current_price:50,available:false,track_stock:true,stock:0},
 {id:'limited',name:'Limited',current_price:100,available:true,track_stock:true,stock:3},
 {id:'untracked',name:'Untracked',current_price:25,available:true,track_stock:false,stock:0},
];
const stale=execute(products,[
 {id:'sold-out',quantity:2},
 {id:'limited',quantity:5,price:1},
 {id:'untracked',quantity:2},
 {id:'missing',quantity:2}
]);
assert.deepEqual(stale.cart.map(x=>[x.id,x.quantity,x.price]),[['limited',3,100],['untracked',2,25]]);
assert.equal(stale.notice.hidden,false);
assert.match(stale.notice.textContent,/недоступні товари/);

const valid=execute(products,[{id:'limited',quantity:1}]);
assert.deepEqual(valid.cart.map(x=>[x.id,x.quantity]),[['limited',1]]);
assert.equal(valid.notice.hidden,true);
const duplicates=execute(products,[{id:'limited',quantity:2},{id:'limited',quantity:3}]);
assert.deepEqual(duplicates.cart.map(x=>[x.id,x.quantity]),[['limited',3]]);
const invalid=execute(products,[{id:'limited',quantity:-1},{id:'untracked',quantity:500},{quantity:1}]);
assert.deepEqual(invalid.cart.map(x=>[x.id,x.quantity]),[['untracked',99]]);
assert.equal(invalid.notice.hidden,false);

assert.match(html,/plus\.disabled = item\.quantity >= allowedQuantity/);
assert.match(html,/amount > 0 && item\.quantity >= allowedQuantity/);
assert.match(html,/\$\("promoCode"\)\.value = "";\s*clearPromo\(\);/);
console.log('PASS: storefront cart restoration, inventory limits, stale promo reset (9 checks)');

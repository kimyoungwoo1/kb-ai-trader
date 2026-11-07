export type AccountHolding={
 name:string;code:string;quantity:number;orderable:number;
 averagePrice?:number;currentPrice?:number;valuation?:number;
 profitLoss?:number;yieldRate?:number
}
export type AccountValuation={purchaseAmount:number;valuationAmount:number;profitLoss:number;yieldRate:number}
export type PilotOrderSummary={side:'BUY'|'SELL';reserved_won:number;state:string;filled_quantity?:number}
export function safeCash(value:unknown):number|null{
 if(typeof value!=='string'&&typeof value!=='number')return null
 const raw=String(value).trim().replace(/,/g,'')
 if(!/^[0-9]+$/.test(raw))return null
 const n=Number(raw)
 return Number.isSafeInteger(n)&&n>=0?n:null
}
export function domesticCode(value:string):string{
 const raw=value.trim().toUpperCase()
 return /^A[0-9]{6}$/.test(raw)?raw.slice(1):raw
}
export function findAccountHolding(holdings:AccountHolding[],code:string):AccountHolding|null{
 const target=domesticCode(code)
 return holdings.find(row=>domesticCode(row.code)===target)||null
}
/** D1 real BUY journal is shown as reserved risk, not claimed broker cash. */
export function reservedPilotAmount(orders:PilotOrderSummary[]|undefined):number|null{
 if(!orders)return null
 let sum=0
 for(const order of orders){
  if(order.side!=='BUY'||order.state==='REJECTED')continue
  // A partially filled then canceled BUY still owns real shares. Keep the
  // original reservation as a conservative upper bound for capital exposure.
  if(order.state==='CANCELED'&&order.filled_quantity===0)continue
  if(!Number.isSafeInteger(order.reserved_won)||order.reserved_won<0)return null
  sum+=order.reserved_won
 }
 return Number.isSafeInteger(sum)?sum:null
}

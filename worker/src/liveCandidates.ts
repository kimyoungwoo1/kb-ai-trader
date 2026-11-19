import type {TradeSignal} from '../../src/tradeSignals'
import type {LiveFill} from './liveExecution'
import {LIVE_BUY_LIMIT_WON,liveBuyRequiredCash,liveOrderTick} from '../../src/livePilotLimits'
import {kstTradingDay} from '../../src/marketSession'
export type Quote = {code:string;price:number|null;checked_at:string;error?:string}
export type Pending = {code:string;name:string;trigger:number;scanAt:string}

export function liveCandidates(signals:TradeSignal[],scanAt:string):Pending[]{
 return signals.filter(signal=>signal.status==='관찰 후보' &&
  Number.isSafeInteger(signal.entryTrigger) && signal.entryTrigger!>0 &&
  liveBuyRequiredCash(signal.entryTrigger!)<=LIVE_BUY_LIMIT_WON)
  .slice(0,5).map(signal=>({code:signal.code,name:signal.name,trigger:signal.entryTrigger!,scanAt}))
}

export function liveEntry(pending:Pending,quote:Quote,now:Date):LiveFill|null{
 const checked=Date.parse(quote.checked_at)
 const created=Date.parse(pending.scanAt)
 if(quote.code!==pending.code||quote.error||!Number.isFinite(created)||!Number.isFinite(checked)||
  checked<=created||checked>now.getTime()||now.getTime()-checked>30_000||
  now.getTime()-created>180_000||kstTradingDay(new Date(created))!==kstTradingDay(now)||
  !Number.isSafeInteger(quote.price)||quote.price!<pending.trigger||quote.price!>pending.trigger*1.02)return null
 const price=Math.floor(quote.price!/liveOrderTick(quote.price!))*liveOrderTick(quote.price!)
 if(price<pending.trigger||liveBuyRequiredCash(price)>LIVE_BUY_LIMIT_WON)return null
 return {id:'live-entry-'+pending.code+'-'+created,code:pending.code,side:'BUY',
  price,quantity:1,at:quote.checked_at}
}


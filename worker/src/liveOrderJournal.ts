/**
 * Real order safety journal — preparation only.
 * State validation only: no broker HTTP requests belong in this module. An acknowledged order,
 * rejected order, or uncertain transport failure must NEVER be assumed
 * filled. UNKNOWN requires broker-side reconciliation before another attempt.
 */
export const ORDER_STATES=[
 'RESERVED','SENDING','UNKNOWN','ACCEPTED','PARTIAL','FILLED','REJECTED','CANCEL_REQUESTED','CANCELED',
] as const
export type OrderState=typeof ORDER_STATES[number]
export type OrderIntent={
 id:string;tradingDay:string;code:string;side:'BUY'|'SELL';
 quantity:number;limitPrice:number;reservedWon:number
}
export type OrderRecord=OrderIntent&{
 state:OrderState;brokerOrderId:string|null;filledQuantity:number;updatedAt:string
}
const edges:Readonly<Record<OrderState,readonly OrderState[]>>={
 RESERVED:['SENDING','REJECTED'],
 SENDING:['UNKNOWN','ACCEPTED','REJECTED'],
 UNKNOWN:['ACCEPTED','PARTIAL','FILLED','REJECTED','CANCELED'],
 ACCEPTED:['PARTIAL','FILLED','CANCEL_REQUESTED','CANCELED','UNKNOWN'],
 PARTIAL:['PARTIAL','FILLED','CANCEL_REQUESTED','CANCELED','UNKNOWN'],
 FILLED:[], REJECTED:[],
 CANCEL_REQUESTED:['CANCEL_REQUESTED','FILLED','CANCELED','UNKNOWN'],
 CANCELED:[],
}
const fixedDay=(s:string)=>/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(s)
export function validateOrderIntent(intent:OrderIntent):string|null{
 if(!/^[0-9]{6}$/.test(intent?.code||''))return '종목코드 오류'
 if(!/^[A-Za-z0-9_:-]{1,120}$/.test(intent?.id||''))return '주문 의도 ID 오류'
 if(!fixedDay(intent?.tradingDay||''))return '거래일 오류'
 if(intent.side!=='BUY'&&intent.side!=='SELL')return '매매 구분 오류'
 if(!Number.isSafeInteger(intent.quantity)||intent.quantity<=0)return '주문 수량 오류'
 if(!Number.isSafeInteger(intent.limitPrice)||intent.limitPrice<=0)return '주문 지정가 오류'
 if(!Number.isSafeInteger(intent.reservedWon)||intent.reservedWon<0)return '예약 금액 오류'
 if(intent.side==='BUY'&&(intent.quantity*intent.limitPrice>50_000||
     intent.reservedWon!==intent.quantity*intent.limitPrice))return '5만 원 매수 한도/예약 금액 오류'
 return null
}
export function transitionOrder(row:OrderRecord,next:OrderState,filledQuantity=row.filledQuantity,
 brokerOrderId=row.brokerOrderId,at=new Date()):OrderRecord{
 if(!ORDER_STATES.includes(next)||!edges[row.state]?.includes(next))
   throw Error('허용되지 않은 주문 상태 전환: '+row.state+' → '+next)
 if(!Number.isSafeInteger(filledQuantity)||filledQuantity<row.filledQuantity||filledQuantity>row.quantity)
   throw Error('체결수량 오류 또는 체결수량 역행')
 if(next==='FILLED'&&filledQuantity!==row.quantity)throw Error('전체 체결 수량 검증 실패')
 if(next==='PARTIAL'&&(filledQuantity<=0||filledQuantity>=row.quantity))
   throw Error('부분 체결 수량 검증 실패')
 if((next==='ACCEPTED'||next==='PARTIAL'||next==='FILLED')&&!brokerOrderId)
   throw Error('증권사 주문번호 없는 체결/접수 상태 금지')
 if(row.brokerOrderId&&brokerOrderId!==row.brokerOrderId)
   throw Error('증권사 주문번호 변경 불가')
 if(!Number.isFinite(at.getTime()))throw Error('유효하지 않은 처리 시간')
 return {...row,state:next,filledQuantity,brokerOrderId,updatedAt:at.toISOString()}
}
export function canSendBrokerOrder(row:OrderRecord):boolean{
 // Only a persisted RESERVED row may be submitted exactly once. Once SENDING
 // was persisted, timeouts become UNKNOWN and MUST NOT resend.
 return row.state==='RESERVED'&&validateOrderIntent(row)===null
}
export function mustReconcileBeforeNextOrder(row:OrderRecord):boolean{
 return ['SENDING','UNKNOWN','ACCEPTED','PARTIAL','CANCEL_REQUESTED'].includes(row.state)
}
export const LIVE_ORDER_API_CONTRACT={
 buy:{tr:'SSAM1802',method:'POST',path:'/api/v1/ssam1802'},
 sell:{tr:'SSAM1801',method:'POST',path:'/api/v1/ssam1801'},
 fills:{tr:'SSQM2341',method:'POST',path:'/api/v1/ssqm2341'},
 // These paths identify candidate KB operations only. Never send an order
 // without validating the provider's full field-level contract and responses.
 verified:false,
} as const

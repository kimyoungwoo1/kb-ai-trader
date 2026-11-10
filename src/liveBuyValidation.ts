import {LIVE_BUY_LIMIT_WON,isLiveOrderTick,liveBuyRequiredCash,liveOrderTick} from './livePilotLimits'
/** Only validates a form preview; never submits a brokerage order. */
export function validateLiveBuyInput(code:string,quantity:string,price:string):string|null{
  if(!/^[0-9]{6}$/.test(code))return '종목코드는 숫자 6자리로 입력해 주세요.'
  if(!/^[1-9][0-9]*$/.test(quantity)||!Number.isSafeInteger(Number(quantity)))
    return '수량은 1 이상의 정수로 입력해 주세요.'
  if(!/^[1-9][0-9]*$/.test(price)||!Number.isSafeInteger(Number(price)))
    return '지정가는 1원 이상의 정수로 입력해 주세요.'
  if(quantity!=='1')return '매수 수량은 1주로 제한됩니다.'
  if(liveBuyRequiredCash(Number(price))>LIVE_BUY_LIMIT_WON)
    return '수수료 여유금 포함 50,000원 한도를 초과합니다. 지정가를 낮춰 주세요.'
  if(!isLiveOrderTick(Number(price)))return `지정가는 ${liveOrderTick(Number(price))}원 호가 단위에 맞춰 주세요.`
  return null
}

/** User-facing paper fill notifications. Never confuse this with a real order. */
import type { AutoFill } from '../../src/autoPaper';
const won=(n:number)=>Math.round(n).toLocaleString('ko-KR')+'원';
export function formatPaperFillNotification(fill:AutoFill):{title:string;body:string}{
  const buy=fill.side==='BUY';
  const total=fill.quantity*fill.price;
  const reason=typeof fill.reason==='string'&&fill.reason.trim()?fill.reason.trim():'전략 조건 충족';
  const at=Number.isFinite(Date.parse(fill.at))?new Date(fill.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'체결시각 정보 없음';
  const pnl=fill.pnl===null||!Number.isFinite(fill.pnl)?'':(
    '\n실현손익: '+(fill.pnl>=0?'+':'')+won(fill.pnl));
  const body=[
    '종목: '+fill.name+' ('+fill.code+')',
    '수량: '+fill.quantity.toLocaleString('ko-KR')+'주',
    '가상 체결가: '+won(fill.price),
    '체결금액: '+won(total),
    '가상 비용: '+won(fill.costs),
    ...(pnl?[pnl.trim()]:[]),
    '매매 사유: '+reason.slice(0,190),
    '시각: '+at,
    '※ 가상매매 · 실제 증권 주문 아님'
  ].join('\n');
  return {title:'KB AI TRADER · 가상'+(buy?'매수':'매도')+' 체결',body};
}

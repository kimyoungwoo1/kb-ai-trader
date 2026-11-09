import {RefreshCw,Wallet,ShieldCheck} from 'lucide-react'
import {domesticCode,reservedPilotAmount,safeCash,type AccountHolding,type AccountValuation,type PilotOrderSummary} from './liveAccountView'
type Props={
 holdings:AccountHolding[];
 summary:AccountValuation|null;
 deposit:Record<string,unknown>|null;
 depositMessage:string;
 accountMessage:string;
 accountLoading:boolean;
 onRefreshAccount:()=>void|Promise<void>;
 pilotOrders:PilotOrderSummary[]|undefined
}
const fmt=(amount:number|null|undefined):string=>
 typeof amount==='number'&&Number.isFinite(amount)?amount.toLocaleString('ko-KR')+'원':'조회되지 않음'
const signed=(amount:number|null|undefined):string=>
 typeof amount==='number'&&Number.isFinite(amount)?(amount>0?'+':'')+amount.toLocaleString('ko-KR')+'원':'조회되지 않음'
export default function LiveAccountHoldings({
 holdings,summary,deposit,depositMessage,accountMessage,accountLoading,onRefreshAccount,pilotOrders
}:Props){
 const cash=deposit?safeCash(deposit.ordr_psbl_csh):null
 const reserved=reservedPilotAmount(pilotOrders)
 const haveAccountData=Boolean(summary||deposit||holdings.length)
 const trialLeft=reserved===null?null:Math.max(0,10_000-reserved)
 return <div className="panel live-balance-panel">
  <div className="panel-heading">
   <div><h3>내 실계좌 자산 · 보유종목</h3>
    <span>KB증권 조회 데이터 · 계좌 현황과 공유 · 실주문 미전송</span></div>
   <button type="button" className="outline-button" disabled={accountLoading}
    onClick={()=>void onRefreshAccount()}>
    <RefreshCw size={14}/>{accountLoading?'계좌 조회 중...':'실계좌 새로고침'}
   </button>
  </div>
  <div className="live-balance-grid">
   <div className="live-balance-item"><small>주식 평가금액</small><strong>{fmt(summary?.valuationAmount)}</strong></div>
   <div className="live-balance-item"><small>주식 매입금액</small><strong>{fmt(summary?.purchaseAmount)}</strong></div>
   <div className="live-balance-item"><small>평가손익</small><strong className={summary?.profitLoss===undefined?'':'balance-'+(summary.profitLoss>=0?'gain':'loss')}>{signed(summary?.profitLoss)}</strong></div>
   <div className="live-balance-item"><small><Wallet size={13}/> 주문 가능 현금</small><strong>{fmt(cash)}</strong></div>
  </div>
  <div className="live-pilot-budget">
   <ShieldCheck size={17}/>
   <span>실계좌 시험매매 한도 <strong>10,000원</strong></span>
   <span>실주문 원장 예약금 <strong>{fmt(reserved)}</strong></span>
   <span>한도 잔여(예약금 기준) <strong>{fmt(trialLeft)}</strong></span>
  </div>
  <p className="notification-hint">주문 가능 현금은 실제 계좌 잔고이고, 1만 원은 자동 시험매매에서 별도로 적용하는 상한이야. 시험 예약금은 증권사 체결금액이나 실제 인출액을 뜻하지 않아.</p>
  {!haveAccountData&&<p role="status" className="live-trial-inline-error">아직 이 화면에 계좌 데이터가 없어. ‘실계좌 새로고침’을 눌러 보유종목과 현금을 조회해 줘. 조회되지 않은 값을 0원으로 표시하지 않아.</p>}
  {accountMessage.includes('실패')&&<p className="live-trial-inline-error" role="status">일부 계좌 데이터 확인 필요 · {accountMessage.slice(0,200)}</p>}
  {deposit===null&&haveAccountData&&<p className="notification-hint">주문 가능 현금: {depositMessage}</p>}
  <div className="panel-heading" style={{marginTop:18}}><div><h3>보유종목별 수량 · 평가금액</h3><span>기존 실계좌 보유종목 · 가상매매와 구분</span></div>
   <span>{holdings.length>0?holdings.length+'개 종목':'목록 확인 필요'}</span>
  </div>
  {holdings.length?<div className="table-wrap"><table className="live-balance-table">
   <thead><tr><th>종목</th><th>보유 수량</th><th>주문 가능 수량</th><th>평균 매입가</th><th>현재가</th><th>평가금액</th><th>평가손익</th></tr></thead>
   <tbody>{holdings.map((item,i)=><tr key={domesticCode(item.code)+'-'+i}>
    <td><strong>{item.name}</strong><span className="live-holding-code">{item.code}</span></td>
    <td>{Number.isFinite(item.quantity)?item.quantity.toLocaleString('ko-KR')+'주':'조회되지 않음'}</td>
    <td>{Number.isFinite(item.orderable)?item.orderable.toLocaleString('ko-KR')+'주':'조회되지 않음'}</td>
    <td>{fmt(item.averagePrice)}</td><td>{fmt(item.currentPrice)}</td>
    <td>{fmt(item.valuation)}</td>
    <td className={typeof item.profitLoss==='number'?'balance-'+(item.profitLoss>=0?'gain':'loss'):''}>{signed(item.profitLoss)}</td>
   </tr>)}</tbody>
  </table></div>:<p className="notification-hint">표시할 보유종목이 없어. 보유하지 않았다는 확정 정보는 아니며, 계좌 새로고침 후 확인해 줘.</p>}
 </div>
}

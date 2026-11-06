# KB증권 국내주식 V2 주문 명세 검증

출처: 사용자가 제공한 `all_kbstock_sample_V2.zip` (2026-11-06).
관련 공식 안내: https://openapi.kbsec.com/apidoc_b2c

> **실제 주문 기능은 잠금 상태**입니다. 이 문서는 요청·응답 필드가 샘플과 맞는지 확인한 기록이며, 시장 실환경 주문 성공을 의미하지 않습니다.

| 용도 | TR | 엔드포인트 |
| --- | --- | --- |
| 국내 현금 매수 | SSAM1802 | `POST /api/v1/ssam1802` |
| 국내 현금 매도 | SSAM1801 | `POST /api/v1/ssam1801` |
| 정정 | SSAM1805 | `POST /api/v1/ssam1805` |
| 취소 | SSAM1806 | `POST /api/v1/ssam1806` |
| 체결·미체결 조회 | SSQM2341 | `POST /api/v1/ssqm2341` |
| 현금 매수 가능 | SSQM1802 | `POST /api/v1/ssqm1802` |
| 예수금 내역 | SSQM0004 | `POST /api/v1/ssqm0004` |

## 입력 필드

주문(SSAM1801/1802): `ordr_uprc`(지정가), `ordr_ccd='00'`,
`mkt_tm_clsf='1'`, `is_cd`(6자리 종목코드), `ordr_q`(수량),
`sor_ordr_ccd='S'`. 공통 `dataHeader`에 `ipAddr`, `macAddr` 필요.

주문 접수 응답: `dataHeader.resultCode='200'`, `processFlag='A'`,
매수 `processCode='0005'` / 매도 `processCode='0004'`,
`dataBody.ordr_no` 주문번호. 이 응답은 **주문 접수**이지 체결 확정이 아님.

주문 취소(SSAM1806): `crct_clsf='2'`, `is_cd`, `ordr_q=''`,
`orgn_ordr_no`(원주문번호). 취소 접수 응답 `processCode='0014'`.
취소 접수도 최종 잔량 정리를 증명하지 않으므로 체결 조회가 필수.

체결·미체결(SSQM2341): `ccls_clsf='0'`, `nxt_key`, `ordr_dt='YYYYMMDD'`.
`dataBody.Record1[]`의 `ordr_no`, `stnd_is_no`(접두어 A 포함 가능),
`trd_dl_ccd_nm`, `ordr_q`, `tl_ccls_q`(체결수량),
`nccls_q`(미체결수량), `ordr_uprc`(주문 지정가)를 사용.
`dataBody.nxt_key`가 남아 있으면 후속 페이지 필요.

## 운영 적용 전 남은 검증

1. 주문·체결 결과의 모든 성공/거절·취소·부분체결 예시와 장중 실환경 응답 대조
2. 주문 중복 방지용 D1 원장의 전송 직전 원자적 잠금 및 장애 시 체결 조회 복구
3. 실제 사용 가능 현금·보유 수량·종목 제한·호가 단위 검증
4. 주식 주문·취소에 대한 별도 서버 활성화 스위치와 최대 5만 원 제약
5. 최초 실거래는 사용자가 직접 설정한 금액 한도 내에서 주문·취소·체결 추적이 정상인지 확인

현재 `worker/src/kbOrderContract.ts`는 **주문 요청 생성기 + 응답 검증기 + 읽기 전용 체결조회**만 제공하고, 매수·매도·취소를 전송하지 않음.

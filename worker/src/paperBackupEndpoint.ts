import { handlePaperBackup } from './paperBackup'

/** Isolated so the trading Worker never includes any backup code in order routes. */
export async function paperBackupRoute(request: Request, database?: any): Promise<Response> {
  if (!database) return Response.json({ success: false, configured: false,
    message: 'D1 데이터베이스가 아직 연결되지 않았습니다.' }, { status: 503 })
  let body: unknown
  try { body = await request.json() }
  catch { return Response.json({ success: false, message: '백업 요청 형식 오류' }, { status: 400 }) }
  return handlePaperBackup(body, database)
}

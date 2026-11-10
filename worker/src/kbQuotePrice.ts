// Preserve the order of KB response aliases. Callers apply their own validation.
export function kbQuotePrice(body: Record<string, unknown> | null | undefined): unknown {
  return body?.now_prc ?? body?.stck_prpr ?? body?.cur_prc ?? body?.current_price ??
    body?.price ?? body?.last_price ?? body?.prpr
}

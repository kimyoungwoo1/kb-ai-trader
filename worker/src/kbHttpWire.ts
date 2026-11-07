/**
 * Strict byte-level HTTP/1.1 response parser for a future read-only KB TLS
 * client. Never log or surface raw brokerage payloads in exceptions.
 *
 * Returns null if additional bytes are needed, except EOF-terminated bodies.
 */
const decoder=new TextDecoder('utf-8',{fatal:true})
const latin=new TextDecoder('iso-8859-1')
const enc=new TextEncoder()
const eq=(bytes:Uint8Array,start:number,pattern:Uint8Array)=>{
 for(let i=0;i<pattern.length;i++)if(bytes[start+i]!==pattern[i])return false
 return true
}
const find=(bytes:Uint8Array,pattern:Uint8Array,start=0)=>{
 for(let i=start;i<=bytes.length-pattern.length;i++)if(eq(bytes,i,pattern))return i
 return -1
}
const sep=enc.encode('\r\n\r\n')
const crlf=enc.encode('\r\n')
export type WireResponse={status:number;headers:Record<string,string>;body:Uint8Array}
const limit=1024*1024 // 1 MiB maximum total HTTP response for each read-only call.
export function decodeKbHttpResponse(bytes:Uint8Array,eof=false):WireResponse|null{
 if(bytes.length>limit)throw Error('KB_WIRE_LIMIT')
 const mark=find(bytes,sep)
 if(mark<0){
  if(bytes.length>16384||eof)throw Error('KB_WIRE_HEADERS_INVALID')
  return null
 }
 if(mark>16384)throw Error('KB_WIRE_HEADERS_LIMIT')
 const head=latin.decode(bytes.subarray(0,mark)).split('\r\n')
 const status=/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/.exec(head.shift()||'')
 if(!status)throw Error('KB_WIRE_STATUS_INVALID')
 const headers:Record<string,string>={}
 for(const line of head){
  const at=line.indexOf(':')
  if(at<=0)throw Error('KB_WIRE_HEADERS_INVALID')
  const name=line.slice(0,at).toLowerCase()
  const value=line.slice(at+1).trim()
  if(!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name))throw Error('KB_WIRE_HEADERS_INVALID')
  if(name==='content-length'&&headers[name]!==undefined&&headers[name]!==value)
   throw Error('KB_WIRE_LENGTH_CONFLICT')
  if(name==='transfer-encoding'&&headers[name]!==undefined&&headers[name]!==value)
   throw Error('KB_WIRE_TRANSFER_CONFLICT')
  headers[name]=value
 }
 const bodyStart=mark+4
 const httpStatus=Number(status[1])
 // No-body statuses are not JSON; fail closed for the future client.
 if(httpStatus===204||httpStatus===304||httpStatus===205)
  return {status:httpStatus,headers,body:new Uint8Array(0)}
 const transfer=(headers['transfer-encoding']||'').toLowerCase()
 if(transfer){
  if(transfer!=='chunked'||headers['content-length'])
   throw Error('KB_WIRE_ENCODING_UNSUPPORTED')
  let position=bodyStart
  const parts:Uint8Array[]=[]
  let size=0
  for(;;){
   const lineEnd=find(bytes,crlf,position)
   if(lineEnd<0){
    if(eof)throw Error('KB_WIRE_TRUNCATED')
    return null
   }
   if(lineEnd-position>128)throw Error('KB_WIRE_CHUNK_INVALID')
   const sizeLine=latin.decode(bytes.subarray(position,lineEnd)).split(';')[0].trim()
   if(!/^[a-fA-F0-9]{1,8}$/.test(sizeLine))throw Error('KB_WIRE_CHUNK_INVALID')
   const count=parseInt(sizeLine,16)
   position=lineEnd+2
   if(size+count>limit)throw Error('KB_WIRE_LIMIT')
   if(count===0){
    if(bytes.length<position+2){
     if(eof)throw Error('KB_WIRE_TRUNCATED')
     return null
    }
    // Empty trailer = CRLF; bounded non-empty trailers must end CRLFCRLF.
    const end=eq(bytes,position,crlf)?position+2:find(bytes,sep,position)
    if(end<0){
     if(eof)throw Error('KB_WIRE_TRUNCATED')
     return null
    }
    const joined=new Uint8Array(size)
    let dst=0
    for(const part of parts){joined.set(part,dst);dst+=part.length}
    return {status:httpStatus,headers,body:joined}
   }
   if(bytes.length<position+count+2){
    if(eof)throw Error('KB_WIRE_TRUNCATED')
    return null
   }
   if(!eq(bytes,position+count,crlf))throw Error('KB_WIRE_CHUNK_INVALID')
   parts.push(bytes.subarray(position,position+count))
   size+=count
   position+=count+2
  }
 }
 const contentLength=headers['content-length']
 if(contentLength!==undefined){
  if(!/^[0-9]{1,9}$/.test(contentLength))throw Error('KB_WIRE_LENGTH_INVALID')
  const length=Number(contentLength)
  if(length>limit)throw Error('KB_WIRE_LIMIT')
  if(bytes.length<bodyStart+length){
   if(eof)throw Error('KB_WIRE_TRUNCATED')
   return null
  }
  return {status:httpStatus,headers,body:bytes.slice(bodyStart,bodyStart+length)}
 }
 if(!eof)return null
 return {status:httpStatus,headers,body:bytes.slice(bodyStart)}
}
export function decodeKbJson(bytes:Uint8Array):unknown{
 try{return JSON.parse(decoder.decode(bytes))}
 catch{throw Error('KB_WIRE_JSON_INVALID')}
}

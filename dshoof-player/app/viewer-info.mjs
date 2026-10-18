import {isIP} from 'node:net';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function address(value){
 const text=String(value||'').trim().replace(/^::ffff:/,'');
 return isIP(text)?text:null;
}

// Forwarded headers are trusted only after the hosting proxy chain has been
// inspected and an explicit hop count configured. Client JSON never supplies IP.
export function viewerInfo(req,input,{trustProxyHops=Number(process.env.TRUST_PROXY_HOPS||0)}={}){
 let ip=address(req.socket?.remoteAddress),ipSource='socket';
 if(Number.isInteger(trustProxyHops)&&trustProxyHops>0&&trustProxyHops<=5){
  const forwarded=String(req.headers['x-forwarded-for']||'');
  const chain=forwarded.length<=1024?forwarded.split(',').map(address):[];
  chain.push(ip);
  if(chain.length>trustProxyHops&&chain.every(Boolean)){
   ip=chain[chain.length-1-trustProxyHops];ipSource='trusted-proxy';
  }
 }
 if(!plain(input)||input.shared!==true)return {ip,ipSource,clientInfo:{shared:false}};
 const ua=String(req.headers['user-agent']||'').slice(0,512);
 const browser=/Edg\//.test(ua)?'Microsoft Edge':/Firefox\//.test(ua)?'Firefox':/SamsungBrowser\//.test(ua)?'Samsung Internet':/Chrome\/|CriOS\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'غير معروف';
 const os=/Android/.test(ua)?'Android':/iPhone|iPad|iPod/.test(ua)?'iOS / iPadOS':/Windows/.test(ua)?'Windows':/Mac OS X/.test(ua)?'macOS':/Linux/.test(ua)?'Linux':'غير معروف';
 const device=/iPad|Tablet/.test(ua)?'جهاز لوحي':/Mobile|iPhone|Android/.test(ua)?'هاتف':'حاسوب / جهاز غير محدد';
 const location=plain(input.location)&&Number.isFinite(input.location.latitude)&&Number.isFinite(input.location.longitude)?{
  latitude:Math.round(input.location.latitude*1000)/1000,
  longitude:Math.round(input.location.longitude*1000)/1000,
  accuracy:input.location.accuracy
 }:undefined;
 return {ip,ipSource,clientInfo:{shared:true,device,browser,os,screen:input.screen,battery:input.battery,network:input.network,timezone:input.timezone,locale:input.locale,subscription:input.subscription,location}};
}

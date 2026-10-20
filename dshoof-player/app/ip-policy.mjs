import {isIP} from 'node:net';
import {viewerInfo} from './viewer-info.mjs';
export function canonicalIP(value){
 let ip=String(value||'').trim().toLowerCase().replace(/^::ffff:/,'');
 if(isIP(ip)===6){try{ip=new URL('http://['+ip+']/').hostname.slice(1,-1);}catch{return null;}}
 return isIP(ip)?ip:null;
}
export function publicClientIP(req){
 const info=viewerInfo(req,null),ip=canonicalIP(info.ip);if(!ip)return null;
 // A forwarding header alone never authorizes banning the proxy address.
 if(req.headers?.['x-forwarded-for']&&info.ipSource!=='trusted-proxy')return null;
 if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127)return null;}
 else if(ip==='::'||ip==='::1'||/^(?:fc|fd|fe[89ab]|ff)/i.test(ip))return null;
 return {ip,ipSource:info.ipSource,at:Date.now()};
}

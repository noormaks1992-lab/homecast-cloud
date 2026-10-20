import {test} from 'node:test';
import assert from 'node:assert/strict';
import {viewerInfo} from './viewer-info.mjs';

const request={socket:{remoteAddress:'::ffff:192.0.2.1'},headers:{'user-agent':'Mozilla Android Mobile Chrome/130.0','x-forwarded-for':'203.0.113.8'}};
test('viewer operational IP ignores spoofed headers and JSON until a trusted proxy is configured',()=>{
 assert.equal(viewerInfo(request,{shared:true,ip:'1.1.1.1'}).ip,'192.0.2.1');
 assert.equal(viewerInfo(request,{}, {trustProxyHops:1}).ip,'203.0.113.8');
 assert.equal(viewerInfo({...request,headers:{'x-forwarded-for':'garbage'}},{},{trustProxyHops:1}).ipSource,'socket');
});
test('device metadata requires sharing; location is rounded and arbitrary client fields are excluded',()=>{
 const input={shared:true,device:'OWNER',browser:'forged',ip:'1.1.1.1',location:{latitude:33.123456,longitude:44.765432,accuracy:25},network:{downlink:3}};
 const info=viewerInfo(request,input);assert.equal(info.clientInfo.browser,'Chrome');assert.equal(info.clientInfo.device,'هاتف');
 assert.equal(info.clientInfo.location.latitude,33.123);assert.equal(info.clientInfo.location.longitude,44.765);
 assert.equal(info.clientInfo.ip,undefined);assert.equal(info.clientInfo.userAgent,undefined);
 assert.deepEqual(viewerInfo(request,{...input,shared:false}).clientInfo,{shared:false});
});

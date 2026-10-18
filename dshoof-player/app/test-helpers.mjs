import assert from 'node:assert/strict';
export async function ownerLogin(origin,key){
 const response=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({key})});
 assert.equal(response.status,200,'owner fixture login failed');
 const cookie=response.headers.get('set-cookie')?.split(';')[0];
 assert.ok(cookie?.startsWith('dshoof_owner='));
 return cookie;
}

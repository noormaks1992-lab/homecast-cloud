'use strict';
// A loopback-only transport for HTTPS media files. Node validates TLS normally.
// Upstream authorization failures are preserved, not bypassed.
const http=require('http'),crypto=require('crypto'),{Readable}=require('stream');
module.exports=function(port){
  const links=new Map();
  const server=http.createServer(async(req,res)=>{
    const entry=links.get(req.url.split('?')[0].slice(1));
    if(!entry||!['GET','HEAD'].includes(req.method)){res.writeHead(404);return res.end();}
    const abort=new AbortController();res.on('close',()=>abort.abort());
    try{
      const headers={...entry.headers,'Accept-Encoding':'identity'};if(req.headers.range)headers.Range=req.headers.range;
      const upstream=await fetch(entry.url,{method:req.method,headers,signal:abort.signal});
      const responseHeaders={'Cache-Control':'no-store'};
      for(const name of ['content-type','content-range','accept-ranges'])if(upstream.headers.has(name))responseHeaders[name]=upstream.headers.get(name);
      if(upstream.headers.has('content-length')&&!upstream.headers.has('content-encoding'))responseHeaders['content-length']=upstream.headers.get('content-length');
      res.writeHead(upstream.status,responseHeaders);
      if(req.method==='HEAD'||!upstream.body)return res.end();
      const body=Readable.fromWeb(upstream.body);body.on('error',()=>res.destroy());body.pipe(res);
    }catch{if(!res.headersSent)res.writeHead(502);res.end();}
  });
  server.requestTimeout=0;
  server.listen(port,'127.0.0.1');
  return {
    map(url,headers){
      if(!/^https:\/\//i.test(url))return url;
      const path=new URL(url).pathname;
      if(!/\.(mp4|m4v|mov|webm|mkv|ts)$/i.test(path))return url;
      const key=crypto.randomBytes(24).toString('hex');links.set(key,{url,headers:headers||{}});
      while(links.size>32)links.delete(links.keys().next().value);
      return `http://127.0.0.1:${port}/${key}`;
    },
    close(){server.close();server.closeAllConnections();},
    onError(callback){server.on('error',callback);}
  };
};

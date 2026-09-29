'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createGateway} = require('./gateway');

const base = process.env.PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL;
if (!base) throw Error('Set PUBLIC_BASE to the HTTPS origin of this server.');
const origin = new URL(base);
const localDev = process.env.HOMECAST_DEV === '1' && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname);
if (!localDev && origin.protocol !== 'https:') throw Error('The public server requires HTTPS.');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('PUBLIC_BASE must contain only an origin.');
const {token, streamKey} = require('./cloud-config').readSecrets(process.env);
process.env.HOMECAST_STREAM_KEY = streamKey;

const root = path.resolve(process.env.HOMECAST_ROOT || path.join(__dirname, '.data'));
fs.mkdirSync(root, {recursive: true});
const configFile = path.join(root, 'config.json');
const saved = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
const initialSource = process.env.HOMECAST_INITIAL_URL;
if (initialSource && !/^https?:\/\//i.test(initialSource)) throw Error('HOMECAST_INITIAL_URL must be an HTTP(S) URL.');
const config = {
  encoder: 'libx264', fpsMode: 'source', outputMode: 'single', singleQuality: '480',
  lastSource: initialSource ? {mode: 'url', value: initialSource} : {mode: 'test'},
  ...saved, publicBase: origin.origin, host: origin.hostname, backend: 'local'
};
const temporaryConfig = configFile + '.tmp';
fs.writeFileSync(temporaryConfig, JSON.stringify(config, null, 2), {mode: 0o600});
fs.renameSync(temporaryConfig, configFile);
Object.assign(process.env, {HOMECAST_REMOTE: '1', HOMECAST_ROOT: root, HOMECAST_BIND: '127.0.0.1'});
const adminPort = Number(process.env.HOMECAST_ADMIN_PORT) || 8878;
const mediaPort = Number(process.env.HOMECAST_MEDIA_PORT) || 8877;
const port = Number(process.env.PORT) || 8080;
if ([adminPort, mediaPort, adminPort + 100].includes(port)) throw Error('PORT conflicts with an internal service.');
require('./server');
const gateway = createGateway({origin: origin.origin, token, streamKey, adminPort, mediaPort, secure: !localDev});
gateway.listen(port, localDev ? '127.0.0.1' : '0.0.0.0', () => console.log(`HomeCast website ready on port ${port}`));
gateway.on('error', () => {console.error('HomeCast website could not start.'); process.kill(process.pid, 'SIGTERM');});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => gateway.close());

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/extractor \
    && /opt/extractor/bin/pip install --no-cache-dir yt-dlp
ENV PATH="/opt/extractor/bin:${PATH}" HOMECAST_REMOTE=1 HOMECAST_ROOT=/data PORT=8080 NODE_ENV=production
WORKDIR /app
COPY package.json cloud-config.js cloud-entry.js gateway.js server.js remote-client.js discover-media.js media-bridge.js cloud.html cloud.css cloud.js ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "cloud-entry.js"]

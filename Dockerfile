FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
ARG VCS_REF=development
LABEL org.opencontainers.image.source="https://github.com/SeKondBrainAILabs/conversation-roleplay" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${VCS_REF}" \
      ai.sekondbrain.roleplay.managed="true"
ENV NODE_ENV=production ROLEPLAY_HOST=0.0.0.0 ROLEPLAY_RUNS_DIR=/data/runs ROLEPLAY_REVISION=${VCS_REF}
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY src ./src
COPY web ./web
COPY examples ./examples
RUN mkdir -p /data/runs /config && chown -R node:node /data /config
USER node
EXPOSE 4318
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:4318/healthz');if(!r.ok)process.exit(1)"
CMD ["node", "src/cli.mjs", "serve"]

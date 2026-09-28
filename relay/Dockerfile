# walkie-relay (WALKIE-PWA-1): forwards end-to-end encrypted frames between a daemon and its phones.
# Build from the repository root: fly deploy --config relay/fly.toml --dockerfile relay/Dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY src/relay ./src/relay
COPY src/mobile/crypto.ts src/mobile/wire.ts ./src/mobile/
USER bun
ENV PORT=8080 RELAY_TRUST_FLY=1
EXPOSE 8080
CMD ["bun", "src/relay/server.ts"]

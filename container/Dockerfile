# weft merge-runner — real git for speculative merges, checks and the single trunk push.
# Build context is the repo root (wrangler.jsonc: image_build_context ".") so src/core is shared.
# trixie: git 2.47 (merge-tree --merge-base needs git >= 2.40; bookworm ships 2.39)
FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && git --version \
 && git --version | awk '{split($3,v,"."); if (v[1] < 2 || (v[1] == 2 && v[2] < 40)) exit 1}'
WORKDIR /srv/app
COPY src/core ./src/core
COPY container/server.ts ./container/server.ts
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "container/server.ts"]

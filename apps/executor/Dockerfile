FROM oven/bun:1.3.14-alpine AS bun
FROM alpine:3.23
# Alpine 3.23 官方包；固定沙箱版本，不使用 setuid 或 privileged 容器。
RUN apk add --no-cache bubblewrap=0.12.0-r0 git libstdc++ && adduser -D -u 1000 bun
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY apps/executor/package.json ./package.json
COPY apps/executor/tsconfig.json ./tsconfig.json
COPY apps/executor/src ./src
USER bun
EXPOSE 3010
CMD ["bun", "run", "start"]

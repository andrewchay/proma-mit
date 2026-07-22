FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY apps/executor/package.json ./package.json
COPY apps/executor/tsconfig.json ./tsconfig.json
COPY apps/executor/src ./src
USER bun
EXPOSE 3010
CMD ["bun", "run", "start"]

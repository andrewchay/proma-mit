FROM oven/bun:1.3.14
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --filter='@proma/server'
ENV PROMA_WEB_HOST=0.0.0.0
EXPOSE 3000
CMD ["bun", "run", "--filter=@proma/server", "start"]

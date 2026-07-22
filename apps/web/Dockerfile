FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --filter='@proma/web' && bun run --filter=@proma/web build
FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

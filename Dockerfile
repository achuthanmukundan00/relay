FROM node:25-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN addgroup -S relay && adduser -S relay -G relay

ENV HOST=0.0.0.0 \
    PORT=8080 \
    UPSTREAM_BASE_URL=http://host.docker.internal:1234

EXPOSE 8080

USER relay

CMD ["npm", "start"]

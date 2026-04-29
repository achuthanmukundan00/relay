FROM node:25-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN addgroup -S relay && adduser -S relay -G relay

ENV HOST=0.0.0.0 \
    PORT=1234 \
    UPSTREAM_BASE_URL=http://host.docker.internal:8080/v1 \
    MAX_REQUEST_BODY_BYTES=1048576

EXPOSE 1234

USER relay

CMD ["npm", "start"]

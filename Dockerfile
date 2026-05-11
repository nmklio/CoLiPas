FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG RELEASE_GIT_COMMIT=unknown
ARG RELEASE_ARTIFACT_ID=docker-runtime
ENV RELEASE_DEPLOYMENT_MODE=docker \
    RELEASE_GIT_COMMIT=$RELEASE_GIT_COMMIT \
    RELEASE_ARTIFACT_ID=$RELEASE_ARTIFACT_ID
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY --from=build /app/deploy/release-evidence-check.mjs ./deploy/release-evidence-check.mjs
EXPOSE 8080
CMD ["npm", "start"]

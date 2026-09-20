FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
USER node
ENTRYPOINT ["node", "main.js"]
CMD ["/app/config.yaml"]

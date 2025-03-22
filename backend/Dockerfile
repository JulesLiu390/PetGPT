FROM node:18

WORKDIR /app

COPY package.json ./

# Conditionally copy yarn.lock if it exists
COPY yarn.lock* ./

RUN if [ -f yarn.lock ]; then yarn install; else yarn install --pure-lockfile; fi

COPY . .

EXPOSE 3001

CMD ["yarn", "start"]
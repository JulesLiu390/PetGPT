FROM node:18

WORKDIR /app

COPY package.json ./

# Conditionally copy yarn.lock if it exists
COPY yarn.lock* ./

# Install dependencies
RUN if [ -f yarn.lock ]; then yarn install; else yarn install --pure-lockfile; fi

# Copy source files
COPY . .

# Create .env file from .env.example if .env doesn't exist
RUN if [ ! -f .env ]; then cp -n .env.example .env || echo "No .env.example found"; fi

# Expose API port
EXPOSE 3001

# Start the application
CMD ["yarn", "start"]

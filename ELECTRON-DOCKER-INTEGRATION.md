# Electron and Docker Integration

This document explains how the Electron app is integrated with Docker containerized services in the PetGPT application.

## Architecture Overview

The integration uses the following architecture:

- **Electron App**: Runs on the host machine and connects to containerized services
- **Containerized Services**: 
  - MongoDB: Database for storing application data
  - Backend: Express API service (port 3001)
  - Frontend: Web UI served by Nginx (port 5173 for Electron connection)

## Setup and Usage

### Prerequisites

- Docker and Docker Compose installed on your system
- Node.js and Yarn installed for Electron development

### Starting the Application

1. Start the containerized services and Electron app:

```bash
# Navigate to the electron directory
cd electron

# Start the containerized services and Electron
yarn dev
```

This command does the following:
- Starts all Docker containers (MongoDB, backend, frontend)
- Waits for the containerized frontend to be available on port 5173
- Launches the Electron app connected to the containers

### Development Workflow

During development, you can:

1. Use `yarn dev` in the electron directory to start everything at once
2. Make changes to the backend or frontend code and rebuild the containers as needed
3. Use `yarn dev:native` if you want to run the frontend outside Docker (directly with Vite)
4. Use `yarn stop:containers` to shut down all containers

## Container Configuration

The Docker setup in `docker-compose.yml` has been configured to:

1. Expose all necessary ports to the host machine
2. Set up a shared network for inter-container communication
3. Map the frontend container to port 5173 for Electron to connect to
4. Add service labels for easier identification

## Troubleshooting

### Container Connectivity Issues

If Electron can't connect to the containers:

1. Ensure Docker is running
2. Check container status with `docker-compose ps`
3. Verify that ports 3001 and 5173 are available on your host
4. Check container logs with `docker-compose logs`

### Electron Development

If you encounter issues with Electron:

1. Try running `yarn dev:native` to use the local frontend instead of containerized
2. Check that the required Node.js dependencies are installed
3. Verify that environment variables are correctly set in the Electron app

## Production Deployment

For production:

1. Build the Docker containers with `docker-compose build`
2. Build the Electron app with `yarn build` in the electron directory
3. Distribute the Electron app with instructions for users to start the containers

## Additional Notes

- The Electron app in development mode connects to the containerized frontend on port 5173
- The backend API health check endpoint at `/api/healthcheck` can be used to verify connectivity
- Container services use a Docker bridge network for communication

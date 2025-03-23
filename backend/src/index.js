import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import petRoutes from './routes/pets.js';
import conversationRoutes from './routes/conversations.js';
import aiRoutes from './routes/ai.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for image data
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint for container/electron integration
app.get('/api/healthcheck', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend service is running' });
});

// Routes
app.use('/api/pets', petRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/ai', aiRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    message: 'An unexpected error occurred',
    error: process.env.NODE_ENV === 'production' ? null : err.message
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

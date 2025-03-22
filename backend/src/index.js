import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import petRoutes from './routes/pets.js';
import conversationRoutes from './routes/conversations.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/pets', petRoutes);
app.use('/api/conversations', conversationRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

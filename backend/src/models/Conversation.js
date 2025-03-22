import mongoose from 'mongoose';

const historySchema = new mongoose.Schema({
  message: String,
  isUser: Boolean,
  timestamp: {
    type: Date,
    default: Date.now
  },
  LLM: String
});

const conversationSchema = new mongoose.Schema({
  petId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Pet',
    required: true
  },
  history: [historySchema]
});

export default mongoose.model('Conversation', conversationSchema);

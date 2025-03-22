import mongoose from 'mongoose';

const personalitySchema = new mongoose.Schema({
  description: String,
  mood: String
});

const petSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  img_LLM: String,
  voice_LLM: String,
  personality: personalitySchema
});

export default mongoose.model('Pet', petSchema);

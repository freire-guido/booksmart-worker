const express = require('express');

const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('booksmart-worker running');
});

// Gmail Pub/Sub webhook
app.post('/webhook/gmail', async (req, res) => {
  try {
    // Pub/Sub message is base64 encoded
    const message = req.body.message;
    if (!message) {
      console.log('No message in request');
      return res.status(400).send('No message');
    }

    const data = JSON.parse(
      Buffer.from(message.data, 'base64').toString()
    );

    console.log('Gmail notification:', JSON.stringify(data, null, 2));
    // data contains: { emailAddress, historyId }

    // TODO: 
    // 1. Look up user by emailAddress in Supabase
    // 2. Fetch new emails using Gmail API with historyId
    // 3. Extract booking info with OpenAI
    // 4. Upsert to bookings table

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});

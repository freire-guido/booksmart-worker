const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
    // data contains: { emailAddress, historyId } for bare Pub/Sub
    // For now we also accept an email payload directly.

    const emailPayload = data.email || data;
    const emailTitle = emailPayload.title || emailPayload.subject || '';
    const emailSender = emailPayload.sender || emailPayload.from || '';
    const emailBody =
      emailPayload.body || emailPayload.text || emailPayload.snippet || '';

    if (!emailTitle && !emailSender && !emailBody) {
      console.log('No email content found to process');
      return res.status(400).send('No email content');
    }

    const inputText = [
      `Title: ${emailTitle}`,
      `Sender: ${emailSender}`,
      'Body:',
      emailBody,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await openai.responses.create({
      model: 'gpt-5-nano',
      prompt: { id: process.env.OPENAI_PROMPT_ID },
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: inputText }],
        },
      ],
    });

    const responseText =
      response.output_text ||
      response.output?.[0]?.content
        ?.map((part) => part.text)
        .filter(Boolean)
        .join('') ||
      '';

    console.log('OpenAI response:', responseText);

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

const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const BOOKING_SCHEMA = {
  name: 'booking_extraction',
  strict: true,
  schema: {
    type: 'object',
    required: ['classification', 'confidence', 'booking', 'reasoning'],
    additionalProperties: false,
    properties: {
      classification: {
        type: 'string',
        enum: [
          'new_booking',
          'reschedule',
          'cancellation',
          'inquiry',
          'not_booking',
        ],
      },
      confidence: { type: 'number' },
      booking: {
        type: ['object', 'null'],
        required: [
          'platform',
          'platform_booking_id',
          'guest_name',
          'guest_email',
          'guest_phone',
          'guest_count',
          'booking_date',
          'booking_time',
          'check_out_date',
          'duration_minutes',
          'activity_name',
          'dietary_restrictions',
          'special_requests',
          'original_date',
          'original_time',
          'cancellation_reason',
        ],
        additionalProperties: false,
        properties: {
          platform: {
            type: 'string',
            enum: [
              'airbnb',
              'viator',
              'getyourguide',
              'civitatis',
              'tripadvisor',
              'booking_com',
              'expedia',
              'other',
            ],
          },
          platform_booking_id: { type: ['string', 'null'] },
          guest_name: { type: 'string' },
          guest_email: { type: ['string', 'null'] },
          guest_phone: { type: ['string', 'null'] },
          guest_count: { type: 'integer' },
          booking_date: { type: 'string' },
          booking_time: { type: ['string', 'null'] },
          check_out_date: { type: ['string', 'null'] },
          duration_minutes: { type: ['integer', 'null'] },
          activity_name: { type: ['string', 'null'] },
          dietary_restrictions: { type: 'array', items: { type: 'string' } },
          special_requests: { type: ['string', 'null'] },
          original_date: { type: ['string', 'null'] },
          original_time: { type: ['string', 'null'] },
          cancellation_reason: { type: ['string', 'null'] },
        },
      },
      reasoning: { type: 'string' },
    },
  },
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false },
      })
    : null;

const safeJsonParse = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const toTimestamp = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const parsed = new Date(Number(value));
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};

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
    const emailId =
      emailPayload.id ||
      emailPayload.message_id ||
      emailPayload.messageId ||
      data.messageId ||
      data.email_id ||
      null;
    const emailReceivedAt = toTimestamp(
      emailPayload.received_at ||
        emailPayload.receivedAt ||
        emailPayload.internalDate
    );
    const emailPreview =
      emailPayload.snippet || emailPayload.preview || null;
    const userEmail =
      data.emailAddress ||
      emailPayload.user_email ||
      emailPayload.emailAddress ||
      null;

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
      response_format: { type: 'json_schema', json_schema: BOOKING_SCHEMA },
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

    if (!supabase) {
      console.log('Missing Supabase configuration');
      return res.status(500).send('Supabase not configured');
    }

    if (!userEmail) {
      console.log('No user email found on payload');
      return res.status(400).send('No user email');
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('email', userEmail)
      .maybeSingle();

    if (userError) {
      console.error('Supabase user lookup error:', userError);
      return res.status(500).send('User lookup failed');
    }

    if (!user) {
      console.log(`No user found for ${userEmail}`);
      return res.status(404).send('User not found');
    }

    const extraction =
      response.output?.[0]?.content?.[0]?.parsed ||
      safeJsonParse(responseText);

    if (!extraction || !extraction.booking) {
      console.log('No booking extracted');
      return res.status(200).send('OK');
    }

    if (!emailId) {
      console.log('Missing email id');
      return res.status(400).send('Missing email id');
    }

    const booking = extraction.booking;
    const bookingRow = {
      user_id: user.id,
      platform: booking.platform,
      platform_booking_id: booking.platform_booking_id,
      guest_name: booking.guest_name,
      guest_email: booking.guest_email,
      guest_phone: booking.guest_phone,
      guest_count: booking.guest_count,
      booking_date: booking.booking_date,
      booking_time: booking.booking_time,
      check_out_date: booking.check_out_date,
      duration_minutes: booking.duration_minutes,
      activity_name: booking.activity_name,
      dietary_restrictions: booking.dietary_restrictions,
      special_requests: booking.special_requests,
      email_id: emailId,
      email_subject: emailTitle || null,
      email_preview: emailPreview,
      email_received_at: emailReceivedAt,
      extraction_confidence: extraction.confidence,
      raw_extraction: extraction,
    };

    const { error: bookingError } = await supabase
      .from('bookings')
      .upsert(bookingRow, {
        onConflict: 'user_id,platform,platform_booking_id',
      });

    if (bookingError) {
      console.error('Supabase booking upsert error:', bookingError);
      return res.status(500).send('Booking insert failed');
    }

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

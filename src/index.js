const express = require('express');
const OpenAI = require('openai');
const { google } = require('googleapis');
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
          'processing',
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
              'meitre',
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

const createOAuth2Client = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing Google OAuth configuration');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

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

const decodeBase64Url = (value) => {
  if (!value) return '';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
};

const collectParts = (part, parts = []) => {
  if (!part) return parts;
  parts.push(part);
  if (Array.isArray(part.parts)) {
    part.parts.forEach((child) => collectParts(child, parts));
  }
  return parts;
};

const extractBodyFromPayload = (payload) => {
  if (!payload) return '';
  const parts = collectParts(payload);
  const plainPart = parts.find(
    (part) => part.mimeType === 'text/plain' && part.body?.data
  );
  if (plainPart) {
    return decodeBase64Url(plainPart.body.data);
  }
  const htmlPart = parts.find(
    (part) => part.mimeType === 'text/html' && part.body?.data
  );
  if (htmlPart) {
    const html = decodeBase64Url(htmlPart.body.data);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  return '';
};

const getHeaderValue = (headers, name) => {
  if (!Array.isArray(headers)) return '';
  const match = headers.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase()
  );
  return match?.value || '';
};

const LABEL_PREFIX = 'BookSmart';

const getOrCreateLabelId = async (gmail, labelName) => {
  const {
    data: { labels = [] },
  } = await gmail.users.labels.list({ userId: 'me' });
  const existing = labels.find(
    (l) => l.name && l.name.toLowerCase() === labelName.toLowerCase()
  );
  if (existing) {
    return existing.id;
  }
  const {
    data: { id },
  } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: labelName, type: 'user', labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return id;
};

const addLabelToMessage = async (gmail, messageId, labelName) => {
  const labelId = await getOrCreateLabelId(gmail, labelName);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
};

const getUserByEmail = async (userEmail) => {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  const { data: user, error } = await supabase
    .from('gmail_accounts')
    .select('id, organization_id')
    .eq('email', userEmail)
    .maybeSingle();

  if (error) {
    throw new Error('User lookup failed');
  }

  return user;
};

const runExtraction = async ({ emailTitle, emailSender, emailBody }) => {
  const hasContent = Boolean(emailTitle || emailSender || emailBody);
  if (!hasContent) {
    return { extraction: null, responseText: '' };
  }

  const inputText = [
    `Title: ${emailTitle || ''}`,
    `Sender: ${emailSender || ''}`,
    'Body:',
    emailBody || '',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    prompt: { id: process.env.OPENAI_PROMPT_ID },
    text: {
      format: {
        type: 'json_schema',
        name: BOOKING_SCHEMA.name,
        strict: BOOKING_SCHEMA.strict,
        schema: BOOKING_SCHEMA.schema,
      },
    },
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

  const extraction =
    response.output?.[0]?.content?.[0]?.parsed ||
    safeJsonParse(responseText);

  return { extraction, responseText };
};

const processEmail = async ({
  userEmail,
  emailId,
  emailTitle,
  emailSender,
  emailBody,
  emailPreview,
  emailReceivedAt,
}) => {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }
  if (!userEmail) {
    throw new Error('No user email');
  }
  if (!emailId) {
    throw new Error('Missing email id');
  }

  const user = await getUserByEmail(userEmail);
  if (!user) {
    throw new Error(`User not found for ${userEmail}`);
  }

  const { extraction, responseText } = await runExtraction({
    emailTitle,
    emailSender,
    emailBody,
  });

  if (responseText) {
    console.log('OpenAI response:', responseText);
  } else {
    console.log('OpenAI response: skipped');
  }

  const classification = extraction?.classification || 'not_booking';

  const { error: processedError } = await supabase
    .from('processed_emails')
    .upsert(
      {
        user_id: user.id,
        email_id: emailId,
        classification,
      },
      { onConflict: 'user_id,email_id' }
    );

  if (processedError) {
    console.error('processed_emails upsert error:', processedError);
    throw new Error('Processed email insert failed');
  }

  const bookingClassifications = [
    'new_booking',
    'reschedule',
    'cancellation',
  ];

  if (!bookingClassifications.includes(classification)) {
    console.log('Email classified as non-booking');
    return { classification };
  }

  if (!extraction?.booking) {
    console.log('No booking extracted');
    return { classification };
  }

  const booking = extraction.booking;
  const bookingRow = {
    organization_id: user.organization_id,
    created_by_user_id: user.id,
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
      onConflict: 'organization_id,platform,platform_booking_id',
    });

  if (bookingError) {
    throw new Error('Booking insert failed');
  }

  return { classification };
};

const getGmailClientForEmail = async (emailAddress) => {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }
  const { data: gmailAccount, error: gmailError } = await supabase
    .from('gmail_accounts')
    .select(
      'id', 'google_access_token, google_refresh_token, google_token_expiry'
    )
    .eq('email', emailAddress)
    .maybeSingle();

  if (gmailError || !gmailAccount) {
    return null;
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: gmailAccount.google_access_token,
    refresh_token: gmailAccount.google_refresh_token,
    expiry_date: gmailAccount.google_token_expiry
      ? new Date(gmailAccount.google_token_expiry).getTime()
      : undefined,
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
};

const processGmailNotification = async ({ emailAddress, historyId }) => {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }
  if (!emailAddress || !historyId) {
    throw new Error('Missing Gmail notification fields');
  }

  const { data: gmailAccount, error: gmailError } = await supabase
    .from('gmail_accounts')
    .select(
      'google_access_token, google_refresh_token, google_token_expiry, gmail_history_id'
    )
    .eq('email', emailAddress)
    .maybeSingle();

  if (gmailError) {
    throw new Error('Gmail account lookup failed');
  }

  if (!gmailAccount) {
    throw new Error(`No gmail account for ${emailAddress}`);
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: gmailAccount.google_access_token,
    refresh_token: gmailAccount.google_refresh_token,
    expiry_date: gmailAccount.google_token_expiry
      ? new Date(gmailAccount.google_token_expiry).getTime()
      : undefined,
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  if (!gmailAccount.gmail_history_id) {
    await supabase
      .from('gmail_accounts')
      .update({ gmail_history_id: historyId })
      .eq('email', emailAddress);
    console.log('Stored initial Gmail history id');
    return;
  }

  const messageIds = new Set();
  let pageToken = undefined;

  do {
    const response = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: gmailAccount.gmail_history_id,
      historyTypes: ['messageAdded'],
      pageToken,
    });

    const history = response.data.history || [];
    history.forEach((item) => {
      (item.messagesAdded || []).forEach((entry) => {
        if (entry.message?.id) {
          messageIds.add(entry.message.id);
        }
      });
    });

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  await supabase
    .from('gmail_accounts')
    .update({ gmail_history_id: historyId })
    .eq('email', emailAddress);

  if (!messageIds.size) {
    console.log('No new messages found in history');
    return;
  }

  for (const messageId of messageIds) {
    // Dedup check - insert first, skip if already exists
    const { error: dedupError } = await supabase
      .from('processed_emails')
      .insert({
        user_id: gmailAccount.id,
        email_id: messageId,
        classification: 'processing',
      });
  
    if (dedupError?.code === '23505') {
      console.log(`Skipping already processed: ${messageId}`);
      continue;
    }
  
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const payload = message.data.payload;
    const headers = payload?.headers || [];
    const emailTitle = getHeaderValue(headers, 'Subject');
    const emailSender = getHeaderValue(headers, 'From');
    const emailBody = extractBodyFromPayload(payload);
    const emailPreview = message.data.snippet || null;
    const emailReceivedAt = toTimestamp(message.data.internalDate);
  
    const result = await processEmail({
      userEmail: emailAddress,
      emailId: message.data.id,
      emailTitle,
      emailSender,
      emailBody,
      emailPreview,
      emailReceivedAt,
    });
  
    // Update with actual classification
    await supabase
      .from('processed_emails')
      .update({ classification: result?.classification || 'not_booking' })
      .eq('user_id', gmailAccount.id)
      .eq('email_id', messageId);
  
    if (result?.classification && result.classification !== 'not_booking') {
      try {
        const labelName = `${LABEL_PREFIX}/${result.classification}`;
        await addLabelToMessage(gmail, message.data.id, labelName);
      } catch (labelErr) {
        console.error('Failed to add label to message:', labelErr);
      }
    }
  }
}

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

    const emailPayload =
      data.email ||
      (data.subject || data.title || data.from || data.body || data.snippet
        ? data
        : null);

    if (emailPayload) {
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

      const result = await processEmail({
        userEmail,
        emailId,
        emailTitle,
        emailSender,
        emailBody,
        emailPreview,
        emailReceivedAt,
      });

      if (
        result?.classification &&
        result.classification !== 'not_booking' &&
        userEmail &&
        emailId
      ) {
        try {
          const gmail = await getGmailClientForEmail(userEmail);
          if (gmail) {
            const labelName = `${LABEL_PREFIX}/${result.classification}`;
            await addLabelToMessage(gmail, emailId, labelName);
          }
        } catch (labelErr) {
          console.error('Failed to add label to message:', labelErr);
        }
      }
    } else if (data.emailAddress && data.historyId) {
      await processGmailNotification({
        emailAddress: data.emailAddress,
        historyId: data.historyId,
      });
    } else {
      console.log('No email content found to process');
      return res.status(400).send('No email content');
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

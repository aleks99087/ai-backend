// server/server.js
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { assistantPrompt } from './prompts/assistant.js';

console.log('SUPABASE URL:', process.env.SUPABASE_URL);
console.log('SUPABASE KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 5) + '...');
console.log('OPENAI KEY:', process.env.OPENAI_API_KEY?.slice(0, 5) + '...');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post('/api/chat', async (req, res) => {
  const { user_id, message } = req.body;

  if (!user_id || !message) {
    return res.status(400).json({ error: 'Missing user_id or message' });
  }

  try {
    const { data: history } = await supabase
      .from('chat_history')
      .select('role, message')
      .eq('user_id', user_id)
      .order('created_at', { ascending: true })
      .limit(10);

    const historyFiltered = (history || []).filter(
      (h) =>
        h &&
        h.message !== null &&
        h.role !== null &&
        typeof h.message === 'string' &&
        ['user', 'assistant'].includes(h.role)
    );

    const messages = [
      {
        role: 'system',
        content: assistantPrompt
      },
      ...historyFiltered.map((h) => ({ role: h.role, content: h.message })),
      { role: 'user', content: message },
    ];

    console.log('📤 Отправляем в GPT:', messages);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0.8,
    });

    const rawResponse = completion.choices[0].message.content || 'Ошибка генерации';
    let assistantMessage = rawResponse;
    let suggestions = [];

    try {
      const jsonStart = rawResponse.lastIndexOf('{');
      const jsonPart = rawResponse.slice(jsonStart);
      const parsed = JSON.parse(jsonPart);
      if (parsed.suggestions) suggestions = parsed.suggestions;
      assistantMessage = rawResponse.slice(0, jsonStart).trim();
    } catch (e) {
      console.log('Не удалось выделить подсказки из ответа GPT');
    }

    await supabase.from('chat_history').insert([
      { user_id, role: 'user', message },
      { user_id, role: 'assistant', message: assistantMessage },
    ]);

    res.status(200).json({ reply: assistantMessage, suggestions });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

app.post('/api/create-draft-route', async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    // 1. Получаем 6 топовых достопримечательностей
    const { data: attractions, error: attrError } = await supabase
      .from('attractions')
      .select('*')
      .order('rating', { ascending: false })
      .limit(6);

    if (attrError || !attractions || attractions.length === 0) {
      throw new Error('Не удалось получить достопримечательности');
    }

    // 2. Создаем черновик маршрута
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .insert({
        user_id,
        title: 'Маршрут от AI',
        country: attractions[0].country || 'Не указана',
        photo_url: attractions[0].photos?.[0] || null,
        is_draft: true,
        likes: 0,
        comments: 0
      })
      .select()
      .single();

    if (tripError) {
      throw new Error(`Ошибка при создании маршрута: ${tripError.message}`);
    }

    // 3. Добавляем точки маршрута
    for (let i = 0; i < attractions.length; i++) {
      const attr = attractions[i];

      await supabase
        .from('points')
        .insert({
          trip_id: trip.id,
          name: attr.name,
          latitude: attr.latitude,
          longitude: attr.longitude,
          how_to_get: attr.working_status || '',
          impressions: attr.description || '',
          order: i
        });
    }

    return res.status(200).json({ trip_id: trip.id });
  } catch (error) {
    console.error('Ошибка при генерации маршрута:', error);
    return res.status(500).json({ error: error.message || 'Ошибка сервера' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
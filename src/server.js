// server/server.js
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { assistantPrompt } from './prompts/assistant.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

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

async function generateTripFromParams(user_id, params) {
  const { days = 3, city = 'Сочи', attractions = [] } = params;
  const selected = attractions.length
    ? attractions
    : (await supabase.from('attractions').select('*').eq('city', city).order('rating', { ascending: false }).limit(6)).data || [];

  if (!selected || selected.length === 0) return null;

  const first = selected[0];
  const { data: trip } = await supabase.from('trips').insert({
    user_id,
    title: `Путешествие в ${city}`,
    description: `Маршрут по ${city} на ${days} дней`,
    country: first.country,
    photo_url: first.photos?.[0] || null,
    location: first.city,
    lat: first.latitude,
    lng: first.longitude,
    is_draft: true,
    created_by_ai: true,
    is_public: false,
    budget: 20000,
    start_date: new Date().toISOString().split('T')[0],
    end_date: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    likes: 0,
    comments: 0,
  }).select().single();

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    const { data: point } = await supabase.from('points').insert({
      trip_id: trip.id,
      name: item.name,
      description: item.description,
      latitude: item.latitude,
      longitude: item.longitude,
      how_to_get: item.working_status || '',
      impressions: item.description,
      order: i
    }).select().single();

    const photos = item.photos || [];
    for (const url of photos) {
      await supabase.from('point_images').insert({ point_id: point.id, url });
    }
  }

  return {
    id: trip.id,
    url: `https://injoy-ten.vercel.app/trips/${trip.id}`
  };  
}

app.post('/api/chat', async (req, res) => {
  const { user_id, message } = req.body;

  if (!user_id || !message) {
    return res.status(400).json({ error: 'Missing user_id or message' });
  }

  await supabase.from('chat_history').insert([{ user_id, role: 'user', message }]);

  try {
    const { data: history } = await supabase
      .from('chat_history')
      .select('role, message')
      .eq('user_id', user_id)
      .order('created_at', { ascending: true });

    const historyFiltered = (history || [])
      .filter(
        (h) =>
          h &&
          h.message !== null &&
          h.role !== null &&
          typeof h.message === 'string' &&
          ['user', 'assistant'].includes(h.role)
      )
      .slice(-10);

    const messages = [
      { role: 'system', content: assistantPrompt },
      ...historyFiltered.map((h) => ({ role: h.role, content: h.message })),
    ];

    console.log('📤 Отправляем в GPT:', messages);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0.8,
    });

    console.log('🧠 Ответ GPT:', completion.choices[0].message);

    const rawResponse = completion.choices[0].message.content || 'Ошибка генерации';
    console.log('📦 RAW GPT response:', rawResponse);

    let assistantMessage = rawResponse;
    let suggestions = [];
    let parsed = null;

    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}$/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
        if (parsed.suggestions) suggestions = parsed.suggestions;

        if (parsed.action === 'create_trip') {
          const trip = await generateTripFromParams(user_id, parsed.params || {});
          assistantMessage = `Готово! Вот ваш маршрут: ${trip.url}`;
          suggestions = ["+ Измени маршрут", "+ Добавь отели", "+ Подскажи достопримечательности"];
          res.status(200).json({ reply: assistantMessage, suggestions, tripId: trip.id });
          return; // <— чтобы не падали ниже
        } else {
          assistantMessage = rawResponse.replace(jsonMatch[0], '').trim();
        }        
      } else {
        console.warn('❌ JSON не найден в ответе GPT');
        assistantMessage = rawResponse.trim();
      }
    } catch (e) {
      console.log('❌ Не удалось распарсить JSON из ответа GPT');
      console.log('📦 RAW GPT response:', rawResponse);
      assistantMessage = rawResponse.trim();
    }

    await supabase.from('chat_history').insert({
      user_id,
      role: 'assistant',
      message: assistantMessage,
      raw_gpt_response: completion.choices[0].message,
      message_type: parsed?.action ? 'action' : 'text'
    });

    res.status(200).json({ reply: assistantMessage, suggestions });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

app.get('/api/chat-history', async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    const { data, error } = await supabase
      .from('chat_history')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.status(200).json({ messages: data });
  } catch (err) {
    console.error('Ошибка при получении истории чата:', err);
    res.status(500).json({ error: 'Ошибка при получении истории чата' });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

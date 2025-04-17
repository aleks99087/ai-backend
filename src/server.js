// server/server.js
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
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

function buildAssistantPrompt(city, days, attractionsList) {
  return `
Ты — AI-ассистент по путешествиям. Пользователь планирует поездку в город "${city}" на ${days} дней.

Ниже список реальных достопримечательностей, доступных в базе данных:

${attractionsList}

Твоя задача:

1. Уточни у пользователя цель поездки:
- Он путешествует один, с друзьями, с детьми?
- Ему важно отдохнуть, активно провести время или всё понемногу?
- Есть ли предпочтения: природа, музеи, кафе, пляжи, парки?

2. После уточнения предложи 4–6 мест из списка выше, подходящих под его стиль.

3. Дождись выбора пользователя (может выбрать всё, часть, или отказаться).

4. Только после согласования — предложи: "Хочешь, я соберу маршрут?"

5. Если пользователь ответит "да", верни JSON в формате:
{
  "action": "create_trip",
  "params": {
    "city": "${city}",
    "days": ${days},
    "attractions": [
      { "name": "Олимпийский парк" },
      { "name": "Дендрарий" }
    ]
  },
  "suggestions": ["+ Добавь пляжи", "+ Найди кафе", "+ Покажи карту маршрута"]
}

⚠️ Никогда не придумывай новые достопримечательности. Используй только список выше.
⚠️ Никогда не добавляй ссылку — её сформирует backend.
  `;
}

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

    const lastUserMessage = historyFiltered.reverse().find(h => h.role === 'user')?.message || '';
    const match = lastUserMessage.match(/(\d+).*дн|дня|дней.*в\s+([а-яА-Яa-zA-Z-]+)/i);

    const city = match?.[2] || 'Сочи';
    const days = parseInt(match?.[1]) || 3;

    const { data: attractions } = await supabase
      .from('attractions')
      .select('name, description')
      .eq('city', city)
      .order('rating', { ascending: false })
      .limit(10);

    const attractionsList = attractions
      ?.map((a, i) => `${i + 1}. ${a.name} — ${a.description || 'без описания'}`)
      .join('\n') || 'Пока нет данных';

    const messages = [
      { role: 'system', content: buildAssistantPrompt(city, days, attractionsList) },
      ...historyFiltered.map((h) => ({ role: h.role, content: h.message })),
    ];

    console.log('📤 Отправляем в GPT:', messages);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      temperature: 0.8,
    });

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
          return;
        } else {
          assistantMessage = rawResponse.replace(jsonMatch[0], '').trim();
        }
      } else {
        console.warn('❌ JSON не найден в ответе GPT');
        assistantMessage = rawResponse.trim();
      }
    } catch (e) {
      console.log('❌ Не удалось распарсить JSON из ответа GPT');
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
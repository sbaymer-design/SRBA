// api/get-plan.js
// Vercel Serverless Function — la web consulta esto para saber el plan real del usuario

const SUPABASE_URL = 'https://gybbnsglqvinwawqplmr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  // CORS para srba-ten.vercel.app
  res.setHeader('Access-Control-Allow-Origin', 'https://srba-ten.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    const encodedEmail = encodeURIComponent(email);
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodedEmail}&select=plan,status,current_period_end&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!data || data.length === 0) {
      return res.status(200).json({ plan: 'free', status: 'none' });
    }

    const sub = data[0];

    // Verificar que la suscripción no ha expirado
    if (sub.current_period_end) {
      const expiry = new Date(sub.current_period_end);
      if (expiry < new Date()) {
        return res.status(200).json({ plan: 'free', status: 'expired' });
      }
    }

    // Solo devolver plan si está activo
    if (sub.status === 'active') {
      return res.status(200).json({ plan: sub.plan, status: sub.status });
    } else {
      return res.status(200).json({ plan: 'free', status: sub.status });
    }

  } catch (err) {
    console.error('Error consultando Supabase:', err);
    return res.status(500).json({ error: 'Error interno', plan: 'free' });
  }
}
